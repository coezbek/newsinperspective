import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getCurrentDateString } from "../lib/runtime-date.js";
import { closeArticleExtractionBrowser, extractArticleTextFromUrl } from "../services/article-text.js";
import { closeKagiBrowser, listTopClustersBySourceCount } from "../services/kagi-news.js";

function parseLimitArg(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function main() {
  const topLimit = parseLimitArg(process.argv[2]);
  const snapshotDate = process.argv[3] ?? getCurrentDateString();
  const clusters = await listTopClustersBySourceCount(topLimit);

  if (clusters.length === 0) {
    throw new Error("No clusters returned from Kagi API");
  }

  const chosen = clusters[Math.floor(Math.random() * clusters.length)]!;
  const exportDir = resolve(
    process.cwd(),
    "notebooks",
    "exports",
    "kagi-random",
    snapshotDate,
    `${chosen.story.cluster_number}-${slugify(chosen.story.title)}`,
  );
  await mkdir(exportDir, { recursive: true });

  const sources = await Promise.all(
    chosen.story.articles.map(async (article) => {
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
          return {
            ...article,
            originalUrl: article.link,
            finalUrl: article.link,
            extractionStatus: "FAILED",
            extractionError: error instanceof Error ? error.message : String(error),
            fullText: null,
          fullTextLength: 0,
          extractionFormat: null,
        };
      }
    }),
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    snapshotDate,
    topLimit,
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

  console.log(
    JSON.stringify(
      {
        exportDir,
        ...payload,
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
