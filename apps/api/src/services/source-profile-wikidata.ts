/**
 * Wikidata-first enrichment for SourceProfile.
 *
 * Resolves a news organization's domain to a Wikidata QID via wbsearchentities,
 * verifies the match by checking P856 (official website) hostname matches the
 * domain, then fetches structured properties (country, HQ, owner, employees,
 * Wikipedia URL) via a single SPARQL query plus a Wikipedia REST summary.
 *
 * Returns null on no-match or any HTTP/parse error so callers can fall back to
 * the LLM enrichment path.
 */

import type { SourceProfileEnrichmentResult } from "./source-profile-enrichment.js";
import { resolveCountryFromDomain } from "./country-from-domain.js";
import { DiskCache } from "./disk-cache.js";

export interface WikidataEnrichmentResult extends SourceProfileEnrichmentResult {
  wikidataId: string;
}

const WBSEARCH_URL = "https://www.wikidata.org/w/api.php";
const WDQS_URL = "https://query.wikidata.org/sparql";
const WP_REST_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const USER_AGENT =
  "NewsInPerspective/1.0 (https://github.com/coezbek/NewsInPerspectiveCodex; c.oezbek@gmail.com) source-profile enrichment";
const HTTP_TIMEOUT_MS = 8000;

// 30-day TTL for all Wikidata/Wikipedia source-profile lookups. Source profiles
// (country, HQ, owner) change very rarely; caching aggressively here is safe
// and removes the bulk of the latency on repeat enrichment runs.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const searchCache = new DiskCache<SearchCandidate[]>({
  namespace: "wikidata-search",
  ttlMs: CACHE_TTL_MS,
  disableEnvVar: "WIKIDATA_CACHE_DISABLE",
  dirEnvVar: "WIKIDATA_CACHE_DIR",
});

const sparqlCache = new DiskCache<Array<[string, CandidateProps]>>({
  namespace: "wikidata-sparql",
  ttlMs: CACHE_TTL_MS,
  disableEnvVar: "WIKIDATA_CACHE_DISABLE",
  dirEnvVar: "WIKIDATA_CACHE_DIR",
});

const summaryCache = new DiskCache<{ summary: string | null }>({
  namespace: "wikipedia-summary",
  ttlMs: CACHE_TTL_MS,
  disableEnvVar: "WIKIDATA_CACHE_DISABLE",
  dirEnvVar: "WIKIDATA_CACHE_DIR",
});

const enrichCache = new DiskCache<{ result: WikidataEnrichmentResult | null }>({
  namespace: "wikidata-enrich",
  ttlMs: CACHE_TTL_MS,
  disableEnvVar: "WIKIDATA_CACHE_DISABLE",
  dirEnvVar: "WIKIDATA_CACHE_DIR",
});

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "").trim();
}

function hostFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Trim a description to ~maxChars on a sentence boundary if possible.
 */
export function trimToSentence(text: string, maxChars = 280): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = trimmed.slice(0, maxChars);
  // Prefer the last `.`/`!`/`?` followed by whitespace within the window.
  const m = head.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].length >= Math.floor(maxChars * 0.5)) {
    return m[0].trim();
  }
  // Otherwise back off to the last whitespace.
  const ws = head.lastIndexOf(" ");
  if (ws > 0) return head.slice(0, ws).trim() + "…";
  return head.trim() + "…";
}

interface SearchCandidate {
  id: string;
  label?: string;
  description?: string;
}

async function searchCandidates(query: string): Promise<SearchCandidate[]> {
  return searchCache.with({ q: query }, async () => {
    const url = new URL(WBSEARCH_URL);
    url.searchParams.set("action", "wbsearchentities");
    url.searchParams.set("search", query);
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    url.searchParams.set("type", "item");
    url.searchParams.set("limit", "5");
    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) throw new Error(`wbsearchentities ${response.status}`);
    const data = (await response.json()) as { search?: SearchCandidate[] };
    return Array.isArray(data.search) ? data.search : [];
  });
}

interface SparqlBindings {
  [key: string]: { value: string; type: string; "xml:lang"?: string };
}

interface SparqlResponse {
  results?: { bindings?: SparqlBindings[] };
}

async function runSparql(query: string): Promise<SparqlBindings[]> {
  const url = `${WDQS_URL}?query=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/sparql-results+json" },
  });
  if (!response.ok) throw new Error(`WDQS ${response.status}`);
  const data = (await response.json()) as SparqlResponse;
  return data.results?.bindings ?? [];
}

interface CandidateProps {
  qid: string;
  websites: string[];
  countryLabel?: string;
  hqLabel?: string;
  ownerLabel?: string;
  parentLabel?: string;
  inception?: string;
  employees?: number;
  wikipediaUrl?: string;
  wikipediaTitle?: string;
  subsidiaryLabels: string[];
}

/**
 * Fetch P17/P159/P127/P749/P571/P1128/P856/P355 + English sitelink for a list
 * of candidate QIDs in one SPARQL call. Each candidate yields one row in the
 * returned map; multi-valued fields (websites, subsidiaries) are aggregated.
 */
async function fetchCandidateProperties(
  qids: string[],
): Promise<Map<string, CandidateProps>> {
  const out = new Map<string, CandidateProps>();
  if (qids.length === 0) return out;
  // Cache by sorted QID set so call-order doesn't fragment the cache.
  const cacheKey = { qids: [...qids].sort() };
  const entries = await sparqlCache.with(cacheKey, async () => {
    const map = await fetchCandidatePropertiesUncached(qids);
    return [...map.entries()];
  });
  for (const [k, v] of entries) out.set(k, v);
  return out;
}

async function fetchCandidatePropertiesUncached(
  qids: string[],
): Promise<Map<string, CandidateProps>> {
  const out = new Map<string, CandidateProps>();
  if (qids.length === 0) return out;

  const values = qids.map((q) => `wd:${q}`).join(" ");
  const sparql = `
SELECT ?item ?website ?countryLabel ?hqLabel ?ownerLabel ?parentLabel
       ?inception ?employees ?article ?subsidiaryLabel WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P856 ?website. }
  OPTIONAL { ?item wdt:P17 ?country. ?country rdfs:label ?countryLabel. FILTER(lang(?countryLabel)="en") }
  OPTIONAL { ?item wdt:P159 ?hq. ?hq rdfs:label ?hqLabel. FILTER(lang(?hqLabel)="en") }
  OPTIONAL { ?item wdt:P127 ?owner. ?owner rdfs:label ?ownerLabel. FILTER(lang(?ownerLabel)="en") }
  OPTIONAL { ?item wdt:P749 ?parent. ?parent rdfs:label ?parentLabel. FILTER(lang(?parentLabel)="en") }
  OPTIONAL { ?item wdt:P571 ?inception. }
  OPTIONAL { ?item wdt:P1128 ?employees. }
  OPTIONAL { ?item wdt:P355 ?subsidiary. ?subsidiary rdfs:label ?subsidiaryLabel. FILTER(lang(?subsidiaryLabel)="en") }
  OPTIONAL {
    ?article schema:about ?item;
             schema:isPartOf <https://en.wikipedia.org/>.
  }
}`;

  const bindings = await runSparql(sparql);
  for (const row of bindings) {
    const itemUri = row.item?.value ?? "";
    const qid = itemUri.split("/").pop() ?? "";
    if (!qid) continue;
    let entry = out.get(qid);
    if (!entry) {
      entry = { qid, websites: [], subsidiaryLabels: [] };
      out.set(qid, entry);
    }
    const w = row.website?.value;
    if (w && !entry.websites.includes(w)) entry.websites.push(w);
    if (row.countryLabel?.value && !entry.countryLabel) entry.countryLabel = row.countryLabel.value;
    if (row.hqLabel?.value && !entry.hqLabel) entry.hqLabel = row.hqLabel.value;
    if (row.ownerLabel?.value && !entry.ownerLabel) entry.ownerLabel = row.ownerLabel.value;
    if (row.parentLabel?.value && !entry.parentLabel) entry.parentLabel = row.parentLabel.value;
    if (row.inception?.value && !entry.inception) entry.inception = row.inception.value;
    if (row.employees?.value) {
      const n = Number.parseFloat(row.employees.value);
      if (Number.isFinite(n)) {
        // Keep the largest (most recent companies tend to grow); spec says
        // "most recent if multiple" but date isn't projected — max is a
        // reasonable proxy and avoids dragging the qualifier graph in.
        entry.employees = entry.employees ? Math.max(entry.employees, n) : n;
      }
    }
    if (row.article?.value && !entry.wikipediaUrl) {
      entry.wikipediaUrl = row.article.value;
      try {
        const u = new URL(row.article.value);
        // /wiki/<title>
        const path = u.pathname.replace(/^\/wiki\//, "");
        entry.wikipediaTitle = decodeURIComponent(path);
      } catch {
        // ignore
      }
    }
    const sub = row.subsidiaryLabel?.value;
    if (sub && !entry.subsidiaryLabels.includes(sub)) entry.subsidiaryLabels.push(sub);
  }

  return out;
}

async function fetchWikipediaSummary(title: string): Promise<string | null> {
  const cached = await summaryCache.with({ title }, async () => {
    const url = `${WP_REST_SUMMARY}${encodeURIComponent(title)}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) return { summary: null };
    const data = (await response.json()) as { extract?: string };
    if (!data.extract) return { summary: null };
    return { summary: trimToSentence(data.extract, 280) };
  });
  return cached.summary;
}

export async function enrichSourceProfileFromWikidata(input: {
  domain: string;
  sourceName: string;
}): Promise<WikidataEnrichmentResult | null> {
  const cacheKey = {
    domain: normalizeDomain(input.domain),
    sourceName: input.sourceName.trim().toLowerCase(),
  };
  const wrapped = await enrichCache.with(cacheKey, async () => {
    const result = await enrichSourceProfileFromWikidataUncached(input);
    return { result };
  });
  return wrapped.result;
}

async function enrichSourceProfileFromWikidataUncached(input: {
  domain: string;
  sourceName: string;
}): Promise<WikidataEnrichmentResult | null> {
  const fastPathCountry = resolveCountryFromDomain(input.domain, input.sourceName);
  const target = normalizeDomain(input.domain);

  try {
    // Build search queries from richest to broadest. wbsearchentities does not
    // match dotted forms ("npr.org"), so when sourceName looks like a domain
    // we also try the bare label ("npr") which is what Wikidata indexes.
    const bareLabel = target.split(".").slice(0, -1).join(".") || target;
    const queries = [input.sourceName, input.domain, bareLabel]
      .map((q) => q?.trim())
      .filter((q): q is string => Boolean(q))
      .filter((q, i, arr) => arr.indexOf(q) === i);
    const seen = new Set<string>();
    const candidates: SearchCandidate[] = [];
    for (const q of queries) {
      const found = await searchCandidates(q);
      for (const c of found) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          candidates.push(c);
        }
      }
    }
    if (candidates.length === 0) return null;

    const props = await fetchCandidateProperties(candidates.map((c) => c.id));

    // Pick the first candidate (in search-rank order) whose P856 host matches.
    let chosen: CandidateProps | null = null;
    for (const c of candidates) {
      const p = props.get(c.id);
      if (!p) continue;
      const match = p.websites.some((w) => {
        const host = hostFromUrl(w);
        return host === target || (host && target.endsWith(`.${host}`)) || (host && host.endsWith(`.${target}`));
      });
      if (match) {
        chosen = p;
        break;
      }
    }

    if (!chosen) return null;

    let description: string | null = null;
    if (chosen.wikipediaTitle) {
      try {
        description = await fetchWikipediaSummary(chosen.wikipediaTitle);
      } catch {
        description = null;
      }
    }

    const associated: string[] = [];
    for (const v of [chosen.ownerLabel, chosen.parentLabel, ...chosen.subsidiaryLabels]) {
      if (v && !associated.includes(v)) associated.push(v);
      if (associated.length >= 8) break;
    }

    const employeeCount =
      typeof chosen.employees === "number" && Number.isFinite(chosen.employees)
        ? Math.max(0, Math.round(chosen.employees))
        : null;

    return {
      description,
      country: chosen.countryLabel ?? fastPathCountry,
      countryOfOrigin: chosen.countryLabel ?? fastPathCountry,
      headquarters: chosen.hqLabel ?? null,
      mediaOwner: chosen.ownerLabel ?? chosen.parentLabel ?? null,
      ownershipType: null,
      employeeCount,
      wikipediaUrl: chosen.wikipediaUrl ?? null,
      associatedEntities: associated,
      model: "wikidata",
      error: null,
      wikidataId: chosen.qid,
    };
  } catch {
    return null;
  }
}
