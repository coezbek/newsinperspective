/**
 * Diagnostic: how many clusters per recent day pass the new
 * `getClusterReadiness` gate vs total clusters?
 *
 * If the gate is filtering everything out, the listing endpoint will
 * return an empty array even though the DB has data.
 */
import "../config/env.js";
import { ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

async function main() {
  const days = 7;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - days * 24 * 3600 * 1000);

  const rows = await prisma.storyCluster.findMany({
    where: { storyDate: { gte: start } },
    include: {
      features: {
        where: { scopeType: ScopeType.CLUSTER },
        select: { featureSet: true },
      },
      articles: {
        select: {
          article: {
            select: { translatedFullText: true, framingSummary: true },
          },
        },
      },
    },
  });

  const buckets = new Map<string, { total: number; ready: number }>();
  for (const row of rows) {
    const day = row.storyDate.toISOString().slice(0, 10);
    const b = buckets.get(day) ?? { total: 0, ready: 0 };
    b.total += 1;

    const totalArticles = row.articles.length;
    const enriched = row.articles.filter(
      (a) =>
        (a.article.translatedFullText && a.article.translatedFullText.trim()) ||
        (a.article.framingSummary && a.article.framingSummary.trim()),
    ).length;
    const enrichedRatio = totalArticles > 0 ? enriched / totalArticles : 0;
    const hasPerspective = row.features.some((f) => {
      const fs = f.featureSet as { kind?: string };
      return fs?.kind === "perspective_v1";
    });
    const ready = totalArticles > 0 && enrichedRatio >= 0.5 && hasPerspective;
    if (ready) b.ready += 1;

    buckets.set(day, b);
  }

  const days_sorted = [...buckets.keys()].sort().reverse();
  console.log(`Day         ${"total".padEnd(8)}${"ready".padEnd(8)}filtered_out`);
  console.log(`---         ${"-----".padEnd(8)}${"-----".padEnd(8)}------------`);
  let gtot = 0, gready = 0;
  for (const d of days_sorted) {
    const b = buckets.get(d)!;
    gtot += b.total; gready += b.ready;
    console.log(`${d}  ${String(b.total).padEnd(8)}${String(b.ready).padEnd(8)}${b.total - b.ready}`);
  }
  console.log(`TOTAL       ${String(gtot).padEnd(8)}${String(gready).padEnd(8)}${gtot - gready}`);

  // Also break down by why each cluster fails the gate
  console.log("\nReason breakdown across all examined clusters:");
  let zeroArticles = 0, lowEnrichment = 0, noPerspective = 0;
  for (const row of rows) {
    const total = row.articles.length;
    if (total === 0) { zeroArticles += 1; continue; }
    const enriched = row.articles.filter(
      (a) =>
        (a.article.translatedFullText && a.article.translatedFullText.trim()) ||
        (a.article.framingSummary && a.article.framingSummary.trim()),
    ).length;
    const hasPerspective = row.features.some((f) => {
      const fs = f.featureSet as { kind?: string };
      return fs?.kind === "perspective_v1";
    });
    if (enriched / total < 0.5) lowEnrichment += 1;
    else if (!hasPerspective) noPerspective += 1;
  }
  console.log(`  zero articles:                  ${zeroArticles}`);
  console.log(`  enrichedRatio < 0.5:            ${lowEnrichment}`);
  console.log(`  no perspective_v1 feature:      ${noPerspective}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
