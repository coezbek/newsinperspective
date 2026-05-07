/**
 * Backfill Wikipedia data for NamedEntity rows whose linker data is missing.
 *
 * Why this exists:
 *   article-enrichment.ts links each NEW entity name once when first seen and
 *   then never revisits it (skips on `existingByName.has(c.entityText)`). If
 *   the first link attempt failed (rate limit, network blip, stale negative
 *   cache, buggy disambiguator) the row's wikipediaUrl/summary/imageUrl stay
 *   null forever. This script re-runs the linker for those rows and updates
 *   them in place.
 *
 * Usage:
 *   pnpm --filter @news/api entity:backfill-links
 *   pnpm --filter @news/api entity:backfill-links --limit=100
 *   pnpm --filter @news/api entity:backfill-links --dry-run --limit=20
 *   pnpm --filter @news/api entity:backfill-links --batch=50  (linker batch size)
 *
 * Notes:
 *   - The linker honours its disk cache; if a NULL row is for a name that
 *     was previously cached as `notFound`, the script will treat it as a
 *     confirmed miss (no DB write) — matching the production code path.
 *   - To force re-linking past stale negative cache entries, pass
 *     WIKIPEDIA_CACHE_DISABLE=true on the command line.
 *   - Throughput is gated by the global Wikipedia rate limiter
 *     (WIKIPEDIA_MIN_INTERVAL_MS, default 200ms = ~5 req/s).
 */
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { entityLinkerService } from "../services/entity-linker.js";
import type { EntityMention } from "../domain/entity-types.js";
import { EntityType } from "../domain/entity-types.js";
import { createFileLogger } from "../lib/file-logger.js";

const logger = createFileLogger("entity-link-backfill.log");

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function parseIntFlag(name: string, fallback?: number): number | undefined {
  const raw = parseFlag(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer (got ${raw})`);
  }
  return n;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = parseIntFlag("limit");
  const batchSize = parseIntFlag("batch", 50)!;

  console.log("\n=== ENTITY LINK BACKFILL ===");
  console.log(`Mode: ${dryRun ? "DRY RUN (no DB writes)" : "WRITE"}`);
  console.log(`Limit: ${limit ?? "(all)"}`);
  console.log(`Batch size: ${batchSize}`);
  console.log("-".repeat(60));

  // Pull rows missing wikipediaUrl. We keep the order stable (firstSeen ASC)
  // so reruns are deterministic — useful when batching across multiple invocations.
  const candidates = await prisma.namedEntity.findMany({
    where: { wikipediaUrl: null },
    select: { id: true, name: true, type: true },
    orderBy: { firstSeen: "asc" },
    take: limit,
  });

  console.log(`Found ${candidates.length} NamedEntity rows with NULL wikipediaUrl.`);
  if (candidates.length === 0) {
    await prisma.$disconnect();
    return;
  }

  let processed = 0;
  let linked = 0;
  let stillMissing = 0;
  let writes = 0;

  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const chunk = candidates.slice(offset, offset + batchSize);
    const mentions: EntityMention[] = chunk.map((row) => ({
      entityText: row.name,
      entityType: row.type as EntityType,
      // The linker only uses entityText/entityType; the offsets and context
      // exist on EntityMention to support highlighting in the article view.
      // We pass placeholders since we're not creating mentions.
      startOffset: 0,
      endOffset: row.name.length,
      confidence: 1,
      context: "",
    }));

    const results = await entityLinkerService.linkEntities(mentions);

    for (let i = 0; i < chunk.length; i++) {
      const row = chunk[i]!;
      const r = results[i]!;
      processed++;

      if (!r.wikipediaUrl) {
        stillMissing++;
        continue;
      }
      linked++;

      if (dryRun) {
        console.log(
          `  [DRY] would update ${row.name.padEnd(30)} -> ${r.wikipediaUrl}`,
        );
        continue;
      }

      try {
        await prisma.namedEntity.update({
          where: { id: row.id },
          data: {
            wikipediaUrl: r.wikipediaUrl,
            summary: r.summary ?? null,
            imageUrl: r.imageUrl ?? null,
          },
        });
        writes++;
      } catch (err) {
        logger.error("update failed", {
          id: row.id,
          name: row.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(
      `  progress: processed=${processed}/${candidates.length}, linked=${linked}, still-missing=${stillMissing}, writes=${writes}`,
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Processed: ${processed}`);
  console.log(`Newly linked: ${linked}`);
  console.log(`Still missing: ${stillMissing}`);
  console.log(`DB writes: ${writes}${dryRun ? " (dry-run, no actual writes)" : ""}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
