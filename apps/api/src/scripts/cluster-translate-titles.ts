/**
 * Backfill StoryCluster.translatedTitle for clusters whose title is
 * non-English (or non-ASCII as a proxy) and whose translatedTitle is NULL.
 *
 * Two free passes (no LLM calls, no cost):
 *   1. Reuse cached article-level translations stored in NlpFeature.featureSet.
 *   2. Fall back to the highest-ranked English-language article title in the cluster.
 *
 * The runtime cluster backlog already does both via pickClusterTranslatedTitle —
 * this script just runs that picker over the historical backlog in one go,
 * rather than waiting for the next ingest pass to chip away at 200/iteration.
 *
 * Usage:
 *   pnpm --filter @news/api cluster:translate-titles
 *   pnpm --filter @news/api cluster:translate-titles --dry-run
 *   pnpm --filter @news/api cluster:translate-titles --limit=100
 *
 * Out of scope: clusters whose articles are *all* non-English with no cached
 * translations. Those need a direct LLM call on the title — track separately.
 */
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
// pickClusterTranslatedTitle is private to openrouter-backlog.ts. Rather than
// promote it to a public export (and add a test/maintenance burden for an
// already-internal helper), import the private symbol via the module's path.
// If the symbol is later renamed or made private, the script breaks loudly,
// which is the right failure mode for a one-off backfill tool.
import {
  pickClusterTranslatedTitleForBackfill,
} from "../services/openrouter-backlog.js";

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const a = process.argv.find((v) => v.startsWith(prefix));
  return a ? a.slice(prefix.length) : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitRaw = parseFlag("limit");
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : undefined;

  console.log("\n=== CLUSTER TITLE TRANSLATION BACKFILL (free pass) ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);
  console.log(`Limit: ${limit ?? "(all)"}`);
  console.log("-".repeat(60));

  const candidates = await prisma.storyCluster.findMany({
    where: { translatedTitle: null },
    select: { id: true, title: true, storyDate: true },
    orderBy: { storyDate: "desc" },
    take: limit,
  });
  console.log(`Found ${candidates.length} NULL-translatedTitle clusters.`);

  let scanned = 0;
  let resolved = 0;
  let unchanged = 0;
  let writes = 0;

  for (const cluster of candidates) {
    scanned++;
    const translated = await pickClusterTranslatedTitleForBackfill(cluster.id, cluster.title);
    if (!translated) {
      unchanged++;
      continue;
    }
    if (translated.trim() === cluster.title.trim()) {
      // Same string — nothing gained, skip the write.
      unchanged++;
      continue;
    }
    resolved++;
    if (dryRun) {
      console.log(`  [DRY] ${cluster.id} ${cluster.title.slice(0, 50)} → ${translated.slice(0, 50)}`);
      continue;
    }
    try {
      await prisma.storyCluster.update({
        where: { id: cluster.id },
        data: { translatedTitle: translated },
      });
      writes++;
    } catch (err) {
      console.warn(`  update failed for ${cluster.id}:`, err instanceof Error ? err.message : String(err));
    }
    if (scanned % 50 === 0) {
      console.log(`  progress: scanned=${scanned}/${candidates.length} resolved=${resolved} writes=${writes}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Scanned: ${scanned}`);
  console.log(`Resolved (would update): ${resolved}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`DB writes: ${writes}${dryRun ? " (dry-run)" : ""}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
