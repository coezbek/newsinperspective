import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { glob } from "node:fs/promises";
import { dirname } from "node:path";
import { stat } from "node:fs/promises";
import { ExtractionStatus, Prisma, ScopeType } from "@prisma/client";
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { startOfUtcDay } from "../lib/runtime-date.js";
import { buildArticleFeatures, buildClusterKeywordFallback } from "../services/nlp.js";
import { buildTextFingerprint } from "../domain/fingerprint.js";
import { upsertSourceProfiles } from "../services/source-profiles.js";
import {
  buildSoftDedupePlan,
  DedupeDocumentInput,
  resolveDedupeStrategy,
} from "../services/dedupe.js";

interface ExportedClusterSource {
  title: string;
  link: string;
  domain: string;
  date?: string | undefined;
  extractionStatus?: string | undefined;
  extractionError?: string | null | undefined;
  fullText?: string | null | undefined;
  fullTextLength?: number | undefined;
  extractionFormat?: string | null | undefined;
  originalUrl?: string | undefined;
  finalUrl?: string | undefined;
}

interface ExportedClusterFile {
  generatedAt?: string | undefined;
  snapshotDate?: string | undefined;
  chosenCluster: {
    storyId: string;
    clusterNumber?: number | undefined;
    title: string;
    categoryName?: string | undefined;
    shortSummary?: string | undefined;
    sourceCount?: number | undefined;
    articleCount?: number | undefined;
  };
  sources: ExportedClusterSource[];
}

interface ClusterFileSelection {
  mode: "latest-batch" | "all" | "path";
  clusterFiles: string[];
  selectedRoot: string | null;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function parseUnitFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function normalizeExtractionStatus(value: string | undefined): ExtractionStatus {
  if (value === "SUCCESS") return ExtractionStatus.SUCCESS;
  if (value === "FAILED") return ExtractionStatus.FAILED;
  return ExtractionStatus.PENDING;
}

function buildAnalysisText(source: ExportedClusterSource): string {
  return [source.title, source.fullText].filter((value): value is string => Boolean(value && value.trim())).join("\n\n");
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function listClusterFiles(): Promise<string[]> {
  const roots = [
    resolve(process.cwd(), "notebooks", "exports"),
    resolve(process.cwd(), "apps", "api", "notebooks", "exports"),
  ];

  const files = new Set<string>();

  for (const root of roots) {
    try {
      for await (const file of glob("**/cluster.json", { cwd: root })) {
        files.add(resolve(root, file));
      }
    } catch {}
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

async function selectClusterFiles(arg: string | undefined): Promise<ClusterFileSelection> {
  const modeArg = arg?.trim();

  if (modeArg && modeArg !== "--all") {
    const target = resolve(process.cwd(), modeArg);
    const targetStat = await stat(target).catch(() => null);
    if (!targetStat) {
      throw new Error(`Path not found: ${target}`);
    }

    if (targetStat.isFile()) {
      if (!target.endsWith("cluster.json")) {
        throw new Error(`Expected a cluster.json file, got: ${target}`);
      }
      return {
        mode: "path",
        clusterFiles: [target],
        selectedRoot: target,
      };
    }

    const files = new Set<string>();
    for await (const file of glob("**/cluster.json", { cwd: target })) {
      files.add(resolve(target, file));
    }
    const clusterFiles = [...files].sort((left, right) => left.localeCompare(right));
    return {
      mode: "path",
      clusterFiles,
      selectedRoot: target,
    };
  }

  const allFiles = await listClusterFiles();
  if (allFiles.length === 0) {
    return {
      mode: modeArg === "--all" ? "all" : "latest-batch",
      clusterFiles: [],
      selectedRoot: null,
    };
  }

  if (modeArg === "--all") {
    return {
      mode: "all",
      clusterFiles: allFiles,
      selectedRoot: null,
    };
  }

  const withMeta = await Promise.all(
    allFiles.map(async (file) => ({
      file,
      mtimeMs: (await stat(file)).mtimeMs,
    })),
  );
  withMeta.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latestFile = withMeta[0]?.file;
  if (!latestFile) {
    return {
      mode: "latest-batch",
      clusterFiles: [],
      selectedRoot: null,
    };
  }

  const latestBatchDir = dirname(dirname(latestFile));
  const batchFiles = new Set<string>();
  for await (const file of glob("**/cluster.json", { cwd: latestBatchDir })) {
    batchFiles.add(resolve(latestBatchDir, file));
  }
  const clusterFiles = [...batchFiles].sort((left, right) => left.localeCompare(right));
  return {
    mode: "latest-batch",
    clusterFiles,
    selectedRoot: latestBatchDir,
  };
}

async function main() {
  const selection = await selectClusterFiles(process.argv[2]);
  const clusterFiles = selection.clusterFiles;

  if (clusterFiles.length === 0) {
    throw new Error("No saved Kagi cluster exports found.");
  }

  console.log(
    `[kagi:import-clusters] mode=${selection.mode}${selection.selectedRoot ? ` source=${selection.selectedRoot}` : ""}`,
  );
  console.log(`[kagi:import-clusters] files=${clusterFiles.length}`);

  let importedClusters = 0;
  let importedArticles = 0;

  for (const [clusterIndex, clusterPath] of clusterFiles.entries()) {
    const payload = JSON.parse(await readFile(clusterPath, "utf8")) as ExportedClusterFile;
    console.log(
      `[kagi:import-clusters] cluster ${clusterIndex + 1}/${clusterFiles.length} ${payload.chosenCluster.title}`,
    );
    const generatedAt = parseDate(payload.generatedAt, new Date());
    const snapshotDate = payload.snapshotDate
      ? startOfUtcDay(payload.snapshotDate)
      : startOfUtcDay(toIsoDate(generatedAt));
    const category = payload.chosenCluster.categoryName ?? null;

    const cluster = await prisma.storyCluster.upsert({
      where: {
        clusterKey_storyDate: {
          clusterKey: payload.chosenCluster.storyId,
          storyDate: snapshotDate,
        },
      },
      update: {
        title: payload.chosenCluster.title,
        topCategory: category,
      },
      create: {
        clusterKey: payload.chosenCluster.storyId,
        storyDate: snapshotDate,
        title: payload.chosenCluster.title,
        topCategory: category,
      },
    });

    const articleIds: string[] = [];
    const dedupeInputs: DedupeDocumentInput[] = [];
    const duplicateDomainsByArticleId = new Map<string, string[]>();
    const sourceStats = new Map<string, {
      sourceName: string;
      count: number;
      sentimentSum: number;
      biasSignals: Set<string>;
    }>();

    for (const source of payload.sources) {
      const originalUrl = source.originalUrl ?? source.link;
      const canonicalUrl = source.finalUrl ?? originalUrl;
      const publishedAt = source.date ? new Date(source.date) : null;
      const extractionStatus = normalizeExtractionStatus(source.extractionStatus);

      const article = await prisma.article.upsert({
        where: { canonicalUrl },
        update: {
          originalUrl,
          title: source.title,
          summary: null,
          contentSnippet: null,
          fullText: source.fullText ?? null,
          fullTextFormat: source.extractionFormat ?? null,
          extractionStatus,
          extractedAt: extractionStatus === ExtractionStatus.SUCCESS ? generatedAt : null,
          extractionError: source.extractionError ?? null,
          publishedAt,
          sourceName: source.domain,
          domain: source.domain,
          category,
          ingestionDate: snapshotDate,
        },
        create: {
          canonicalUrl,
          originalUrl,
          textFingerprint: source.fullText
            ? buildTextFingerprint(source.title, source.fullText)
            : null,
          title: source.title,
          summary: null,
          contentSnippet: null,
          fullText: source.fullText ?? null,
          fullTextFormat: source.extractionFormat ?? null,
          extractionStatus,
          extractedAt: extractionStatus === ExtractionStatus.SUCCESS ? generatedAt : null,
          extractionError: source.extractionError ?? null,
          publishedAt,
          sourceName: source.domain,
          domain: source.domain,
          duplicateDomains: [],
          duplicateCount: 0,
          language: null,
          category,
          ingestionDate: snapshotDate,
          authorNames: [],
        },
      });

      articleIds.push(article.id);
      duplicateDomainsByArticleId.set(article.id, article.duplicateDomains);
      dedupeInputs.push({
        id: article.id,
        domain: source.domain,
        title: source.title,
        summary: null,
        body: source.fullText ?? buildAnalysisText(source),
        language: article.language,
      });

      const featureSet = buildArticleFeatures(
        source.title,
        source.fullText ?? null,
        source.fullText ? null : buildAnalysisText(source),
        null,
      );
      const sourceKey = source.domain.trim().toLowerCase();
      const sourceEntry = sourceStats.get(sourceKey) ?? {
        sourceName: source.domain,
        count: 0,
        sentimentSum: 0,
        biasSignals: new Set<string>(),
      };
      sourceEntry.count += 1;
      sourceEntry.sentimentSum += featureSet.sentiment;
      for (const signal of featureSet.biasSignals) {
        sourceEntry.biasSignals.add(signal);
      }
      sourceStats.set(sourceKey, sourceEntry);

      await prisma.nlpFeature.upsert({
        where: {
          id: `${article.id}-article`,
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
          id: `${article.id}-article`,
          scopeType: ScopeType.ARTICLE,
          articleId: article.id,
          featureSet: toInputJson({
            ...featureSet,
            aiEnrichmentStatus: "pending",
            aiEnrichmentModel: null,
            aiEnrichmentError: null,
            aiEnrichedAt: null,
          }),
        },
      });

      importedArticles += 1;
    }

    await prisma.clusterArticle.deleteMany({
      where: { clusterId: cluster.id },
    });

    if (articleIds.length > 0) {
      await prisma.clusterArticle.createMany({
        data: articleIds.map((articleId, index) => ({
          clusterId: cluster.id,
          articleId,
          rank: index + 1,
          similarity: 1,
        })),
        skipDuplicates: true,
      });
    }

    await prisma.storyCluster.update({
      where: { id: cluster.id },
      data: {
        articleCount: articleIds.length,
        sourceCount: new Set(
          payload.sources
            .map((source) => source.domain)
            .filter((value): value is string => Boolean(value)),
        ).size,
      },
    });

    const dedupePlan = buildSoftDedupePlan(dedupeInputs, {
      strategy: resolveDedupeStrategy(process.env.KAGI_DEDUPE_STRATEGY),
      mirrorDomainsOnAllMembers: true,
      simHashMinJaccardSimilarity: parseUnitFloat(process.env.KAGI_DEDUPE_SIMHASH_MIN_JACCARD, 0.9),
    });
    for (const update of dedupePlan.updates) {
      if (update.duplicateDomains.length === 0) continue;
      const existingDomains = duplicateDomainsByArticleId.get(update.id) ?? [];
      const mergedDomains = [...new Set([...existingDomains, ...update.duplicateDomains])].sort((a, b) =>
        a.localeCompare(b),
      );
      await prisma.article.update({
        where: { id: update.id },
        data: {
          duplicateDomains: mergedDomains,
          duplicateCount: mergedDomains.length,
        },
      });
    }
    console.log(
      `[kagi:import-clusters] dedupe strategy=${dedupePlan.strategy} groups=${dedupePlan.groupCount} matchedArticles=${dedupePlan.matchedArticleCount}`,
    );

    const clusterKeywordFallback = buildClusterKeywordFallback(
      payload.sources.map((source) => ({
        title: source.title,
        summary: source.fullText ?? null,
        body: source.fullText ?? null,
        language: null,
      })),
    );
    console.log("[kagi:import-clusters] keywords deferred -> keywords_pending");

    const existingClusterFeature = await prisma.nlpFeature.findFirst({
      where: {
        clusterId: cluster.id,
        scopeType: ScopeType.CLUSTER,
      },
      select: { id: true },
    });

    if (existingClusterFeature) {
      await prisma.nlpFeature.update({
        where: { id: existingClusterFeature.id },
        data: {
          featureSet: toInputJson({
            keywords: clusterKeywordFallback,
            keywordSource: "openrouter",
            keywordStatus: "keywords_pending",
            keywordModel: null,
            keywordError: null,
            dedupeStrategy: dedupePlan.strategy,
            dedupeGroupCount: dedupePlan.groupCount,
            dedupeMatchedArticleCount: dedupePlan.matchedArticleCount,
            kagiClusterNumber: payload.chosenCluster.clusterNumber ?? null,
          }),
        },
      });
    } else {
      await prisma.nlpFeature.create({
        data: {
          scopeType: ScopeType.CLUSTER,
          clusterId: cluster.id,
          featureSet: toInputJson({
            keywords: clusterKeywordFallback,
            keywordSource: "openrouter",
            keywordStatus: "keywords_pending",
            keywordModel: null,
            keywordError: null,
            dedupeStrategy: dedupePlan.strategy,
            dedupeGroupCount: dedupePlan.groupCount,
            dedupeMatchedArticleCount: dedupePlan.matchedArticleCount,
            kagiClusterNumber: payload.chosenCluster.clusterNumber ?? null,
          }),
        },
      });
    }

    await upsertSourceProfiles(sourceStats, { incremental: true, enrichMetadata: false });

    importedClusters += 1;
  }

  console.log(
    JSON.stringify(
      {
        importedClusters,
        importedArticles,
        clusterFiles: clusterFiles.length,
        mode: selection.mode,
        selectedRoot: selection.selectedRoot,
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
