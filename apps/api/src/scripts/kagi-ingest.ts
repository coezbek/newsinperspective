import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ExtractionStatus, Prisma, ScopeType } from "@prisma/client";
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getCurrentDateString, startOfUtcDay } from "../lib/runtime-date.js";
import { closeArticleExtractionBrowser, extractArticleTextFromUrl } from "../services/article-text.js";
import {
  KagiCategoryFetchProgress,
  closeKagiBrowser,
  listClustersForIngestion,
} from "../services/kagi-news.js";
import { buildArticleFeatures, buildClusterKeywordFallback } from "../services/nlp.js";
import { upsertSourceProfiles } from "../services/source-profiles.js";
import {
  buildSoftDedupePlan,
  DedupeDocumentInput,
  resolveDedupeStrategy,
} from "../services/dedupe.js";

interface IngestedSource {
  title: string;
  link: string;
  domain: string;
  date?: string | undefined;
  originalUrl: string;
  finalUrl: string;
  extractionStatus: "SUCCESS" | "FAILED";
  extractionError: string | null;
  fullText: string | null;
  fullTextLength: number;
  extractionFormat: string | null;
}

interface ClusterSourceInput {
  title: string;
  link: string;
  domain: string;
  date?: string | undefined;
}

interface IngestedClusterPayload {
  generatedAt: string;
  snapshotDate?: string;
  selection: {
    globalLimit: number;
    perCategoryLimit: number;
    requiredCategories: string[];
  };
  rank: number;
  chosenCluster: {
    batchId: string;
    categoryId: string;
    categoryUuid: string;
    categoryName: string;
    storyId: string;
    clusterNumber: number;
    title: string;
    shortSummary: string;
    sourceCount: number;
    articleCount: number;
  };
  sources: IngestedSource[];
}

interface FailedUrlRecord {
  rank: number;
  storyId: string;
  storyTitle: string;
  categoryName: string;
  domain: string;
  originalUrl: string;
  finalUrl: string;
  error: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseUnitFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderProgress(
  label: string,
  current: number,
  total: number,
  startedAt: number,
  suffix = "",
): void {
  const boundedCurrent = Math.min(Math.max(current, 0), Math.max(total, 1));
  const ratio = total > 0 ? boundedCurrent / total : 0;
  const width = 24;
  const filled = Math.round(width * ratio);
  const bar = `${"=".repeat(Math.max(0, filled - 1))}${filled > 0 && filled < width ? ">" : "="}${".".repeat(
    Math.max(0, width - filled),
  )}`;
  const elapsedMs = Date.now() - startedAt;
  const elapsedSeconds = elapsedMs / 1000;
  const rate = elapsedSeconds > 0 ? boundedCurrent / elapsedSeconds : 0;
  const remaining = Math.max(0, total - boundedCurrent);
  const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
  const line =
    `${label.padEnd(16)} ${String(boundedCurrent).padStart(3)}/${String(total).padEnd(3)} ` +
    `[${bar}] ${formatDuration(elapsedMs)}<${formatDuration(etaMs)} ` +
    `${rate.toFixed(2)}/s ${suffix}`.trimEnd();

  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line.padEnd(160)}`);
  } else if (boundedCurrent === total || boundedCurrent === 1 || boundedCurrent % 5 === 0) {
    console.log(line);
  }
}

function finishProgressLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
}

function printEvent(message: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  console.log(message);
}

function renderCategoryProgress(progress: KagiCategoryFetchProgress, startedAt: number): void {
  if (progress.status === "start") {
    if (!process.stdout.isTTY) {
      console.log(`categories: ${progress.current}/${progress.total} ${progress.categoryName}`);
    }
    return;
  }

  const suffix =
    progress.status === "done"
      ? `${progress.categoryName} (${progress.storyCount ?? 0} stories)`
      : `${progress.categoryName} (error)`;
  renderProgress("categories", progress.current, progress.total, startedAt, suffix);
  if (progress.current >= progress.total) {
    finishProgressLine();
  }
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizeExtractionStatus(value: string | undefined): ExtractionStatus {
  if (value === "SUCCESS") return ExtractionStatus.SUCCESS;
  if (value === "FAILED") return ExtractionStatus.FAILED;
  return ExtractionStatus.PENDING;
}

function buildAnalysisText(source: IngestedSource): string {
  return [source.title, source.fullText].filter((value): value is string => Boolean(value && value.trim())).join("\n\n");
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeErrorMessage(error: string): string {
  const firstLine = error.split("\n")[0] ?? error;
  return firstLine.trim().slice(0, 220);
}

function isRetryableExtractionError(error: string): boolean {
  return /timeout|net::err_|econnreset|etimedout|temporarily unavailable|server refused stream/i.test(error);
}

function extractionBackoffMs(attempt: number): number {
  const schedule = [5_000, 15_000, 60_000];
  const base = schedule[attempt] ?? schedule.at(-1) ?? 5_000;
  const jitter = Math.floor(Math.random() * 1_500);
  return base + jitter;
}

async function extractSourceWithRetries(
  article: ClusterSourceInput,
  options: {
    maxRetries: number;
    onRetry?: (attempt: number, delayMs: number, error: string) => void;
  },
): Promise<IngestedSource> {
  let lastError = "unknown extraction failure";

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      const extracted = await extractArticleTextFromUrl(article.link);
      return {
        ...article,
        originalUrl: extracted.originalUrl,
        finalUrl: extracted.finalUrl,
        extractionStatus: "SUCCESS",
        extractionError: null,
        fullText: extracted.text,
        fullTextLength: extracted.text.length,
        extractionFormat: extracted.format,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const canRetry = attempt < options.maxRetries && isRetryableExtractionError(lastError);
      if (canRetry) {
        const delayMs = extractionBackoffMs(attempt);
        options.onRetry?.(attempt + 1, delayMs, lastError);
        await sleep(delayMs);
        continue;
      }

      return {
        ...article,
        originalUrl: article.link,
        finalUrl: article.link,
        extractionStatus: "FAILED",
        extractionError: lastError,
        fullText: null,
        fullTextLength: 0,
        extractionFormat: null,
      };
    }
  }

  return {
    ...article,
    originalUrl: article.link,
    finalUrl: article.link,
    extractionStatus: "FAILED",
    extractionError: lastError,
    fullText: null,
    fullTextLength: 0,
    extractionFormat: null,
  };
}

async function extractClusterSources(
  params: {
    clusterRank: number;
    clusterCount: number;
    storyId: string;
    storyTitle: string;
    categoryName: string;
    articles: ClusterSourceInput[];
    maxConcurrent: number;
    perDomainConcurrent: number;
    maxRetries: number;
  },
): Promise<{
  sources: IngestedSource[];
  failedUrls: FailedUrlRecord[];
}> {
  const sourceProgressStartedAt = Date.now();
  const sources: IngestedSource[] = new Array(params.articles.length);
  const failedUrls: FailedUrlRecord[] = [];
  let sourceDone = 0;
  let sourceSuccess = 0;
  let sourceFailed = 0;

  const pending = params.articles.map((_, index) => index);
  const inFlight = new Set<Promise<void>>();
  const domainActive = new Map<string, number>();

  const normalizeDomain = (domain: string): string => domain.trim().toLowerCase();

  const pickNextPendingIndex = (): number => {
    for (let position = 0; position < pending.length; position += 1) {
      const index = pending[position]!;
      const article = params.articles[index]!;
      const domainKey = normalizeDomain(article.domain || "unknown");
      const activeForDomain = domainActive.get(domainKey) ?? 0;
      if (activeForDomain < params.perDomainConcurrent) {
        pending.splice(position, 1);
        return index;
      }
    }
    return -1;
  };

  const launchOne = (): boolean => {
    if (inFlight.size >= params.maxConcurrent) return false;
    const nextIndex = pickNextPendingIndex();
    if (nextIndex < 0) return false;

    const article = params.articles[nextIndex]!;
    const domainKey = normalizeDomain(article.domain || "unknown");
    domainActive.set(domainKey, (domainActive.get(domainKey) ?? 0) + 1);

    let task: Promise<void>;
    task = (async () => {
      const result = await extractSourceWithRetries(article, {
        maxRetries: params.maxRetries,
        onRetry: (attempt, delayMs, error) => {
          printEvent(
            `[kagi:ingest] retry ${attempt}/${params.maxRetries} ${article.link} after ${Math.ceil(
              delayMs / 1000,
            )}s :: ${summarizeErrorMessage(error)}`,
          );
        },
      });
      sources[nextIndex] = result;

      if (result.extractionStatus === "SUCCESS") {
        sourceSuccess += 1;
      } else {
        sourceFailed += 1;
        const errorMessage = result.extractionError ?? "unknown extraction failure";
        failedUrls.push({
          rank: params.clusterRank,
          storyId: params.storyId,
          storyTitle: params.storyTitle,
          categoryName: params.categoryName,
          domain: article.domain,
          originalUrl: article.link,
          finalUrl: result.finalUrl,
          error: summarizeErrorMessage(errorMessage),
        });
        printEvent(
          `[kagi:ingest] failed ${article.domain} ${article.link} :: ${summarizeErrorMessage(errorMessage)}`,
        );
      }

      sourceDone += 1;
      renderProgress(
        `sources ${params.clusterRank}/${params.clusterCount}`,
        sourceDone,
        params.articles.length,
        sourceProgressStartedAt,
        `ok ${sourceSuccess} fail ${sourceFailed}`,
      );
      if (sourceDone === params.articles.length) {
        finishProgressLine();
      }
    })().finally(() => {
      inFlight.delete(task);
      const nextActive = (domainActive.get(domainKey) ?? 1) - 1;
      if (nextActive <= 0) {
        domainActive.delete(domainKey);
      } else {
        domainActive.set(domainKey, nextActive);
      }
    });

    inFlight.add(task);
    return true;
  };

  while (pending.length > 0 || inFlight.size > 0) {
    let launched = false;
    while (launchOne()) {
      launched = true;
    }

    if (inFlight.size === 0) {
      break;
    }

    if (!launched && pending.length > 0) {
      await Promise.race(inFlight);
      continue;
    }

    await Promise.race(inFlight);
  }

  return {
    sources,
    failedUrls,
  };
}

async function importClusterPayload(payload: IngestedClusterPayload): Promise<{
  importedArticles: number;
  keywordSource: "openrouter";
  keywordStatus: "ready" | "keywords_pending";
  keywordModel: string | null;
  keywordError: string | null;
  dedupeStrategy: "simhash" | "jaccard";
  dedupeGroupCount: number;
  dedupeMatchedArticleCount: number;
}> {
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
  let importedArticles = 0;

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
        textFingerprint: null,
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
  printEvent(
    `[kagi:ingest][dedupe] strategy=${dedupePlan.strategy} groups=${dedupePlan.groupCount} matchedArticles=${dedupePlan.matchedArticleCount}`,
  );

  const clusterKeywordFallback = buildClusterKeywordFallback(
    payload.sources.map((source) => ({
      title: source.title,
      summary: source.fullText ?? null,
      body: source.fullText ?? null,
      language: null,
    })),
  );

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
          kagiClusterNumber: payload.chosenCluster.clusterNumber,
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
          kagiClusterNumber: payload.chosenCluster.clusterNumber,
        }),
      },
    });
  }

  await upsertSourceProfiles(sourceStats, { incremental: true, enrichMetadata: false });

  return {
    importedArticles,
    keywordSource: "openrouter",
    keywordStatus: "keywords_pending",
    keywordModel: null,
    keywordError: null,
    dedupeStrategy: dedupePlan.strategy,
    dedupeGroupCount: dedupePlan.groupCount,
    dedupeMatchedArticleCount: dedupePlan.matchedArticleCount,
  };
}

async function main() {
  const globalLimit = parsePositiveInt(process.argv[2], 10);
  const perCategoryLimit = parsePositiveInt(process.argv[3], 5);
  const extractionConcurrency = parsePositiveInt(process.env.KAGI_INGEST_EXTRACTION_CONCURRENCY, 8);
  const extractionPerDomainConcurrency = parsePositiveInt(process.env.KAGI_INGEST_EXTRACTION_PER_DOMAIN_CONCURRENCY, 2);
  const extractionMaxRetries = parseNonNegativeInt(process.env.KAGI_INGEST_EXTRACTION_RETRIES, 1);
  const requiredCategories = parseCsv(process.argv[4], [
    "World",
    "USA",
    "Business",
    "Technology",
    "Sports",
    "Science",
    "Gaming",
  ]);
  const snapshotDate = process.argv[5] ?? getCurrentDateString();

  console.log("Selecting clusters from Kagi...");
  console.log(
    `Extraction settings: concurrency=${extractionConcurrency}, perDomain=${extractionPerDomainConcurrency}, retries=${extractionMaxRetries}`,
  );
  const categoryProgressStartedAt = Date.now();
  const selection = await listClustersForIngestion({
    globalLimit,
    perCategoryLimit,
    requiredCategories,
    onStageMessage: (message) => {
      console.log(message);
    },
    onCategoryFetchProgress: (progress) => {
      renderCategoryProgress(progress, categoryProgressStartedAt);
    },
  });
  const selected = selection.clusters;

  if (selected.length === 0) {
    throw new Error("No clusters returned from Kagi API");
  }

  const missingCoverage = selection.coverage.filter((item) => item.selectedCount === 0);
  if (missingCoverage.length > 0) {
    console.log(
      `Coverage warnings: ${missingCoverage
        .map((item) => `${item.requestedCategory}${item.matchedCategory ? `->${item.matchedCategory}` : ""}`)
        .join(", ")}`,
    );
  }

  const baseDir = resolve(process.cwd(), "notebooks", "exports", "kagi-top", snapshotDate);
  await mkdir(baseDir, { recursive: true });

  const results: Array<{
    exportDir: string;
    rank: number;
    storyId: string;
    title: string;
    articleCount: number;
    successfulExtractions: number;
    failedExtractions: number;
    importedArticles: number;
    keywordSource: "openrouter";
    keywordStatus: "ready" | "keywords_pending";
    keywordModel: string | null;
    keywordError: string | null;
    dedupeStrategy: "simhash" | "jaccard";
    dedupeGroupCount: number;
    dedupeMatchedArticleCount: number;
  }> = [];
  let importedClusters = 0;
  let importedArticles = 0;
  let keywordReadyClusters = 0;
  let keywordPendingClusters = 0;
  let dedupeGroupsTotal = 0;
  let dedupeMatchedArticlesTotal = 0;
  const failedUrls: FailedUrlRecord[] = [];
  const clusterProgressStartedAt = Date.now();

  for (const [index, chosen] of selected.entries()) {
    console.log("");
    console.log(`[cluster ${index + 1}/${selected.length}] ${chosen.categoryName} · ${chosen.story.title}`);
    const exportDir = resolve(baseDir, `${index + 1}-${slugify(chosen.story.title)}`);
    await mkdir(exportDir, { recursive: true });

    const extracted = await extractClusterSources({
      clusterRank: index + 1,
      clusterCount: selected.length,
      storyId: chosen.story.id,
      storyTitle: chosen.story.title,
      categoryName: chosen.categoryName,
      articles: chosen.story.articles,
      maxConcurrent: extractionConcurrency,
      perDomainConcurrent: extractionPerDomainConcurrency,
      maxRetries: extractionMaxRetries,
    });
    const sources = extracted.sources;
    failedUrls.push(...extracted.failedUrls);

    const payload: IngestedClusterPayload = {
      generatedAt: new Date().toISOString(),
      snapshotDate,
      selection: {
        globalLimit,
        perCategoryLimit,
        requiredCategories,
      },
      rank: index + 1,
      chosenCluster: {
        batchId: chosen.batchId,
        categoryId: chosen.categoryId,
        categoryUuid: chosen.categoryUuid,
        categoryName: chosen.categoryName,
        storyId: chosen.story.id,
        clusterNumber: chosen.story.cluster_number,
        title: chosen.story.title,
        shortSummary: chosen.story.short_summary,
        sourceCount: chosen.story.unique_domains ?? chosen.story.articles.length,
        articleCount: chosen.story.articles.length,
      },
      sources,
    };

    await writeFile(resolve(exportDir, "cluster.json"), JSON.stringify(payload, null, 2), "utf8");
    await writeFile(
      resolve(exportDir, "sources.jsonl"),
      `${sources.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    );

    const importResult = await importClusterPayload(payload);
    console.log(
      `[kagi:ingest] keywords source=${importResult.keywordSource} status=${importResult.keywordStatus} model=${importResult.keywordModel ?? "n/a"} error=${
        importResult.keywordError ?? "none"
      }`,
    );
    console.log(
      `[kagi:ingest] dedupe strategy=${importResult.dedupeStrategy} groups=${importResult.dedupeGroupCount} matchedArticles=${importResult.dedupeMatchedArticleCount}`,
    );
    if (importResult.keywordStatus === "ready") {
      keywordReadyClusters += 1;
    } else {
      keywordPendingClusters += 1;
    }
    dedupeGroupsTotal += importResult.dedupeGroupCount;
    dedupeMatchedArticlesTotal += importResult.dedupeMatchedArticleCount;

    importedClusters += 1;
    importedArticles += importResult.importedArticles;

    results.push({
      exportDir,
      rank: index + 1,
      storyId: chosen.story.id,
      title: chosen.story.title,
      articleCount: sources.length,
      successfulExtractions: sources.filter((item) => item.extractionStatus === "SUCCESS").length,
      failedExtractions: sources.filter((item) => item.extractionStatus === "FAILED").length,
      importedArticles: importResult.importedArticles,
      keywordSource: importResult.keywordSource,
      keywordStatus: importResult.keywordStatus,
      keywordModel: importResult.keywordModel,
      keywordError: importResult.keywordError,
      dedupeStrategy: importResult.dedupeStrategy,
      dedupeGroupCount: importResult.dedupeGroupCount,
      dedupeMatchedArticleCount: importResult.dedupeMatchedArticleCount,
    });

    renderProgress("clusters", index + 1, selected.length, clusterProgressStartedAt, chosen.categoryName);
    if (index + 1 === selected.length) {
      finishProgressLine();
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    ingestCount: selected.length,
    importedClusters,
    importedArticles,
    globalLimit,
    perCategoryLimit,
    requiredCategories,
    coverage: selection.coverage,
    extraction: {
      concurrency: extractionConcurrency,
      perDomainConcurrency: extractionPerDomainConcurrency,
      retries: extractionMaxRetries,
      failedUrlCount: failedUrls.length,
    },
    keywords: {
      readyClusters: keywordReadyClusters,
      pendingClusters: keywordPendingClusters,
    },
    dedupe: {
      strategy: resolveDedupeStrategy(process.env.KAGI_DEDUPE_STRATEGY),
      totalGroups: dedupeGroupsTotal,
      totalMatchedArticles: dedupeMatchedArticlesTotal,
    },
    baseDir,
    results,
  };

  await writeFile(resolve(baseDir, "failed-urls.json"), JSON.stringify(failedUrls, null, 2), "utf8");
  await writeFile(resolve(baseDir, "ingest-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeKagiBrowser();
    await closeArticleExtractionBrowser();
    await prisma.$disconnect();
  });
