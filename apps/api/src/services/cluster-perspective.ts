import { Prisma, ScopeType } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveCountryFromDomain } from "./country-from-domain.js";
import { applyCalibration, getCalibration } from "./perspective-calibration.js";
import { generateClusterNarrative } from "./cluster-perspective-narrative.js";

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

function pickArticleText(article: {
  fullText: string | null;
  translatedFullText: string | null;
  contentSnippet: string | null;
  summary: string | null;
  language: string | null;
}): string {
  // Prefer the LLM-cleaned English version when present (now produced for
  // both English and non-English articles — strips chrome / image captions
  // / boilerplate). Falls back to the raw English fullText, then content
  // snippets. The `translatedFullText IS NULL → not-newsworthy` filter
  // applied by the caller already excludes boilerplate articles.
  if (article.translatedFullText && article.translatedFullText.trim()) {
    return article.translatedFullText.trim();
  }
  const isEnglish =
    !article.language || article.language.toLowerCase().slice(0, 2) === "en";
  if (!isEnglish) {
    // Non-English without translation: skip — feeding original-language
    // text to the SBERT/TF-IDF stack pollutes distinctive-word output.
    return "";
  }
  return (article.fullText ?? article.contentSnippet ?? article.summary ?? "").trim();
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

  const candidateInputs = rankedArticles
    .map((link) => {
      const a = link.article;
      const text = pickArticleText(a);
      if (!text) return null;
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

  const cachedEmbeddings = await loadCachedEmbeddings(articlesIn.map((a) => a.article_id));
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

  await persistEmbeddings(result, cachedEmbeddings);

  if (options.persist !== false) {
    await persistPerspective(clusterId, result, calibration);
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

async function loadCachedEmbeddings(articleIds: string[]): Promise<Map<string, number[]>> {
  if (articleIds.length === 0) return new Map();
  const rows = await prisma.nlpFeature.findMany({
    where: {
      articleId: { in: articleIds },
      scopeType: ScopeType.ARTICLE,
      featureSet: { path: ["kind"], equals: SBERT_EMBEDDING_KIND },
    },
    select: { articleId: true, featureSet: true },
  });
  const out = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.articleId) continue;
    const f = row.featureSet as { vector?: unknown; model?: unknown };
    if (Array.isArray(f.vector) && f.model === expectedSbertModel()) {
      out.set(row.articleId, f.vector as number[]);
    }
  }
  return out;
}

function expectedSbertModel(): string {
  return process.env.PERSPECTIVE_SBERT_MODEL || "all-mpnet-base-v2";
}

async function persistEmbeddings(
  result: SidecarAnalyzeResponse,
  alreadyCached: Map<string, number[]>,
): Promise<void> {
  const entries = Object.entries(result.article_embeddings).filter(
    ([id]) => !alreadyCached.has(id),
  );
  if (entries.length === 0) return;

  for (const [articleId, vector] of entries) {
    const payload = toInputJson({
      kind: SBERT_EMBEDDING_KIND,
      model: result.sbert_model,
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
