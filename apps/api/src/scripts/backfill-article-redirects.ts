import { ScopeType } from "@prisma/client";
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { closeArticleExtractionBrowser, resolveUrlWithBrowser } from "../services/article-text.js";
import { canonicalizeUrl, extractDomain } from "../domain/url.js";

interface CliOptions {
  limit: number;
  date?: { gte: Date; lte: Date };
  maxBatches: number;
  sleepMs: number;
}

interface BatchResult {
  matched: number;
  updated: number;
  skipped: number;
  failed: number;
  touchedDomains: string[];
  conflicts: Array<{ articleId: string; targetUrl: string; conflictArticleId: string }>;
  failures: Array<{ articleId: string; url: string; error: string }>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDateArg(value: string | undefined): { gte: Date; lte: Date } | undefined {
  if (!value) return undefined;
  return {
    gte: new Date(`${value}T00:00:00.000Z`),
    lte: new Date(`${value}T23:59:59.999Z`),
  };
}

function isUsableResolvedUrl(value: string | null): value is string {
  return Boolean(value && /^https?:\/\//.test(value));
}

function parseArgs(argv: string[]): CliOptions {
  let limit = 250;
  let date: { gte: Date; lte: Date } | undefined;
  let maxBatches = 1;
  let sleepMs = 0;

  for (const arg of argv) {
    if (/^\d+$/.test(arg)) {
      limit = parsePositiveInt(arg, limit);
      continue;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      date = parseDateArg(arg);
      continue;
    }

    if (arg === "--all") {
      maxBatches = Number.MAX_SAFE_INTEGER;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg.slice("--limit=".length), limit);
      continue;
    }

    if (arg.startsWith("--date=")) {
      date = parseDateArg(arg.slice("--date=".length));
      continue;
    }

    if (arg.startsWith("--max-batches=")) {
      maxBatches = parsePositiveInt(arg.slice("--max-batches=".length), maxBatches);
      continue;
    }

    if (arg.startsWith("--sleep-ms=")) {
      sleepMs = Math.max(0, parsePositiveInt(arg.slice("--sleep-ms=".length), sleepMs));
    }
  }

  return {
    limit,
    ...(date ? { date } : {}),
    maxBatches,
    sleepMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncTouchedSourceProfiles(domains: Set<string>): Promise<void> {
  for (const domain of domains) {
    const articles = await prisma.article.findMany({
      where: { domain },
      include: {
        features: {
          where: { scopeType: ScopeType.ARTICLE },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const sentiments = articles.map((article) => {
      const payload = article.features[0]?.featureSet as { sentiment?: number } | undefined;
      return payload?.sentiment ?? 0;
    });
    const biasSignals = articles.flatMap((article) => {
      const payload = article.features[0]?.featureSet as { biasSignals?: string[] } | undefined;
      return payload?.biasSignals ?? [];
    });

    const articleCount = articles.length;
    const averageSentiment =
      articleCount > 0
        ? Number((sentiments.reduce((sum, value) => sum + value, 0) / articleCount).toFixed(3))
        : 0;

    await prisma.sourceProfile.upsert({
      where: { domain },
      update: {
        sourceName: articles[0]?.sourceName ?? domain,
        articleCount,
        averageSentiment,
        commonBiasSignals: [...new Set(biasSignals)].slice(0, 8),
      },
      create: {
        domain,
        sourceName: articles[0]?.sourceName ?? domain,
        articleCount,
        averageSentiment,
        commonBiasSignals: [...new Set(biasSignals)].slice(0, 8),
        associatedEntities: [],
      },
    });
  }
}

async function runBatch(limit: number, date?: { gte: Date; lte: Date }): Promise<BatchResult> {
  const articles = await prisma.article.findMany({
    where: {
      ...(date ? { ingestionDate: date } : {}),
      OR: [
        { originalUrl: { contains: "news.google.com" } },
        { canonicalUrl: { contains: "news.google.com" } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      originalUrl: true,
      canonicalUrl: true,
      domain: true,
      sourceName: true,
    },
  });

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const touchedDomains = new Set<string>();
  const conflicts: Array<{ articleId: string; targetUrl: string; conflictArticleId: string }> = [];
  const failures: Array<{ articleId: string; url: string; error: string }> = [];

  for (const article of articles) {
    try {
      const resolved = canonicalizeUrl(await resolveUrlWithBrowser(article.originalUrl));
      if (!isUsableResolvedUrl(resolved) || resolved === article.canonicalUrl) {
        skipped += 1;
        continue;
      }

      const conflict = await prisma.article.findUnique({
        where: { canonicalUrl: resolved },
        select: { id: true },
      });

      if (conflict && conflict.id !== article.id) {
        conflicts.push({
          articleId: article.id,
          targetUrl: resolved,
          conflictArticleId: conflict.id,
        });
        skipped += 1;
        continue;
      }

      const nextDomain = extractDomain(resolved);
      touchedDomains.add(article.domain);
      touchedDomains.add(nextDomain);

      await prisma.article.update({
        where: { id: article.id },
        data: {
          originalUrl: resolved,
          canonicalUrl: resolved,
          domain: nextDomain,
          sourceName: article.sourceName === article.domain || article.domain === "news.google.com"
            ? nextDomain
            : article.sourceName,
        },
      });

      updated += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        articleId: article.id,
        url: article.originalUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await syncTouchedSourceProfiles(touchedDomains);

  return {
    matched: articles.length,
    updated,
    skipped,
    failed,
    touchedDomains: [...touchedDomains].sort((a, b) => a.localeCompare(b)),
    conflicts: conflicts.slice(0, 20),
    failures: failures.slice(0, 20),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let totalMatched = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let batch = 1; batch <= options.maxBatches; batch += 1) {
    const result = await runBatch(options.limit, options.date);
    totalMatched += result.matched;
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    console.log(
      JSON.stringify(
        {
          batch,
          limit: options.limit,
          ...result,
        },
        null,
        2,
      ),
    );

    if (result.matched < options.limit) break;
    if (result.updated === 0 && result.failed === 0) break;
    if (batch < options.maxBatches && options.sleepMs > 0) {
      await sleep(options.sleepMs);
    }
  }

  console.log(
    JSON.stringify(
      {
        summary: true,
        limit: options.limit,
        maxBatches: options.maxBatches,
        totalMatched,
        totalUpdated,
        totalSkipped,
        totalFailed,
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
    await closeArticleExtractionBrowser();
    await prisma.$disconnect();
  });
