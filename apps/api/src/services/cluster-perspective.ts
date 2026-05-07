import { createHash } from "node:crypto";
import { ExtractionStatus, Prisma, ScopeType } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveCountryFromDomain } from "./country-from-domain.js";
import { applyCalibration, getCalibration } from "./perspective-calibration.js";
import { generateClusterNarrative } from "./cluster-perspective-narrative.js";

/**
 * Cache-invalidation hash for stored SBERT embeddings.
 *
 * Without this the embedding cache was keyed only by `(articleId, model)`,
 * which meant any embedding computed before stage 2 finished — e.g. when
 * the UI lazy-triggered `/api/clusters/:id/perspective` while only raw
 * `fullText` was populated — would persist forever and short-circuit the
 * sidecar even after enrichment overwrote `framingSummary` and
 * `translatedFullText`. The matrix would then reflect the pre-enrichment
 * vectors no matter how many `--force` recomputations stage 4 ran.
 *
 * Storing a hash of the exact text we sent to the sidecar lets the cache
 * detect text changes and treat the entry as a miss when the upstream
 * fields evolve.
 *
 * 16-hex-char SHA-256 prefix is collision-safe for a single article corpus
 * and keeps the JSON payload light.
 */
function hashEmbeddingInput(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Stable signature over the set of (articleId, embedded-text) pairs that
 * went into a cluster perspective. Stored on the perspective row, then
 * re-computed on every read. A mismatch means at least one article's text
 * has been re-enriched (or an article has been added / removed from the
 * cluster) since the perspective was persisted, so the stored matrix is
 * stale and `getStoredClusterPerspective` should treat it as a cache miss.
 *
 * Sort by article_id so the signature is order-independent — Prisma's
 * default ordering can change between calls.
 */
function buildClusterInputSignature(
  pairs: Array<{ article_id: string; textHash: string }>,
): string {
  const sorted = [...pairs].sort((a, b) => a.article_id.localeCompare(b.article_id));
  const joined = sorted.map((p) => `${p.article_id}:${p.textHash}`).join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

/**
 * Recompute the input signature from the current state of the cluster's
 * articles in the database. Used by `getStoredClusterPerspective` to
 * compare against the signature stored at perspective-write time.
 *
 * Mirrors `pickArticleText` and the candidate-filter logic in `runCompute`
 * so the same articles contribute to the signature whether we're reading
 * cached or about to compute fresh.
 */
async function computeCurrentClusterInputSignature(clusterId: string): Promise<string | null> {
  const cluster = await prisma.storyCluster.findUnique({
    where: { id: clusterId },
    include: {
      articles: {
        orderBy: [{ rank: "asc" }, { similarity: "desc" }],
        include: { article: true },
      },
    },
  });
  if (!cluster) return null;
  const pairs: Array<{ article_id: string; textHash: string }> = [];
  for (const link of cluster.articles) {
    const text = pickArticleText(link.article);
    if (!text) continue;
    pairs.push({ article_id: link.article.id, textHash: hashEmbeddingInput(text) });
  }
  if (pairs.length === 0) return null;
  return buildClusterInputSignature(pairs);
}

const PERSPECTIVE_FEATURE_KIND = "perspective_v1";
const SBERT_EMBEDDING_KIND = "sbert_embedding_v1";

export interface SidecarArticleIn {
  article_id: string;
  source_name: string;
  country: string | null;
  text: string;
  keywords?: string[];
  embedding?: number[];
}

export interface SidecarDistinctiveWords {
  source_name: string;
  words: string[];
  scores: number[];
}

export interface SidecarCountrySentiment {
  country: string;
  n_articles: number;
  avg_sentiment: number;
  sentiment_se: number;
  sentiment_label: "positive" | "neutral" | "negative";
  top_keywords: string[];
}

export interface SidecarDataQuality {
  n_articles_truncated_for_sentiment: number;
  sentiment_truncation_chars: number;
  n_articles_with_text: number;
}

export interface SidecarAnalyzeResponse {
  cluster_id: string;
  n_articles: number;
  n_sources: number;
  n_countries: number;
  divergence_score: number | null;
  divergence_label: "low" | "moderate" | "high" | "very_high" | null;
  pairwise_distance: Record<string, Record<string, number>>;
  distinctive_words: SidecarDistinctiveWords[];
  country_sentiment: SidecarCountrySentiment[];
  article_sentiment: Record<string, number>;
  article_embeddings: Record<string, number[]>;
  data_quality: SidecarDataQuality;
  sbert_model: string;
  sentiment_model: string;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function callSidecar(payload: {
  cluster_id: string;
  cluster_title: string | null;
  articles: SidecarArticleIn[];
  tfidf_top_n?: number;
}): Promise<SidecarAnalyzeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.PERSPECTIVE_SIDECAR_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.PERSPECTIVE_SIDECAR_URL}/analyze-cluster`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Perspective sidecar ${res.status}: ${body}`);
    }
    return (await res.json()) as SidecarAnalyzeResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Heuristic paywall / page-chrome detector. Returns true when the body is
 * clearly not real article prose. Caught in the wild:
 *   - FT: "Subscribe to unlock this article Try unlimited access Only AU$1
 *     for 4 weeks Then AU$99 per month."
 *   - reddit RSS: "Go on a holiday that's worth the upvote using points!
 *     Transfer bank points to Velocity to unlock 500+ travel destinations."
 * Stage 2 normally catches these by leaving framingSummary/translatedFullText
 * null (isNewsworthy=false), but when the compute runs against raw fullText
 * we need a guard to avoid embedding paywall boilerplate as if it were the
 * source's framing of the story.
 */
function looksLikePaywallOrChrome(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  const patterns = [
    "subscribe to unlock",
    "subscribe to read",
    "subscribe to continue",
    "become a subscriber",
    "become an insider",
    "sign in to continue",
    "create a free account",
    "unlimited access",
    "this article is for subscribers",
    "transfer bank points",
    "earn points and miles",
  ];
  return patterns.some((p) => head.includes(p));
}

function pickArticleText(article: {
  fullText: string | null;
  translatedFullText: string | null;
  framingSummary: string | null;
  contentSnippet: string | null;
  summary: string | null;
  language: string | null;
  extractionStatus: ExtractionStatus;
}): string {
  // Preference order for SBERT input:
  //   1. framingSummary — abstractive, written specifically to capture this
  //      source's distinctive framing. Higher signal-to-noise than the full
  //      body (the body usually shares verbatim wire-service quotes across
  //      sources, which drag embeddings together) and short enough that it
  //      never trips the LLM output-token cap that truncates translatedFullText.
  //   2. translatedFullText — the LLM-cleaned full body. Used for older rows
  //      that predate framingSummary, or when the model failed to produce one.
  //   3. raw fullText — only safe for English-language articles (feeding raw
  //      Cyrillic / Korean / etc. into the SBERT stack pollutes distinctive-word
  //      output and gives noisy embeddings) AND only when extraction succeeded
  //      and the body doesn't trip the paywall/chrome heuristic. Otherwise the
  //      article is excluded from the perspective compute by returning "".
  if (article.framingSummary && article.framingSummary.trim()) {
    return article.framingSummary.trim();
  }
  if (article.translatedFullText && article.translatedFullText.trim()) {
    return article.translatedFullText.trim();
  }
  // Beyond this point both LLM-enriched fields are empty. That happens for:
  //   (a) extraction failed — fullText is whatever the fetcher salvaged
  //       (usually the paywall page or a login wall);
  //   (b) stage 2 marked the article isNewsworthy=false (paywall, ad, photo
  //       page, boilerplate) — both translation fields are null by design;
  //   (c) genuinely older articles that predate stage 2.
  // For (a) and (b) the raw fullText is unreliable; for (c) it's fine.
  // Distinguishing them: extractionStatus catches (a); the paywall heuristic
  // catches (b) when its body slipped through extraction as legit-looking.
  if (article.extractionStatus !== ExtractionStatus.SUCCESS) return "";
  const isEnglish =
    !article.language || article.language.toLowerCase().slice(0, 2) === "en";
  if (!isEnglish) {
    return "";
  }
  const fallback = (article.fullText ?? article.contentSnippet ?? article.summary ?? "").trim();
  if (!fallback) return "";
  if (looksLikePaywallOrChrome(fallback)) return "";
  return fallback;
}

export interface ComputeClusterPerspectiveOptions {
  tfidfTopN?: number;
  persist?: boolean;
  /**
   * Auto-generate the LLM narrative after computing the perspective.
   * Defaults to `false` — narrative generation is opt-in (run the
   * `perspective:narrative` script, or pass `?narrative=true` on the API).
   * Set `true` to fire it inline (adds 5–30 s and consumes OpenRouter quota).
   */
  generateNarrative?: boolean;
  /**
   * Cap the number of articles fed into the sidecar. Articles are ranked by
   * `ClusterArticle.rank` ascending (rank 0 is best); the lowest-ranked tail
   * is dropped. Defaults to 100 — large global stories with hundreds of
   * sources would otherwise blow past the sidecar's per-call latency budget.
   */
  maxArticles?: number;
  /**
   * Cap the number of articles per source before the global cap is applied.
   * Prevents wire-service syndication (Reuters/AP/AFP carrying the same story
   * across dozens of feeds) from flooding the input set and squeezing out
   * other framings. Defaults to 5.
   */
  maxArticlesPerSource?: number;
}

const DEFAULT_MAX_ARTICLES = 100;
const DEFAULT_MAX_ARTICLES_PER_SOURCE = 5;

// Lightweight in-process job-queue stand-in: dedupe concurrent computes for
// the same cluster. Two simultaneous /api/clusters/:id/perspective?refresh=true
// calls would otherwise both hit the sidecar, both write embeddings, and race
// on the perspective row. This collapses them onto one in-flight promise.
const inFlight = new Map<string, Promise<SidecarAnalyzeResponse>>();

export async function computeClusterPerspective(
  clusterId: string,
  options: ComputeClusterPerspectiveOptions = {},
): Promise<SidecarAnalyzeResponse> {
  // Build a stable key including the relevant options so two callers with
  // different caps don't collide.
  const key = `${clusterId}|${options.tfidfTopN ?? ""}|${options.maxArticles ?? ""}|${options.maxArticlesPerSource ?? ""}|${options.generateNarrative ?? ""}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      return await runCompute(clusterId, options);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

async function runCompute(
  clusterId: string,
  options: ComputeClusterPerspectiveOptions,
): Promise<SidecarAnalyzeResponse> {
  const cluster = await prisma.storyCluster.findUnique({
    where: { id: clusterId },
    include: {
      articles: {
        orderBy: [{ rank: "asc" }, { similarity: "desc" }],
        include: { article: true },
      },
    },
  });

  if (!cluster) {
    throw new Error(`Cluster ${clusterId} not found`);
  }

  const maxArticles = Math.max(1, options.maxArticles ?? DEFAULT_MAX_ARTICLES);
  const maxPerSource = Math.max(
    1,
    options.maxArticlesPerSource ?? DEFAULT_MAX_ARTICLES_PER_SOURCE,
  );
  const totalLinks = cluster.articles.length;

  // Per-source cap first (preserves source diversity), then global cap.
  // Articles arrive sorted by rank-asc / similarity-desc, so taking the top-N
  // per source keeps each outlet's best representatives. We key by `domain`
  // here (not `sourceName`) because RSS feeds often expose section-titles as
  // sourceName — a single publisher like SCMP shows up as 23 different
  // sourceName values that should all be treated as one source.
  const perSourceCounts = new Map<string, number>();
  const afterPerSourceCap = cluster.articles.filter((link) => {
    const key = link.article.domain || link.article.sourceName || "__unknown__";
    const count = perSourceCounts.get(key) ?? 0;
    if (count >= maxPerSource) return false;
    perSourceCounts.set(key, count + 1);
    return true;
  });
  const rankedArticles = afterPerSourceCap.slice(0, maxArticles);
  if (totalLinks > rankedArticles.length) {
    console.log(
      `[perspective] cluster ${clusterId}: capping ${totalLinks} → ${afterPerSourceCap.length} (per-source ≤${maxPerSource}) → ${rankedArticles.length} (global ≤${maxArticles})`,
    );
  }

  const domains = Array.from(new Set(rankedArticles.map((a) => a.article.domain).filter(Boolean)));
  const profiles = await prisma.sourceProfile.findMany({
    where: { domain: { in: domains } },
    select: { domain: true, country: true, countryOfOrigin: true },
  });
  const countryByDomain = new Map<string, string | null>();
  for (const p of profiles) {
    countryByDomain.set(p.domain, p.countryOfOrigin ?? p.country ?? null);
  }

  const excluded: { id: string; domain: string; reason: string }[] = [];
  const candidateInputs = rankedArticles
    .map((link) => {
      const a = link.article;
      const text = pickArticleText(a);
      if (!text) {
        const reason =
          a.extractionStatus !== ExtractionStatus.SUCCESS
            ? `extraction=${a.extractionStatus}`
            : a.framingSummary || a.translatedFullText
              ? "empty-after-trim"
              : (a.fullText ?? "").trim().length === 0
                ? "no-fullText"
                : "paywall-or-chrome";
        excluded.push({ id: a.id, domain: a.domain, reason });
        return null;
      }
      const profileCountry = countryByDomain.get(a.domain) ?? null;
      const knownCountry = profileCountry ?? resolveCountryFromDomain(a.domain, a.sourceName);
      return {
        article_id: a.id,
        // Group by `domain` for divergence analysis. `sourceName` is the RSS
        // feed-section title and varies per section (e.g. SCMP exposes 23
        // different sourceName values for the same publisher); using it
        // would inflate n_sources and shrink per-source samples. Domain is
        // the stable canonical identifier for an outlet.
        source_name: a.domain || a.sourceName,
        domain: a.domain,
        knownCountry,
        text,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (excluded.length > 0) {
    const summary = excluded
      .map((e) => `${e.domain}:${e.reason}`)
      .join(", ");
    console.log(
      `[perspective] cluster ${clusterId}: excluded ${excluded.length}/${rankedArticles.length} article(s) — ${summary}`,
    );
  }

  // Country resolution uses tiers 1+2 (source dictionary, ccTLD) only here.
  // Tier-3 LLM fallback is a separate, opt-in batch script
  // (`pnpm perspective:resolve-countries`) so ingestion never depends on
  // OpenRouter quota. Domains that survive both tiers stay null.
  const articlesIn: SidecarArticleIn[] = candidateInputs.map((c) => ({
    article_id: c.article_id,
    source_name: c.source_name,
    country: c.knownCountry,
    text: c.text,
  }));

  if (articlesIn.length === 0) {
    throw new Error(`Cluster ${clusterId} has no articles with usable text`);
  }

  // Cache lookup is keyed on (articleId, model, textHash). Pass the current
  // text the sidecar will see, so a hash mismatch (because stage 2 populated
  // framingSummary after a previous lazy-compute embedded the raw fullText)
  // is treated as a miss and the article is re-encoded.
  const cacheInputs = new Map(
    articlesIn.map((a) => [a.article_id, hashEmbeddingInput(a.text)]),
  );
  const cachedEmbeddings = await loadCachedEmbeddings(cacheInputs);
  for (const article of articlesIn) {
    const cached = cachedEmbeddings.get(article.article_id);
    if (cached) article.embedding = cached;
  }

  const articleKeywords = await loadArticleKeywords(articlesIn.map((a) => a.article_id));
  for (const article of articlesIn) {
    const kws = articleKeywords.get(article.article_id);
    if (kws && kws.length > 0) article.keywords = kws;
  }

  const result = await callSidecar({
    cluster_id: clusterId,
    cluster_title: cluster.title,
    articles: articlesIn,
    ...(options.tfidfTopN !== undefined ? { tfidf_top_n: options.tfidfTopN } : {}),
  });

  // Override the sidecar's hard-coded label with our globally-calibrated one
  // so day-over-day comparisons stay meaningful as the dataset grows.
  const calibration = await getCalibration();
  result.divergence_label = applyCalibration(result.divergence_score, calibration);

  await persistEmbeddings(result, cachedEmbeddings, cacheInputs);

  if (options.persist !== false) {
    // Compute the input signature from the same (articleId, textHash) pairs
    // we just sent the sidecar. Storing it on the perspective row lets a
    // future read detect stale data automatically: if any article's text
    // has changed (re-enriched) or the cluster membership has shifted by
    // the time someone fetches the stored perspective, the recomputed
    // signature won't match and the consumer will refresh.
    const inputSignature = buildClusterInputSignature(
      articlesIn.map((a) => ({
        article_id: a.article_id,
        textHash: cacheInputs.get(a.article_id)!,
      })),
    );
    await persistPerspective(clusterId, result, calibration, inputSignature);
    const wantNarrative =
      options.generateNarrative === true && Boolean(process.env.OPENROUTER_API_KEY);
    if (wantNarrative) {
      const title = cluster.translatedTitle ?? cluster.title;
      try {
        await generateClusterNarrative(clusterId, title, result);
      } catch (err) {
        // Narrative generation is best-effort — don't fail the perspective compute.
        console.warn(
          `[cluster-perspective] narrative generation failed for ${clusterId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Drop bulky vectors before returning — callers don't need them.
  result.article_embeddings = {};
  return result;
}

async function loadArticleKeywords(articleIds: string[]): Promise<Map<string, string[]>> {
  if (articleIds.length === 0) return new Map();
  const rows = await prisma.nlpFeature.findMany({
    where: { articleId: { in: articleIds }, scopeType: ScopeType.ARTICLE },
    select: { articleId: true, featureSet: true },
  });
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.articleId) continue;
    const f = row.featureSet as { keywordsEnglish?: unknown; keywords?: unknown };
    const candidate = Array.isArray(f.keywordsEnglish)
      ? f.keywordsEnglish
      : Array.isArray(f.keywords)
        ? f.keywords
        : null;
    if (!candidate) continue;
    const kws = candidate.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (kws.length === 0) continue;
    // If multiple feature rows exist for an article, prefer the larger keyword set.
    const prev = out.get(row.articleId);
    if (!prev || prev.length < kws.length) out.set(row.articleId, kws);
  }
  return out;
}

async function loadCachedEmbeddings(
  articleIdsToHash: Map<string, string>,
): Promise<Map<string, number[]>> {
  if (articleIdsToHash.size === 0) return new Map();
  const rows = await prisma.nlpFeature.findMany({
    where: {
      articleId: { in: [...articleIdsToHash.keys()] },
      scopeType: ScopeType.ARTICLE,
      featureSet: { path: ["kind"], equals: SBERT_EMBEDDING_KIND },
    },
    select: { articleId: true, featureSet: true },
  });
  const out = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.articleId) continue;
    const f = row.featureSet as { vector?: unknown; model?: unknown; textHash?: unknown };
    // Treat rows without a textHash field as cache misses. They're from
    // before this invalidation guard existed, so the embedded text is
    // unknown and may pre-date stage 2's enrichment of the article. Forcing
    // a recompute here costs an SBERT call but eliminates a class of stale
    // perspective scores the user otherwise has to chase manually.
    if (!Array.isArray(f.vector) || f.model !== expectedSbertModel()) continue;
    if (typeof f.textHash !== "string") continue;
    const expectedHash = articleIdsToHash.get(row.articleId);
    if (!expectedHash || f.textHash !== expectedHash) continue;
    out.set(row.articleId, f.vector as number[]);
  }
  return out;
}

function expectedSbertModel(): string {
  return process.env.PERSPECTIVE_SBERT_MODEL || "all-mpnet-base-v2";
}

async function persistEmbeddings(
  result: SidecarAnalyzeResponse,
  alreadyCached: Map<string, number[]>,
  textHashes: Map<string, string>,
): Promise<void> {
  const entries = Object.entries(result.article_embeddings).filter(
    ([id]) => !alreadyCached.has(id),
  );
  if (entries.length === 0) return;

  for (const [articleId, vector] of entries) {
    // textHash records exactly which input string this embedding was
    // computed from, so a future call with different input (e.g. after
    // stage 2 populates framingSummary) can detect the cache as stale and
    // re-encode rather than reusing a vector built from raw fullText.
    const payload = toInputJson({
      kind: SBERT_EMBEDDING_KIND,
      model: result.sbert_model,
      textHash: textHashes.get(articleId) ?? null,
      vector,
      computedAt: new Date().toISOString(),
    });
    const existing = await prisma.nlpFeature.findFirst({
      where: {
        articleId,
        scopeType: ScopeType.ARTICLE,
        featureSet: { path: ["kind"], equals: SBERT_EMBEDDING_KIND },
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.nlpFeature.update({ where: { id: existing.id }, data: { featureSet: payload } });
    } else {
      await prisma.nlpFeature.create({
        data: { scopeType: ScopeType.ARTICLE, articleId, featureSet: payload },
      });
    }
  }
}

async function persistPerspective(
  clusterId: string,
  result: SidecarAnalyzeResponse,
  calibration: import("./perspective-calibration.js").PerspectiveCalibration,
  inputSignature: string,
): Promise<void> {
  const existing = await prisma.nlpFeature.findFirst({
    where: {
      clusterId,
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: PERSPECTIVE_FEATURE_KIND },
    },
    select: { id: true, featureSet: true },
  });

  // Preserve existing narrative across recomputes — it's expensive to regenerate.
  const previous = (existing?.featureSet as Record<string, unknown> | null) ?? null;
  const preservedNarrative = previous?.narrative;

  const featurePayload = toInputJson({
    kind: PERSPECTIVE_FEATURE_KIND,
    computedAt: new Date().toISOString(),
    inputSignature,
    sbertModel: result.sbert_model,
    sentimentModel: result.sentiment_model,
    divergenceScore: result.divergence_score,
    divergenceLabel: result.divergence_label,
    pairwiseDistance: result.pairwise_distance,
    distinctiveWords: result.distinctive_words,
    countrySentiment: result.country_sentiment,
    dataQuality: result.data_quality,
    calibration: {
      p25: calibration.p25,
      p75: calibration.p75,
      p90: calibration.p90,
      sampleSize: calibration.sampleSize,
      computedAt: calibration.computedAt,
    },
    nSources: result.n_sources,
    nCountries: result.n_countries,
    nArticles: result.n_articles,
    ...(preservedNarrative !== undefined ? { narrative: preservedNarrative } : {}),
  });

  if (existing) {
    await prisma.nlpFeature.update({
      where: { id: existing.id },
      data: { featureSet: featurePayload },
    });
  } else {
    await prisma.nlpFeature.create({
      data: {
        scopeType: ScopeType.CLUSTER,
        clusterId,
        featureSet: featurePayload,
      },
    });
  }
}

export interface ClusterReadiness {
  ready: boolean;
  totalArticles: number;
  enrichedArticles: number;
  enrichedRatio: number;
  hasPerspective: boolean;
  reason: string | null;
}

/**
 * Cluster-level pipeline readiness check used by API routes that surface
 * cluster data. A cluster is "ready" once stage 2 (LLM enrichment) has
 * populated `translatedFullText` or `framingSummary` on at least half of
 * its articles AND stage 4 (cluster-perspective-backfill) has produced a
 * `perspective_v1` NlpFeature row.
 *
 * Both criteria together prevent two failure modes:
 *   1. Pre-stage-2 lazy-compute (the perspective row exists but was built
 *      from raw fullText / empty strings) — fails the enrichedRatio gate.
 *   2. Mid-stage-2 partial enrichment (translations populated but the
 *      perspective compute hasn't run yet) — fails the hasPerspective gate.
 *
 * Stage 3 (entity linking) is intentionally NOT part of the gate —
 * entities are decorative, often fail per-article on Wikipedia rate
 * limits, and shouldn't block the divergence-score view from rendering.
 */
export async function getClusterReadiness(clusterId: string): Promise<ClusterReadiness> {
  const links = await prisma.clusterArticle.findMany({
    where: { clusterId },
    select: {
      article: {
        select: { translatedFullText: true, framingSummary: true },
      },
    },
  });
  const totalArticles = links.length;
  const enrichedArticles = links.filter(
    (l) => l.article?.translatedFullText || l.article?.framingSummary,
  ).length;
  const enrichedRatio = totalArticles > 0 ? enrichedArticles / totalArticles : 0;
  const perspective = await prisma.nlpFeature.findFirst({
    where: {
      clusterId,
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: PERSPECTIVE_FEATURE_KIND },
    },
    select: { id: true },
  });
  const hasPerspective = perspective !== null;

  let reason: string | null = null;
  if (totalArticles === 0) reason = "Cluster has no articles";
  else if (enrichedRatio < 0.5)
    reason = `Cluster enrichment in progress (${enrichedArticles}/${totalArticles} articles enriched)`;
  else if (!hasPerspective)
    reason = "Cluster perspective not yet computed";

  return {
    ready: reason === null,
    totalArticles,
    enrichedArticles,
    enrichedRatio,
    hasPerspective,
    reason,
  };
}

export async function getStoredClusterPerspective(
  clusterId: string,
): Promise<SidecarAnalyzeResponse | null> {
  const row = await prisma.nlpFeature.findFirst({
    where: {
      clusterId,
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: PERSPECTIVE_FEATURE_KIND },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  const f = row.featureSet as Record<string, unknown>;

  // Pull-based invalidation: compare the stored input signature against
  // the current state of the cluster's articles. If any article has been
  // re-enriched (different framingSummary / translatedFullText) or the
  // membership has changed since this row was written, return null so the
  // caller treats it as a cache miss and recomputes against fresh text.
  // Rows without an `inputSignature` field are from before this guard
  // existed — treat them as stale by default rather than risk surfacing a
  // matrix computed against unknown text.
  const storedSignature = typeof f.inputSignature === "string" ? f.inputSignature : null;
  const currentSignature = await computeCurrentClusterInputSignature(clusterId);
  if (storedSignature === null || currentSignature === null || storedSignature !== currentSignature) {
    return null;
  }
  return {
    cluster_id: clusterId,
    n_articles: (f.nArticles as number) ?? 0,
    n_sources: (f.nSources as number) ?? 0,
    n_countries: (f.nCountries as number) ?? 0,
    divergence_score: (f.divergenceScore as number | null) ?? null,
    divergence_label: (f.divergenceLabel as SidecarAnalyzeResponse["divergence_label"]) ?? null,
    pairwise_distance: (f.pairwiseDistance as SidecarAnalyzeResponse["pairwise_distance"]) ?? {},
    distinctive_words: (f.distinctiveWords as SidecarDistinctiveWords[]) ?? [],
    country_sentiment: (f.countrySentiment as SidecarCountrySentiment[]) ?? [],
    article_sentiment: {},
    article_embeddings: {},
    data_quality: (f.dataQuality as SidecarDataQuality) ?? {
      n_articles_truncated_for_sentiment: 0,
      sentiment_truncation_chars: 0,
      n_articles_with_text: (f.nArticles as number) ?? 0,
    },
    sbert_model: (f.sbertModel as string) ?? "",
    sentiment_model: (f.sentimentModel as string) ?? "",
  };
}
