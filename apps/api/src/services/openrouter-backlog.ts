import { Prisma, ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { buildArticleFeaturesWithOpenRouter, buildClusterKeywordsWithOpenRouter } from "./nlp.js";
import { enrichSourceProfileWithOpenRouter } from "./source-profile-enrichment.js";

type JsonObject = Record<string, unknown>;

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function joinText(parts: Array<string | null | undefined>, maxLength: number): string {
  return parts.filter((value): value is string => Boolean(value)).join("\n\n").slice(0, maxLength);
}

function pickLanguage(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * For non-English clusters, look at the cluster's articles' cached
 * NlpFeature.featureSet.translatedTitle and reuse one. Prefer an exact match
 * to the cluster title (Kagi often picks the cluster title from one of the
 * articles); otherwise fall back to the first non-empty translated title.
 */
async function pickClusterTranslatedTitle(
  clusterId: string,
  clusterTitle: string,
): Promise<string | null> {
  const features = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.ARTICLE,
      article: { clusterLinks: { some: { clusterId } } },
    },
    select: {
      featureSet: true,
      article: { select: { title: true, language: true } },
    },
  });
  const candidates: Array<{ original: string; translated: string }> = [];
  for (const f of features) {
    const set = f.featureSet as JsonObject;
    const translated = typeof set.translatedTitle === "string" ? set.translatedTitle.trim() : "";
    if (!translated || !f.article) continue;
    const isEnglish =
      !f.article.language || f.article.language.toLowerCase().slice(0, 2) === "en";
    if (isEnglish) continue;
    if (translated.toLowerCase() === f.article.title.toLowerCase()) continue;
    candidates.push({ original: f.article.title, translated });
  }
  if (candidates.length === 0) return null;
  const exact = candidates.find(
    (c) => c.original.trim().toLowerCase() === clusterTitle.trim().toLowerCase(),
  );
  if (exact) return exact.translated;
  // Prefer the article whose original title shares the most word tokens with
  // the cluster title — clusters typically rephrase one of their articles, so
  // token overlap is a decent heuristic for "this article is the cluster's
  // canonical headline". Tie-breaker: insertion order.
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
  const clusterTokens = tokenize(clusterTitle);
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    for (const tok of tokenize(c.original)) if (clusterTokens.has(tok)) score += 1;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best.translated;
}

function sourceProfileNeedsEnrichment(row: {
  description: string | null;
  country: string | null;
  headquarters: string | null;
  mediaOwner: string | null;
  wikipediaUrl: string | null;
}): boolean {
  return !row.description || !row.country || !row.headquarters || !row.mediaOwner || !row.wikipediaUrl;
}

export async function runOpenRouterBacklog(options?: {
  articleLimit?: number;
  clusterLimit?: number;
  sourceLimit?: number;
  date?: string;
  log?: (message: string) => void;
}): Promise<{
  articles: { attempted: number; ready: number; failed: number };
  clusters: { attempted: number; ready: number; pending: number };
  sources: { attempted: number; enriched: number; failed: number };
}> {
  const log = options?.log ?? (() => {});
  const articleLimit = parsePositiveInt(options?.articleLimit, 25);
  const clusterLimit = parsePositiveInt(options?.clusterLimit, 10);
  const sourceLimit = parsePositiveInt(options?.sourceLimit, 10);
  const dateWhere = options?.date
    ? {
        gte: new Date(`${options.date}T00:00:00.000Z`),
        lte: new Date(`${options.date}T23:59:59.999Z`),
      }
    : undefined;

  const articleFeatures = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.ARTICLE,
      ...(dateWhere ? { article: { ingestionDate: dateWhere } } : {}),
    },
    include: {
      article: {
        select: {
          id: true,
          title: true,
          summary: true,
          contentSnippet: true,
          fullText: true,
          language: true,
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: articleLimit * 4,
  });

  const pendingArticles = articleFeatures
    .filter((feature) => feature.article)
    .filter((feature) => {
      const payload = feature.featureSet as JsonObject;
      return payload.aiEnrichmentStatus !== "ready";
    })
    .slice(0, articleLimit);

  let articleReady = 0;
  let articleFailed = 0;

  for (const feature of pendingArticles) {
    const article = feature.article!;
    const body = article.fullText ?? article.contentSnippet;
    const current = feature.featureSet as JsonObject;
    try {
      const next = await buildArticleFeaturesWithOpenRouter(
        article.title,
        article.summary,
        body,
        article.language,
      );
      await prisma.nlpFeature.update({
        where: { id: feature.id },
        data: {
          featureSet: toInputJson({
            ...current,
            ...next,
            aiEnrichmentStatus: "ready",
            aiEnrichmentModel: "openrouter",
            aiEnrichmentError: null,
            aiEnrichedAt: new Date().toISOString(),
          }),
        },
      });
      const articleUpdate: {
        summary?: string;
        translatedTitle?: string;
        translatedSummary?: string;
        translatedFullText?: string;
        language?: string;
      } = {};
      if (!article.summary && next.translatedSummary) {
        articleUpdate.summary = next.translatedSummary;
      }
      if (next.translatedTitle) {
        articleUpdate.translatedTitle = next.translatedTitle;
      }
      if (next.translatedSummary) {
        articleUpdate.translatedSummary = next.translatedSummary;
      }
      if (next.translatedFullText) {
        articleUpdate.translatedFullText = next.translatedFullText;
      }
      // Persist detected language so downstream stages (entity-re-enrich) can
      // branch on it without inspecting NlpFeature.featureSet.
      if (!article.language && typeof next.language === "string" && next.language.trim()) {
        articleUpdate.language = next.language.trim().toLowerCase();
      }
      if (Object.keys(articleUpdate).length > 0) {
        await prisma.article.update({
          where: { id: article.id },
          data: articleUpdate,
        });
      }
      articleReady += 1;
      log(`[openrouter-backlog][article] ready ${article.id}`);
    } catch (error) {
      await prisma.nlpFeature.update({
        where: { id: feature.id },
        data: {
          featureSet: toInputJson({
            ...current,
            aiEnrichmentStatus: "failed",
            aiEnrichmentError: error instanceof Error ? error.message : String(error),
            aiEnrichedAt: new Date().toISOString(),
          }),
        },
      });
      articleFailed += 1;
      log(`[openrouter-backlog][article] failed ${article.id}`);
    }
  }

  const clusterFeatures = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      ...(dateWhere ? { cluster: { storyDate: dateWhere } } : {}),
    },
    include: {
      cluster: {
        select: {
          id: true,
          title: true,
          translatedTitle: true,
          articles: {
            orderBy: { rank: "asc" },
            include: {
              article: {
                select: {
                  title: true,
                  summary: true,
                  contentSnippet: true,
                  fullText: true,
                  language: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: clusterLimit * 4,
  });

  const pendingClusters = clusterFeatures
    .filter((feature) => feature.cluster)
    .filter((feature) => {
      const payload = feature.featureSet as JsonObject;
      return payload.keywordStatus === "keywords_pending";
    })
    .slice(0, clusterLimit);

  let clusterReady = 0;
  let clusterPending = 0;

  for (const feature of pendingClusters) {
    const cluster = feature.cluster!;
    const articles = cluster.articles.slice(0, 6).map((item) => item.article);
    const language = pickLanguage(articles.map((article) => article.language));
    const summary = joinText(articles.map((article) => article.summary), 3000);
    const body = joinText(articles.map((article) => article.fullText ?? article.contentSnippet), 6000);
    const current = feature.featureSet as JsonObject;

    const openrouter = await buildClusterKeywordsWithOpenRouter(
      cluster.title,
      articles.map((article) => ({
        title: article.title,
        summary: article.summary,
        body: article.fullText ?? article.contentSnippet,
        language: article.language ?? language,
      })),
    );

    await prisma.nlpFeature.update({
      where: { id: feature.id },
      data: {
        featureSet: toInputJson({
          ...current,
          keywords: openrouter.keywords.length > 0 ? openrouter.keywords : current.keywords,
          keywordSource: "openrouter",
          keywordStatus: openrouter.status,
          keywordModel: openrouter.model,
          keywordError: openrouter.error,
        }),
      },
    });

    if (openrouter.status === "ready") {
      clusterReady += 1;
      log(`[openrouter-backlog][cluster] ready ${cluster.id}`);
    } else {
      clusterPending += 1;
      log(`[openrouter-backlog][cluster] pending ${cluster.id}`);
    }
  }

  // Backfill cluster translatedTitle for non-English clusters that don't yet
  // have one. Runs every backlog pass; cheap (no LLM call — just reuses the
  // article-level translatedTitle already cached in NlpFeature).
  const clustersMissingTranslation = await prisma.storyCluster.findMany({
    where: {
      translatedTitle: null,
      ...(dateWhere ? { storyDate: dateWhere } : {}),
    },
    select: { id: true, title: true },
    orderBy: { storyDate: "desc" },
    take: 200,
  });
  for (const cluster of clustersMissingTranslation) {
    const translatedTitle = await pickClusterTranslatedTitle(cluster.id, cluster.title);
    if (translatedTitle) {
      await prisma.storyCluster.update({
        where: { id: cluster.id },
        data: { translatedTitle },
      });
      log(`[openrouter-backlog][cluster] translatedTitle set ${cluster.id}`);
    }
  }

  const sourceProfiles = await prisma.sourceProfile.findMany({
    ...(dateWhere
      ? {
          where: {
            updatedAt: dateWhere,
          },
        }
      : {}),
    orderBy: { updatedAt: "asc" },
    take: sourceLimit * 4,
  });

  const pendingSources = sourceProfiles
    .filter((profile) => sourceProfileNeedsEnrichment(profile))
    .slice(0, sourceLimit);

  let sourceEnriched = 0;
  let sourceFailed = 0;

  for (const profile of pendingSources) {
    const enrichment = await enrichSourceProfileWithOpenRouter({
      domain: profile.domain,
      sourceName: profile.sourceName,
    });

    await prisma.sourceProfile.update({
      where: { id: profile.id },
      data: {
        description: profile.description ?? enrichment.description ?? null,
        country: profile.country ?? enrichment.country ?? null,
        countryOfOrigin: profile.countryOfOrigin ?? enrichment.countryOfOrigin ?? null,
        headquarters: profile.headquarters ?? enrichment.headquarters ?? null,
        mediaOwner: profile.mediaOwner ?? enrichment.mediaOwner ?? null,
        ownershipType: profile.ownershipType ?? enrichment.ownershipType ?? null,
        employeeCount: profile.employeeCount ?? enrichment.employeeCount ?? null,
        wikipediaUrl: profile.wikipediaUrl ?? enrichment.wikipediaUrl ?? null,
        associatedEntities: [...new Set([...profile.associatedEntities, ...enrichment.associatedEntities])].slice(0, 8),
        lastEnrichedAt: enrichment.error ? profile.lastEnrichedAt : new Date(),
        enrichmentModel: enrichment.model ?? profile.enrichmentModel,
      },
    });

    if (enrichment.error) {
      sourceFailed += 1;
      log(`[openrouter-backlog][source] failed ${profile.domain}`);
    } else {
      sourceEnriched += 1;
      log(`[openrouter-backlog][source] ready ${profile.domain}`);
    }
  }

  return {
    articles: { attempted: pendingArticles.length, ready: articleReady, failed: articleFailed },
    clusters: { attempted: pendingClusters.length, ready: clusterReady, pending: clusterPending },
    sources: { attempted: pendingSources.length, enriched: sourceEnriched, failed: sourceFailed },
  };
}
