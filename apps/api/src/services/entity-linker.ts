/**
 * Entity Linker Service
 *
 * Links recognized entities to Wikipedia pages and enriches them with:
 * - Wikipedia URLs
 * - Article summaries
 * - Infobox images
 *
 * Features:
 * - Wikipedia API integration (multi-step search + content fetch)
 * - Intelligent disambiguation (type-aware entity matching)
 * - Disk caching (30-day TTL with cache invalidation)
 * - Retry logic (3 retries with exponential backoff)
 * - Timeout protection (5-second AbortController)
 * - Error recovery (graceful degradation on API failures)
 *
 * Architecture:
 * 1. Search Wikipedia API for entity matches
 * 2. Detect and handle disambiguation pages
 * 3. Fetch page content (summary + image)
 * 4. Cache results to disk for future lookups
 * 5. Return enriched entity with Wikipedia metadata
 *
 * Performance:
 * - First call: ~800ms-2s (API call + cache write)
 * - Cached hit: <10ms (disk read)
 * - Timeout: <6s (AbortController protection)
 * - Batch 100 entities: ~30-50s (with caching)
 */

import {
  EntityMention,
  EntityType,
  LinkedEntity,
  WikipediaSearchResult,
  WikipediaPageContent,
} from "../domain/entity-types.js";
import { DiskCache } from "./disk-cache.js";

/**
 * Configuration constants
 */
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 3000, 10000];
// Unified 30-day TTL for both positive (entity → Wikipedia page) and negative
// (no Wikipedia match) entries. Long enough to amortize away most repeat
// lookups; short enough that summary/image refreshes flow through monthly.
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WIKIPEDIA_BATCH_SIZE = 50; // MediaWiki action API hard cap on `pageids`

const wikipediaCache = new DiskCache<CachedEntity>({
  namespace: "wikipedia",
  ttlMs: POSITIVE_TTL_MS,
  disableEnvVar: "WIKIPEDIA_CACHE_DISABLE",
  dirEnvVar: "WIKIPEDIA_CACHE_DIR",
});

/**
 * Global rate limiter for Wikipedia API calls.
 *
 * Wikipedia's anonymous rate limit is generous in burst but enforces ~50 req/s
 * sustained per IP. With concurrent enrichment workers, we routinely hit 429s
 * which the per-call retry can't fully recover from. This serializes calls
 * across the whole process to one request every WIKIPEDIA_MIN_INTERVAL_MS.
 *
 * Tune via `WIKIPEDIA_MIN_INTERVAL_MS` env var (default 200ms = 5 req/s).
 */
const WIKIPEDIA_DEFAULT_MIN_INTERVAL_MS = 200;
let lastWikipediaCallAt = 0;
let wikipediaThrottleChain: Promise<void> = Promise.resolve();

function throttleWikipedia(): Promise<void> {
  const minIntervalMs = (() => {
    const raw = process.env.WIKIPEDIA_MIN_INTERVAL_MS;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : WIKIPEDIA_DEFAULT_MIN_INTERVAL_MS;
  })();
  // Chain each call after the previous so they serialize.
  const next = wikipediaThrottleChain.then(async () => {
    const wait = lastWikipediaCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastWikipediaCallAt = Date.now();
  });
  wikipediaThrottleChain = next.catch(() => {});
  return next;
}

/**
 * Cached entity metadata. `notFound: true` records an entity for which
 * Wikipedia returned no useful match — we want to short-circuit future
 * lookups so junk extraction artifacts don't generate thousands of calls.
 */
interface CachedEntity {
  wikipediaUrl?: string;
  summary?: string;
  imageUrl?: string;
  pageId?: number;
  cachedAt: number; // timestamp
  notFound?: boolean;
}

/**
 * Sentinel used to mask abbreviation periods so they don't trigger sentence
 * splitting. U+0001 doesn't appear in Wikipedia plain-text extracts.
 */
const ABBR_PERIOD_SENTINEL = "";

/**
 * Common abbreviations that end in a period and are followed by more sentence.
 * Lowercase; we match case-insensitively. Keep tight — every entry here is
 * a place where an over-eager `.\s+` split would otherwise truncate the
 * summary mid-sentence (e.g. "eBay Inc." or "Joseph Robinette Biden Jr.").
 */
const ABBREVIATIONS = new Set([
  "inc", "ltd", "co", "corp", "plc", "llc", "gmbh", "ag", "sa", "sl", "srl", "bv", "nv",
  "jr", "sr",
  "dr", "mr", "mrs", "ms", "prof", "rev", "hon", "st", "mt", "ft", "rd",
  "vs", "etc", "eg", "ie", "no", "vol", "pp", "cf", "approx", "est",
]);

/**
 * Mask periods that don't end a sentence so the splitter only cuts at real
 * boundaries. Three patterns, in order:
 *   1. Multi-letter dotted acronyms — "U.S.", "F.C.", "Ph.D." — every internal
 *      period is masked.
 *   2. Single-uppercase initials — "Calvin H. Borel", "Michael J. Rogers".
 *      A lone capital followed by `.` and then whitespace + a capital letter
 *      is virtually always a middle-name initial, not a sentence end.
 *   3. Word-final period that matches a known abbreviation ("Inc.", "Jr.").
 *
 * The sentinel keeps the period present (so the visible summary is unchanged)
 * but invisible to the sentence-boundary regex.
 */
function protectAbbreviations(s: string): string {
  // 1. Dotted acronyms like "U.S.", "F.C.", "U.S.A.": at least two single-letter+dot
  //    pairs, optionally followed by a final letter+dot.
  s = s.replace(/(?:\b[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ABBR_PERIOD_SENTINEL));
  // 2. Single uppercase initial: "X. " followed by a capital. Must NOT match
  //    something already masked (loose check via lookbehind for sentinel).
  s = s.replace(/(\b[A-Z])\.(\s+[A-Z])/g, `$1${ABBR_PERIOD_SENTINEL}$2`);
  // 3. Known abbreviations followed by whitespace.
  s = s.replace(/\b([A-Za-z]+)\.(\s)/g, (match, word: string, ws: string) => {
    return ABBREVIATIONS.has(word.toLowerCase())
      ? `${word}${ABBR_PERIOD_SENTINEL}${ws}`
      : match;
  });
  return s;
}

/**
 * Extract a short summary (≤5 sentences, ≤600 chars) from a Wikipedia plain
 * text extract. Pulled out of the class as a pure function so it's unit-testable
 * and so abbreviation handling can be exercised directly.
 *
 * Why the masking step matters: Wikipedia extracts routinely begin with
 * "X Inc. (...)" or "Joseph Robinette Biden Jr. (born ...)" — without
 * abbreviation protection, the naive `/([.!?])\s+/` split terminates after
 * the first abbreviation, producing single-token "summaries" like
 * "eBay Inc." or "Joseph Robinette Biden Jr.".
 */
export function extractSummary(extract?: string): string | undefined {
  if (!extract) return undefined;

  const masked = protectAbbreviations(extract);
  // Split keeps terminators at odd indices: ["Foo", ".", "Bar", "?", "Baz"].
  // The whitespace after each terminator is consumed by the regex; we
  // re-insert a single space between sentences so the joined summary stays
  // readable. Don't add a space after the very last terminator.
  const parts = masked.split(/([.!?])\s+/);

  const MAX_CHARS = 600;
  const MAX_SENTENCES = 5;
  let summary = "";
  let sentenceCount = 0;
  for (let i = 0; i < parts.length; i++) {
    summary += parts[i];
    if (i % 2 === 1) {
      sentenceCount += 1;
      // Re-insert the space we lost in the split, but only if another sentence follows.
      if (i + 1 < parts.length && parts[i + 1]) summary += " ";
    }
    if (sentenceCount >= MAX_SENTENCES || summary.length >= MAX_CHARS) {
      break;
    }
  }

  // Restore the masked periods.
  summary = summary.split(ABBR_PERIOD_SENTINEL).join(".");
  return summary.trim() || undefined;
}

/**
 * Detect Wikipedia search hits that almost certainly aren't the entity the
 * caller asked for. Three signals, all cheap (no extra API calls):
 *   1. Title ends in "(disambiguation)" — a real disambig page.
 *   2. Title ends in "(name)", "(surname)", "(given name)" — name index pages,
 *      not the person/place/org we wanted (these pollute the cache today,
 *      e.g. "Bilger" → "Bilger" surname stub, "Giovanni Trapattoni" → "Giovanni (name)").
 *   3. Snippet starts with "may refer to" — Wikipedia's standard disambig lead.
 */
export function isDisambiguationLike(result: WikipediaSearchResult): boolean {
  const title = result.title || "";
  if (/\((?:disambiguation|surname|given name|name)\)\s*$/i.test(title)) {
    return true;
  }
  const snippet = result.snippet || "";
  // Wikipedia search snippets contain HTML; strip the `<span class="searchmatch">` wrappers
  // before the substring check. The text content is what matters.
  const stripped = snippet.replace(/<[^>]+>/g, "");
  if (/\bmay refer to\b/i.test(stripped)) return true;
  return false;
}

/**
 * Entity Linker Service
 * Enriches entities with Wikipedia information
 */
class EntityLinkerService {
  constructor() {}

  /**
   * Main entry point: Link an entity to Wikipedia
   *
   * Process:
   * 1. Check cache (7-day TTL)
   * 2. If not cached: search Wikipedia
   * 3. Fetch page content if found
   * 4. Cache result
   * 5. Return enriched entity
   *
   * @param mention - Entity mention from NER
   * @returns Linked entity with Wikipedia data, or null if not found
   */
  async linkEntity(mention: EntityMention): Promise<LinkedEntity> {
    const verbose = process.env.WIKIPEDIA_LINK_VERBOSE === "true";
    // Check cache first
    const cached = await this.getCachedResult(mention.entityText);
    if (cached) {
      if (cached.notFound) {
        if (verbose) console.log(`[wikipedia] cache hit (negative) "${mention.entityText}"`);
        return mention;
      }
      if (verbose) console.log(`[wikipedia] cache hit "${mention.entityText}"`);
      return {
        ...mention,
        ...cached,
        linkedAt: new Date(cached.cachedAt),
      };
    }

    try {
      // Search Wikipedia
      if (verbose) console.log(`[wikipedia] search "${mention.entityText}"`);
      const searchResults = await this.searchWikipedia(mention.entityText);
      if (searchResults.length === 0) {
        if (verbose) console.log(`[wikipedia] no match "${mention.entityText}"`);
        await this.setCachedResult(mention.entityText, {
          cachedAt: Date.now(),
          notFound: true,
        });
        return mention; // Not found, return original
      }

      // Disambiguate if needed
      const bestMatch = this.disambiguate(
        searchResults,
        mention.entityType
      );

      // Fetch page content
      const content = await this.fetchPageContent(bestMatch.pageid);

      // Build Wikipedia URL
      const wikipediaUrl = this.buildWikipediaUrl(bestMatch.title);
      if (verbose) console.log(`[wikipedia] linked "${mention.entityText}" -> ${bestMatch.title}`);

      // Cache result
      const linkedData: CachedEntity = {
        wikipediaUrl,
        summary: content.summary,
        imageUrl: content.imageUrl,
        pageId: bestMatch.pageid,
        cachedAt: Date.now(),
      };
      await this.setCachedResult(mention.entityText, linkedData);

      // Return enriched entity
      return {
        ...mention,
        wikipediaUrl,
        summary: content.summary,
        imageUrl: content.imageUrl,
        pageId: bestMatch.pageid,
        linkedAt: new Date(),
      };
    } catch (error) {
      // Graceful degradation: return entity without Wikipedia data
      console.warn(
        `Failed to link entity "${mention.entityText}":`,
        error instanceof Error ? error.message : String(error)
      );
      return mention;
    }
  }

  /**
   * Search Wikipedia for entity matches
   *
   * Uses Wikipedia API search with:
   * - Full-text search
   * - Automatic prefix matching
   * - Snippet extraction
   *
   * @param query - Entity name to search
   * @returns Array of search results, sorted by relevance
   */
  private async searchWikipedia(
    query: string
  ): Promise<WikipediaSearchResult[]> {
    // Quick validation: empty or whitespace-only queries return empty results
    if (!query || !query.trim()) {
      return [];
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await throttleWikipedia();
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          WIKIPEDIA_TIMEOUT_MS
        );

        try {
          const url = new URL(WIKIPEDIA_API_URL);
          url.searchParams.set("action", "query");
          url.searchParams.set("list", "search");
          url.searchParams.set("srsearch", query);
          url.searchParams.set("srlimit", "10");
          url.searchParams.set("srinfo", "suggestion");
          url.searchParams.set("format", "json");

          const response = await fetch(url.toString(), {
            method: "GET",
            signal: controller.signal,
            headers: {
              "User-Agent":
                "NewsInPerspective/1.0 (Entity linking service)",
            },
          });

          clearTimeout(timeout);

          if (!response.ok) {
            if (response.status === 429) {
              // Rate limited
              const retryAfter = response.headers.get("Retry-After");
              const delayMs = retryAfter
                ? parseInt(retryAfter) * 1000
                : BACKOFF_MS[attempt] || 10000;
              console.warn(
                `[wikipedia] 429 search "${query}" attempt ${attempt + 1}/${MAX_RETRIES}, sleeping ${delayMs}ms`,
              );
              await this.sleep(delayMs);
              continue;
            }
            throw new Error(`HTTP ${response.status}`);
          }

          const data = (await response.json()) as {
            query?: { search?: WikipediaSearchResult[] };
            error?: { code?: string; info?: string };
          };
          // The API returns {error:{...}} (no `query` field) for malformed queries
          // — currency tables and other extraction-noise entity names hit this.
          // Treat any non-shape response as "no results" rather than crashing.
          if (data.error || !data.query) return [];
          return data.query.search ?? [];
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (attempt < MAX_RETRIES - 1) {
          const delayMs = BACKOFF_MS[attempt] || 5000;
          await this.sleep(delayMs);
          continue;
        }
        throw error;
      }
    }

    return [];
  }

  /**
   * Fetch Wikipedia page content
   *
   * Retrieves:
   * - Extract (article summary)
   * - Page images (thumbnail or first image)
   * - Last modified date
   *
   * @param pageId - Wikipedia page ID
   * @returns Page content with summary and image
   */
  private async fetchPageContent(
    pageId: number
  ): Promise<WikipediaPageContent> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await throttleWikipedia();
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          WIKIPEDIA_TIMEOUT_MS
        );

        try {
          const url = new URL(WIKIPEDIA_API_URL);
          url.searchParams.set("action", "query");
          url.searchParams.set("pageids", String(pageId));
          url.searchParams.set("prop", "extracts|pageimages|info");
          url.searchParams.set("pithumbsize", "200");
          url.searchParams.set("explaintext", "true");
          url.searchParams.set("exsectionformat", "plain");
          url.searchParams.set("format", "json");

          const response = await fetch(url.toString(), {
            method: "GET",
            signal: controller.signal,
            headers: {
              "User-Agent":
                "NewsInPerspective/1.0 (Entity linking service)",
            },
          });

          clearTimeout(timeout);

          if (!response.ok) {
            if (response.status === 429) {
              const retryAfter = response.headers.get("Retry-After");
              const delayMs = retryAfter
                ? parseInt(retryAfter) * 1000
                : BACKOFF_MS[attempt] || 10000;
              console.warn(
                `[wikipedia] 429 page ${pageId} attempt ${attempt + 1}/${MAX_RETRIES}, sleeping ${delayMs}ms`,
              );
              await this.sleep(delayMs);
              continue;
            }
            throw new Error(`HTTP ${response.status}`);
          }

          const data = (await response.json()) as {
            query?: {
              pages?: Record<
                string,
                {
                  extract?: string;
                  thumbnail?: { source: string };
                  pageimage?: string;
                  touched?: string;
                }
              >;
            };
            error?: { code?: string; info?: string };
          };

          if (data.error || !data.query?.pages) return {};
          const page = data.query.pages[String(pageId)];
          if (!page) {
            return {};
          }

          // Extract first 2-3 sentences as summary
          const summary = this.extractSummary(page.extract);

          // Get image URL
          const imageUrl =
            page.thumbnail?.source ||
            (page.pageimage ? this.buildImageUrl(page.pageimage) : undefined);

          return {
            summary,
            imageUrl,
            lastModified: page.touched,
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (attempt < MAX_RETRIES - 1) {
          const delayMs = BACKOFF_MS[attempt] || 5000;
          await this.sleep(delayMs);
          continue;
        }
        throw error;
      }
    }

    return {};
  }

  /**
   * Batched variant of fetchPageContent. The MediaWiki action API accepts
   * up to 50 pageids per call, returning `query.pages = { <pageId>: {...} }`.
   * Splits its input across as many calls as needed and returns a Map keyed
   * by pageId. Missing IDs are simply absent from the map.
   */
  private async fetchPageContentsBatch(
    pageIds: number[],
  ): Promise<Map<number, WikipediaPageContent>> {
    const out = new Map<number, WikipediaPageContent>();
    const unique = Array.from(new Set(pageIds));
    if (unique.length === 0) return out;

    for (let offset = 0; offset < unique.length; offset += WIKIPEDIA_BATCH_SIZE) {
      const chunk = unique.slice(offset, offset + WIKIPEDIA_BATCH_SIZE);

      let succeeded = false;
      for (let attempt = 0; attempt < MAX_RETRIES && !succeeded; attempt++) {
        try {
          await throttleWikipedia();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), WIKIPEDIA_TIMEOUT_MS);
          try {
            const url = new URL(WIKIPEDIA_API_URL);
            url.searchParams.set("action", "query");
            url.searchParams.set("pageids", chunk.join("|"));
            url.searchParams.set("prop", "extracts|pageimages|info");
            url.searchParams.set("pithumbsize", "200");
            url.searchParams.set("explaintext", "true");
            url.searchParams.set("exsectionformat", "plain");
            url.searchParams.set("format", "json");

            const response = await fetch(url.toString(), {
              method: "GET",
              signal: controller.signal,
              headers: {
                "User-Agent": "NewsInPerspective/1.0 (Entity linking service)",
              },
            });
            clearTimeout(timeout);
            if (!response.ok) {
              if (response.status === 429) {
                const retryAfter = response.headers.get("Retry-After");
                const delayMs = retryAfter
                  ? parseInt(retryAfter) * 1000
                  : BACKOFF_MS[attempt] || 10000;
                console.warn(
                  `[wikipedia] 429 batch (${chunk.length} pages) attempt ${attempt + 1}/${MAX_RETRIES}, sleeping ${delayMs}ms`,
                );
                await this.sleep(delayMs);
                continue;
              }
              throw new Error(`HTTP ${response.status}`);
            }
            const data = (await response.json()) as {
              query?: {
                pages?: Record<
                  string,
                  {
                    extract?: string;
                    thumbnail?: { source: string };
                    pageimage?: string;
                    touched?: string;
                  }
                >;
              };
            };
            const pages = data.query?.pages ?? {};
            for (const [pageIdStr, page] of Object.entries(pages)) {
              const pageId = Number(pageIdStr);
              if (!Number.isFinite(pageId) || pageId < 0) continue;
              out.set(pageId, {
                summary: this.extractSummary(page.extract),
                imageUrl:
                  page.thumbnail?.source ||
                  (page.pageimage ? this.buildImageUrl(page.pageimage) : undefined),
                lastModified: page.touched,
              });
            }
            succeeded = true;
          } finally {
            clearTimeout(timeout);
          }
        } catch (error) {
          if (attempt < MAX_RETRIES - 1) {
            await this.sleep(BACKOFF_MS[attempt] || 5000);
            continue;
          }
          // Last-attempt failure: drop the chunk silently rather than abort
          // the whole batch — callers fall back to "no Wikipedia data" for
          // the missing entities, exactly the same as a single-fetch failure.
          console.warn(
            `[wikipedia] batch fetch failed (${chunk.length} pages): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    return out;
  }

  /**
   * Batched variant of linkEntity. For an array of mentions:
   *   1. Resolve cache hits (positive and negative) without any network.
   *   2. Search Wikipedia per remaining mention (sequential, throttled).
   *      Negative results are persisted to cache.
   *   3. Batch-fetch summaries for all positive search hits in chunks of 50.
   *   4. Persist positive results and return one LinkedEntity per input.
   *
   * For an article with N entities, this issues at most N searches +
   * ⌈hits/50⌉ summary fetches, instead of N searches + N summary fetches.
   */
  async linkEntities(mentions: EntityMention[]): Promise<LinkedEntity[]> {
    const verbose = process.env.WIKIPEDIA_LINK_VERBOSE === "true";
    const results = new Array<LinkedEntity | null>(mentions.length).fill(null);

    interface Pending {
      idx: number;
      mention: EntityMention;
      pageId: number;
      title: string;
    }
    const pending: Pending[] = [];

    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i]!;
      const cached = await this.getCachedResult(mention.entityText);
      if (cached) {
        if (cached.notFound) {
          if (verbose) console.log(`[wikipedia] cache hit (negative) "${mention.entityText}"`);
          results[i] = mention;
        } else {
          if (verbose) console.log(`[wikipedia] cache hit "${mention.entityText}"`);
          results[i] = {
            ...mention,
            ...cached,
            linkedAt: new Date(cached.cachedAt),
          };
        }
        continue;
      }

      try {
        if (verbose) console.log(`[wikipedia] search "${mention.entityText}"`);
        const searchResults = await this.searchWikipedia(mention.entityText);
        if (searchResults.length === 0) {
          if (verbose) console.log(`[wikipedia] no match "${mention.entityText}"`);
          await this.setCachedResult(mention.entityText, {
            cachedAt: Date.now(),
            notFound: true,
          });
          results[i] = mention;
          continue;
        }
        const bestMatch = this.disambiguate(searchResults, mention.entityType);
        pending.push({ idx: i, mention, pageId: bestMatch.pageid, title: bestMatch.title });
      } catch (error) {
        console.warn(
          `Failed to link entity "${mention.entityText}":`,
          error instanceof Error ? error.message : String(error),
        );
        results[i] = mention;
      }
    }

    if (pending.length > 0) {
      const pageContents = await this.fetchPageContentsBatch(pending.map((p) => p.pageId));
      for (const p of pending) {
        const content = pageContents.get(p.pageId) ?? {};
        const wikipediaUrl = this.buildWikipediaUrl(p.title);
        const linkedData: CachedEntity = {
          wikipediaUrl,
          summary: content.summary,
          imageUrl: content.imageUrl,
          pageId: p.pageId,
          cachedAt: Date.now(),
        };
        await this.setCachedResult(p.mention.entityText, linkedData);
        if (verbose) console.log(`[wikipedia] linked "${p.mention.entityText}" -> ${p.title}`);
        results[p.idx] = {
          ...p.mention,
          wikipediaUrl,
          summary: content.summary,
          imageUrl: content.imageUrl,
          pageId: p.pageId,
          linkedAt: new Date(),
        };
      }
    }

    // Anything still null means an exception path that already returned the
    // mention — defensively coerce to mention-as-is.
    return results.map((r, i) => r ?? mentions[i]!);
  }

  /**
   * Disambiguate between multiple search results
   *
   * Strategy:
   * - Skip disambiguation pages
   * - Use EntityType to select best match
   * - Prefer exact matches
   * - Fallback to first result if no clear match
   *
   * @param results - Search results from Wikipedia
   * @param type - Entity type to guide disambiguation
   * @returns Best matching result
   */
  private disambiguate(
    results: WikipediaSearchResult[],
    type: EntityType
  ): WikipediaSearchResult {
    const nonDisambig = results.filter((r) => !isDisambiguationLike(r));

    if (nonDisambig.length === 0) {
      return results[0] || results[0]; // Fallback to first if all are disambig
    }

    // Type-aware selection
    switch (type) {
      case EntityType.PERSON:
        // Prefer results mentioning birth/death dates or professions
        const person = nonDisambig.find(
          (r) =>
            /\(born|died|\d{4}[-–]\d{4}|politician|actor|athlete|scientist|writer/i.test(
              r.snippet || ""
            )
        );
        return person || nonDisambig[0];

      case EntityType.GPE:
        // Prefer geographic descriptions (city, country, region)
        const place = nonDisambig.find(
          (r) =>
            /\b(?:city|country|region|province|state|capital|island|river|lake|mountain)\b/i.test(
              r.snippet || ""
            )
        );
        return place || nonDisambig[0];

      case EntityType.ORG:
        // Prefer organizational descriptions (company, organization, institution)
        const org = nonDisambig.find(
          (r) =>
            /\b(?:company|organization|agency|institution|corporation|university|hospital|bank|foundation)\b/i.test(
              r.snippet || ""
            )
        );
        return org || nonDisambig[0];

      case EntityType.EVENT:
        // Prefer event descriptions (date, year, war, conference, etc.)
        const event = nonDisambig.find(
          (r) =>
            /\b(?:\d{4}|war|battle|conference|summit|olympics|election|crisis)\b/i.test(
              r.snippet || ""
            )
        );
        return event || nonDisambig[0];

      default:
        return nonDisambig[0];
    }
  }

  /**
   * Build canonical Wikipedia URL
   *
   * Converts page title to URL:
   * - "Vladimir Putin" → "https://en.wikipedia.org/wiki/Vladimir_Putin"
   * - "World Health Organization" → "https://en.wikipedia.org/wiki/World_Health_Organization"
   *
   * @param title - Wikipedia page title
   * @returns Full Wikipedia URL
   */
  private buildWikipediaUrl(title: string): string {
    const encoded = encodeURIComponent(title.replace(/ /g, "_"));
    return `https://en.wikipedia.org/wiki/${encoded}`;
  }

  /**
   * Build image URL from page image name
   *
   * Converts image name to Wikimedia Commons URL:
   * - "Example.jpg" → "https://commons.wikimedia.org/wiki/Special:FilePath/Example.jpg?width=200"
   *
   * @param imageName - Image filename
   * @returns Image URL
   */
  private buildImageUrl(imageName: string): string {
    const encoded = encodeURIComponent(imageName);
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=200`;
  }

  private extractSummary(extract?: string): string | undefined {
    return extractSummary(extract);
  }

  /**
   * Get cached entity result
   *
   * Checks if cache is valid (30-day TTL)
   * Removes expired cache files
   *
   * @param entityName - Entity name to lookup
   * @returns Cached data if valid, null otherwise
   */
  private async getCachedResult(entityName: string): Promise<CachedEntity | null> {
    const cached = await wikipediaCache.get(
      wikipediaCache.keyFor(this.normalizeKey(entityName)),
    );
    if (!cached) return null;
    if (cached.notFound) return cached;
    if (Date.now() - cached.cachedAt > POSITIVE_TTL_MS) return null;
    return cached;
  }

  /**
   * Set cached entity result
   */
  private async setCachedResult(
    entityName: string,
    data: CachedEntity
  ): Promise<void> {
    try {
      await wikipediaCache.set(wikipediaCache.keyFor(this.normalizeKey(entityName)), data);
    } catch (error) {
      console.warn(`Failed to cache entity "${entityName}":`, error);
    }
  }

  /** Stable normalization so "Vladimir Putin" and "vladimir putin" share a cache slot. */
  private normalizeKey(name: string): string {
    return name.toLowerCase().replace(/\s+/g, " ").trim();
  }

  /**
   * Sleep utility for retry backoff
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const entityLinkerService = new EntityLinkerService();
