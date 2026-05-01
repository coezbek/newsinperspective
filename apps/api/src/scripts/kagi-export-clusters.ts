import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getCurrentDateString } from "../lib/runtime-date.js";
import { closeArticleExtractionBrowser, extractArticleTextFromUrl } from "../services/article-text.js";
import {
  KagiCategoryFetchProgress,
  closeKagiBrowser,
  listClustersForIngestion,
} from "../services/kagi-news.js";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
  const bar = `${"=".repeat(Math.max(0, filled - 1))}${filled > 0 && filled < width ? ">" : "="}${".".repeat(Math.max(0, width - filled))}`;
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

async function main() {
  const globalLimit = parsePositiveInt(process.argv[2], 10);
  const perCategoryLimit = parsePositiveInt(process.argv[3], 5);
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

  const results = [];
  const clusterProgressStartedAt = Date.now();

  for (const [index, chosen] of selected.entries()) {
    console.log("");
    console.log(`[cluster ${index + 1}/${selected.length}] ${chosen.categoryName} · ${chosen.story.title}`);
    const exportDir = resolve(
      baseDir,
      `${index + 1}-${slugify(chosen.story.title)}`,
    );
    await mkdir(exportDir, { recursive: true });

    const sourceProgressStartedAt = Date.now();
    let sourceDone = 0;
    let sourceSuccess = 0;
    let sourceFailed = 0;
    const sources = await Promise.all(
      chosen.story.articles.map(async (article) => {
        let result: {
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
        };
        try {
          const extracted = await extractArticleTextFromUrl(article.link);
          result = {
            ...article,
            originalUrl: extracted.originalUrl,
            finalUrl: extracted.finalUrl,
            extractionStatus: "SUCCESS",
            extractionError: null,
            fullText: extracted.text,
            fullTextLength: extracted.text.length,
            extractionFormat: extracted.format,
          };
          sourceSuccess += 1;
        } catch (error) {
          result = {
            ...article,
            originalUrl: article.link,
            finalUrl: article.link,
            extractionStatus: "FAILED",
            extractionError: error instanceof Error ? error.message : String(error),
            fullText: null,
            fullTextLength: 0,
            extractionFormat: null,
          };
          sourceFailed += 1;
        }

        sourceDone += 1;
        renderProgress(
          `sources ${index + 1}/${selected.length}`,
          sourceDone,
          chosen.story.articles.length,
          sourceProgressStartedAt,
          `ok ${sourceSuccess} fail ${sourceFailed}`,
        );
        if (sourceDone === chosen.story.articles.length) {
          finishProgressLine();
        }
        return result;
      }),
    );

    const payload = {
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

    results.push({
      exportDir,
      rank: index + 1,
      storyId: chosen.story.id,
      title: chosen.story.title,
      articleCount: sources.length,
      successfulExtractions: sources.filter((item) => item.extractionStatus === "SUCCESS").length,
      failedExtractions: sources.filter((item) => item.extractionStatus === "FAILED").length,
    });

    renderProgress("clusters", index + 1, selected.length, clusterProgressStartedAt, chosen.categoryName);
    if (index + 1 === selected.length) {
      finishProgressLine();
    }
  }

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        exportCount: selected.length,
        globalLimit,
        perCategoryLimit,
        requiredCategories,
        coverage: selection.coverage,
        baseDir,
        results,
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
    await closeKagiBrowser();
    await closeArticleExtractionBrowser();
  });
