import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ScopeType } from "@prisma/client";
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { extractRegion } from "../domain/category.js";

type FeaturePayload = {
  keywords?: unknown;
  sentiment?: unknown;
  subjectivity?: unknown;
  biasSignals?: unknown;
  keywordStatus?: unknown;
  keywordSource?: unknown;
  keywordModel?: unknown;
  keywordError?: unknown;
};

function parseDateArg(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}. Expected YYYY-MM-DD.`);
  }
  return parsed;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function getClusterDateRange(
  storyDate: Date,
  articleDates: Array<Date | null | undefined>,
): { dateFrom: string; dateUntil: string } {
  const valid = articleDates.filter((item): item is Date => item instanceof Date && !Number.isNaN(item.getTime()));
  if (valid.length === 0) {
    const date = toIsoDate(storyDate);
    return { dateFrom: date, dateUntil: date };
  }
  const min = new Date(Math.min(...valid.map((item) => item.getTime())));
  const max = new Date(Math.max(...valid.map((item) => item.getTime())));
  return { dateFrom: toIsoDate(min), dateUntil: toIsoDate(max) };
}

function buildAnalysisText(parts: Array<string | null | undefined>): string {
  return parts.filter((item): item is string => Boolean(item && item.trim())).join("\n\n").trim();
}

async function main() {
  const dateArg = process.argv[2];
  const outputArg = process.argv[3];
  const dateFilter = parseDateArg(dateArg);
  const outputFile = outputArg
    ? resolve(process.cwd(), outputArg)
    : resolve(process.cwd(), "..", "..", "notebooks", "news.jsonl");

  const clusters = dateFilter
    ? await prisma.storyCluster.findMany({
        where: { storyDate: dateFilter },
        orderBy: [{ storyDate: "desc" }, { createdAt: "desc" }],
        include: {
          features: {
            where: { scopeType: ScopeType.CLUSTER },
            orderBy: { updatedAt: "desc" },
            take: 1,
          },
          articles: {
            orderBy: { rank: "asc" },
            include: {
              article: {
                include: {
                  features: {
                    where: { scopeType: ScopeType.ARTICLE },
                    orderBy: { updatedAt: "desc" },
                    take: 1,
                  },
                  entityMentions: {
                    include: { entity: true },
                  },
                },
              },
            },
          },
        },
      })
    : await prisma.storyCluster.findMany({
        orderBy: [{ storyDate: "desc" }, { createdAt: "desc" }],
        include: {
          features: {
            where: { scopeType: ScopeType.CLUSTER },
            orderBy: { updatedAt: "desc" },
            take: 1,
          },
          articles: {
            orderBy: { rank: "asc" },
            include: {
              article: {
                include: {
                  features: {
                    where: { scopeType: ScopeType.ARTICLE },
                    orderBy: { updatedAt: "desc" },
                    take: 1,
                  },
                  entityMentions: {
                    include: { entity: true },
                  },
                },
              },
            },
          },
        },
      });

  const rows: Array<Record<string, unknown>> = [];

  for (const cluster of clusters) {
    const clusterFeature = (cluster.features[0]?.featureSet ?? {}) as FeaturePayload;
    const clusterKeywords = parseStringArray(clusterFeature.keywords);
    const clusterKeywordStatus = asString(clusterFeature.keywordStatus) ?? "unknown";
    const clusterKeywordSource = asString(clusterFeature.keywordSource) ?? "unknown";
    const clusterKeywordModel = asString(clusterFeature.keywordModel);
    const clusterKeywordError = asString(clusterFeature.keywordError);
    const clusterDates = getClusterDateRange(
      cluster.storyDate,
      cluster.articles.map((item) => item.article.publishedAt),
    );

    for (const link of cluster.articles) {
      const article = link.article;
      const articleFeature = (article.features[0]?.featureSet ?? {}) as FeaturePayload;
      const articleKeywords = parseStringArray(articleFeature.keywords);
      const fullText = article.fullText;

      const entityCounts = new Map<string, {
        entity_id: string;
        text: string;
        type: string;
        wikipedia_url: string | null;
        count: number;
      }>();
      for (const mention of article.entityMentions) {
        const key = mention.entity.id;
        const existing = entityCounts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          entityCounts.set(key, {
            entity_id: mention.entity.id,
            text: mention.entity.name,
            type: mention.entity.type,
            wikipedia_url: mention.entity.wikipediaUrl ?? null,
            count: 1,
          });
        }
      }
      const entities = Array.from(entityCounts.values()).sort((a, b) => b.count - a.count);
      const analysisText = buildAnalysisText([
        article.title,
        fullText,
        article.contentSnippet,
        article.summary,
      ]);

      rows.push({
        cluster_id: cluster.id,
        cluster_key: cluster.clusterKey,
        cluster_title: cluster.title,
        cluster_source_count: cluster.sourceCount,
        cluster_article_count: cluster.articleCount,
        cluster_keywords: clusterKeywords,
        cluster_keyword_status: clusterKeywordStatus,
        cluster_keyword_source: clusterKeywordSource,
        cluster_keyword_model: clusterKeywordModel,
        cluster_keyword_error: clusterKeywordError,
        date: toIsoDate(cluster.storyDate),
        date_from: clusterDates.dateFrom,
        date_until: clusterDates.dateUntil,
        category: cluster.topCategory,
        region: extractRegion(cluster.topCategory),
        article_id: article.id,
        article_title: article.title,
        url: article.canonicalUrl,
        original_url: article.originalUrl,
        final_url: article.canonicalUrl,
        domain: article.domain,
        source_name: article.sourceName,
        published_at: article.publishedAt?.toISOString() ?? null,
        summary: article.summary,
        content_snippet: article.contentSnippet,
        full_text: fullText,
        text_extraction_status: article.extractionStatus,
        extraction_error: article.extractionError,
        full_text_available: Boolean(fullText && fullText.trim().length > 0),
        keywords: articleKeywords,
        sentiment: asNumber(articleFeature.sentiment, 0),
        subjectivity: asNumber(articleFeature.subjectivity, 0),
        bias_signals: parseStringArray(articleFeature.biasSignals),
        analysis_text: analysisText,
        entities,
      });
    }
  }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        dateFilter: dateArg ?? null,
        clusterCount: clusters.length,
        articleCount: rows.length,
        outputFile,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
