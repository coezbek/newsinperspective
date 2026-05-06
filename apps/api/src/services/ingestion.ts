import { Prisma, RunStatus, ScopeType } from "@prisma/client";
import { extractRegion } from "../domain/category.js";
import { env } from "../config/env.js";
import { createFileLogger } from "../lib/file-logger.js";
import { prisma } from "../lib/prisma.js";
import { clusterArticles } from "./clustering.js";
import { fetchFeedCatalog } from "./feed-catalog.js";
import { buildArticleFeatures, buildClusterKeywordFallback } from "./nlp.js";
import { fetchFeedEntries } from "./rss-ingest.js";
import { upsertSourceProfiles } from "./source-profiles.js";

function startOfDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toJsonSafeArticle(article: {
  originalUrl: string;
  canonicalUrl: string;
  textFingerprint: string | null;
  title: string;
  summary: string | null;
  contentSnippet: string | null;
  publishedAt: Date | null;
  sourceName: string;
  domain: string;
  language: string | null;
  category: string | null;
  authorNames: string[];
}) {
  return {
    ...article,
    publishedAt: article.publishedAt?.toISOString() ?? null,
  };
}

function uniqueDomainsForArticle(article: { domain: string; duplicateDomains: string[] }): string[] {
  return [...new Set([article.domain, ...article.duplicateDomains])];
}

async function upsertNormalizedArticle(
  article: {
    originalUrl: string;
    canonicalUrl: string;
    textFingerprint: string | null;
    title: string;
    summary: string | null;
    contentSnippet: string | null;
    publishedAt: Date | null;
    sourceName: string;
    domain: string;
    language: string | null;
    category: string | null;
    authorNames: string[];
  },
  ingestionDate: Date,
  feedSourceId: string,
) {
  const existing = await prisma.article.findFirst({
    where: {
      OR: [
        { canonicalUrl: article.canonicalUrl },
        ...(article.textFingerprint ? [{ textFingerprint: article.textFingerprint }] : []),
      ],
    },
  });

  if (!existing) {
    return prisma.article.create({
      data: {
        canonicalUrl: article.canonicalUrl,
        originalUrl: article.originalUrl,
        textFingerprint: article.textFingerprint,
        title: article.title,
        summary: article.summary,
        contentSnippet: article.contentSnippet,
        publishedAt: article.publishedAt,
        sourceName: article.sourceName,
        domain: article.domain,
        duplicateDomains: [],
        duplicateCount: 0,
        language: article.language,
        category: article.category,
        ingestionDate,
        authorNames: article.authorNames,
        feedSourceId,
      },
    });
  }

  const isSyndicatedDuplicate =
    existing.canonicalUrl !== article.canonicalUrl &&
    existing.textFingerprint !== null &&
    article.textFingerprint !== null &&
    existing.textFingerprint === article.textFingerprint;

  const mergedDomains = isSyndicatedDuplicate
    ? [...new Set([...existing.duplicateDomains, article.domain])]
    : existing.duplicateDomains;

  return prisma.article.update({
    where: { id: existing.id },
    data: {
      textFingerprint: existing.textFingerprint ?? article.textFingerprint,
      title: existing.title.length >= article.title.length ? existing.title : article.title,
      summary: existing.summary ?? article.summary,
      contentSnippet: existing.contentSnippet ?? article.contentSnippet,
      publishedAt: existing.publishedAt ?? article.publishedAt,
      language: existing.language ?? article.language,
      category: existing.category ?? article.category,
      ingestionDate,
      authorNames: [...new Set([...existing.authorNames, ...article.authorNames])],
      feedSourceId: existing.feedSourceId ?? feedSourceId,
      duplicateDomains: mergedDomains,
      duplicateCount: mergedDomains.length,
    },
  });
}

export async function runIngestion(date: string): Promise<{ runId: string; status: RunStatus }> {
  const ingestionDate = startOfDay(date);
  const logger = createFileLogger(`ingestion-${date}.log`);
  const run = await prisma.ingestionRun.upsert({
    where: { ingestionDate },
    update: {
      status: RunStatus.PENDING,
      startedAt: new Date(),
      finishedAt: null,
      errorSummary: Prisma.DbNull,
      articleCount: 0,
      clusterCount: 0,
      feedCount: 0,
    },
    create: {
      ingestionDate,
      status: RunStatus.PENDING,
    },
  });

  const failures: Array<{ feed: string; message: string }> = [];
  let selectedFeeds: Array<{ url: string; category: string | null; sourceName: string | null }> = [];
  let articles: Awaited<ReturnType<typeof prisma.article.findMany>> = [];
  let clusters: Array<{ key: string; title: string; category: string | null; articleIds: string[] }> = [];
  let finalStatus: RunStatus = RunStatus.FAILED;
  let fatalError: Error | null = null;

  logger.info("ingestion started", { runId: run.id, ingestionDate: ingestionDate.toISOString() });

  try {
    const feeds = await fetchFeedCatalog(env.KAGI_KITE_URL);
    selectedFeeds = env.INGEST_FEED_LIMIT ? feeds.slice(0, env.INGEST_FEED_LIMIT) : feeds;
    logger.info("feed catalog loaded", { totalFeeds: feeds.length, selectedFeeds: selectedFeeds.length });

    for (const [feedIndex, feed] of selectedFeeds.entries()) {
      const feedSource = await prisma.feedSource.upsert({
        where: { url: feed.url },
        update: {
          category: feed.category,
          sourceName: feed.sourceName,
        },
        create: {
          url: feed.url,
          category: feed.category,
          sourceName: feed.sourceName,
        },
      });

      logger.info("feed fetch started", {
        feedIndex: feedIndex + 1,
        totalFeeds: selectedFeeds.length,
        feedUrl: feed.url,
        category: feed.category,
      });

      try {
        const parsed = await fetchFeedEntries(feed.url, feed.category, feed.sourceName);
        const fetchRecord = await prisma.feedFetch.upsert({
          where: {
            runId_feedSourceId: {
              runId: run.id,
              feedSourceId: feedSource.id,
            },
          },
          update: {
            ok: true,
            itemCount: parsed.articles.length,
            errorMessage: null,
          },
          create: {
            runId: run.id,
            feedSourceId: feedSource.id,
            ok: true,
            itemCount: parsed.articles.length,
          },
        });

        for (const article of parsed.articles) {
          const saved = await upsertNormalizedArticle(article, ingestionDate, feedSource.id);

          await prisma.articleRaw.create({
            data: {
              articleId: saved.id,
              feedFetchId: fetchRecord.id,
              payload: toInputJson(toJsonSafeArticle(article)),
            },
          });

          const featureSet = buildArticleFeatures(
            saved.title,
            saved.summary,
            saved.contentSnippet,
            saved.language,
          );
          await prisma.nlpFeature.upsert({
            where: {
              id: `${saved.id}-article`,
            },
            update: {
              featureSet: toInputJson({
                ...featureSet,
                aiEnrichmentStatus: "pending",
                aiEnrichmentModel: null,
                aiEnrichmentError: null,
                aiEnrichedAt: null,
              }),
            },
            create: {
              id: `${saved.id}-article`,
              scopeType: ScopeType.ARTICLE,
              articleId: saved.id,
              featureSet: toInputJson({
                ...featureSet,
                aiEnrichmentStatus: "pending",
                aiEnrichmentModel: null,
                aiEnrichmentError: null,
                aiEnrichedAt: null,
              }),
            },
          });
        }

        logger.info("feed fetch completed", {
          feedUrl: feed.url,
          itemCount: parsed.articles.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown feed error";
        failures.push({
          feed: feed.url,
          message,
        });
        logger.warn("feed fetch failed", {
          feedUrl: feed.url,
          message,
        });

        await prisma.feedFetch.upsert({
          where: {
            runId_feedSourceId: {
              runId: run.id,
              feedSourceId: feedSource.id,
            },
          },
          update: {
            ok: false,
            errorMessage: message,
          },
          create: {
            runId: run.id,
            feedSourceId: feedSource.id,
            ok: false,
            errorMessage: message,
          },
        });
      }
    }

    logger.info("clustering started");
    articles = await prisma.article.findMany({
      where: { ingestionDate },
      orderBy: { publishedAt: "desc" },
    });

    await prisma.clusterArticle.deleteMany({
      where: { cluster: { storyDate: ingestionDate } },
    });
    await prisma.storyCluster.deleteMany({
      where: { storyDate: ingestionDate },
    });

    clusters = clusterArticles(
      articles.map((article) => ({
        articleId: article.id,
        title: article.title,
        domain: article.domain,
        category: article.category,
        publishedAt: article.publishedAt,
      })),
    );

    const createdClusterIds: string[] = [];
    for (const [index, cluster] of clusters.entries()) {
      const created = await prisma.storyCluster.create({
        data: {
          clusterKey: cluster.key,
          storyDate: ingestionDate,
          title: cluster.title,
          topCategory: cluster.category,
          articleCount: cluster.articleIds.length,
          sourceCount: new Set(
            articles
              .filter((article) => cluster.articleIds.includes(article.id))
              .flatMap((article) => uniqueDomainsForArticle(article)),
          ).size,
        },
      });

      await prisma.clusterArticle.createMany({
        data: cluster.articleIds.map((articleId, rank) => ({
          clusterId: created.id,
          articleId,
          rank,
          similarity: rank === 0 ? 1 : 0.5,
        })),
      });

      createdClusterIds.push(created.id);

      const clusterArticlesForKeywords = articles.filter((article) =>
        cluster.articleIds.includes(article.id),
      );

      const fallbackKeywords = buildClusterKeywordFallback(
        clusterArticlesForKeywords.map((article) => {
          const articleFeature = buildArticleFeatures(
            article.title,
            article.summary,
            article.fullText ?? article.contentSnippet,
            article.language,
          );
          return {
            title: article.title,
            summary: article.summary,
            body: article.fullText ?? article.contentSnippet,
            language: article.language,
            keywords: articleFeature.keywordsEnglish,
          };
        }),
      );

      await prisma.nlpFeature.create({
        data: {
          scopeType: ScopeType.CLUSTER,
          clusterId: created.id,
          featureSet: toInputJson({
            order: index,
            keywords: fallbackKeywords,
            keywordSource: "openrouter",
            keywordStatus: "keywords_pending",
            keywordModel: null,
            keywordError: null,
          }),
        },
      });
    }

    logger.info("clustering completed", { articleCount: articles.length, clusterCount: clusters.length });

    const sourceStats = new Map<
      string,
      { sourceName: string; count: number; sentimentSum: number; biasSignals: Set<string> }
    >();

    for (const article of articles) {
      const feature = await prisma.nlpFeature.findFirst({
        where: { articleId: article.id, scopeType: ScopeType.ARTICLE },
      });
      const payload = feature?.featureSet as { sentiment?: number; biasSignals?: string[] } | undefined;
      const current = sourceStats.get(article.domain) ?? {
        sourceName: article.sourceName,
        count: 0,
        sentimentSum: 0,
        biasSignals: new Set<string>(),
      };
      current.count += 1;
      current.sentimentSum += payload?.sentiment ?? 0;
      for (const signal of payload?.biasSignals ?? []) {
        current.biasSignals.add(signal);
      }
      sourceStats.set(article.domain, current);
    }
    await upsertSourceProfiles(sourceStats, { incremental: false, enrichMetadata: false });

    // Perspective intelligence: compute divergence + framing for each cluster
    // produced this run. Best-effort — sidecar outage or per-cluster failure
    // logs and continues, never breaks the ingestion run. No LLM narrative
    // and no LLM country resolver here (both are explicit batch scripts).
    if (createdClusterIds.length > 0) {
      try {
        const { computeClusterPerspective } = await import("./cluster-perspective.js");
        let ok = 0;
        let fail = 0;
        for (const clusterId of createdClusterIds) {
          try {
            await computeClusterPerspective(clusterId, { generateNarrative: false });
            ok += 1;
          } catch (err) {
            fail += 1;
            logger.warn("perspective compute failed", {
              clusterId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        logger.info("perspective compute completed", {
          ok,
          fail,
          total: createdClusterIds.length,
        });
      } catch (err) {
        logger.warn("perspective stage skipped", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    finalStatus =
      failures.length === 0
        ? RunStatus.SUCCESS
        : failures.length < selectedFeeds.length
          ? RunStatus.PARTIAL
          : RunStatus.FAILED;
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error("Unknown ingestion error");
    failures.push({
      feed: "__runtime__",
      message: fatalError.message,
    });
    finalStatus = articles.length > 0 || failures.length > 1 ? RunStatus.PARTIAL : RunStatus.FAILED;
    logger.error("ingestion aborted", { message: fatalError.message, stack: fatalError.stack });
  } finally {
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        feedCount: selectedFeeds.length,
        articleCount: articles.length,
        clusterCount: clusters.length,
        errorSummary: failures.length ? toInputJson(failures) : Prisma.DbNull,
      },
    });

    logger.info("ingestion finished", {
      runId: run.id,
      status: finalStatus,
      feedCount: selectedFeeds.length,
      articleCount: articles.length,
      clusterCount: clusters.length,
      failureCount: failures.length,
    });
  }

  if (fatalError) {
    throw fatalError;
  }

  return { runId: run.id, status: finalStatus };
}
