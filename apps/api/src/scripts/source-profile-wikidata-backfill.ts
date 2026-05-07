/**
 * Backfill SourceProfile rows via Wikidata + Wikipedia REST.
 *
 * For every SourceProfile, run the Wikidata enrichment path and update any
 * fields the row is currently missing. If the row already has a
 * Wikidata-sourced description (enrichmentModel === 'wikidata'), it is left
 * alone. Rate-limited to ~1 req/sec to be polite to WDQS.
 *
 * Usage:
 *   pnpm --filter @news/api source:wikidata-backfill
 *   pnpm --filter @news/api source:wikidata-backfill --limit=20 --dry-run
 *   pnpm --filter @news/api source:wikidata-backfill --domain=npr.org
 */

import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { enrichSourceProfileFromWikidata } from "../services/source-profile-wikidata.js";

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitRaw = parseFlag("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const onlyDomain = parseFlag("domain");
  const intervalMs = Number.parseInt(parseFlag("interval-ms") ?? "1000", 10);

  console.log("\n=== SOURCE PROFILE WIKIDATA BACKFILL ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);
  console.log(`Limit: ${limit ?? "(all)"}`);
  console.log(`Domain filter: ${onlyDomain ?? "(none)"}`);
  console.log(`Min interval: ${intervalMs}ms`);
  console.log("-".repeat(60));

  const profiles = await prisma.sourceProfile.findMany({
    where: onlyDomain ? { domain: onlyDomain } : undefined,
    orderBy: { domain: "asc" },
    take: limit,
  });

  console.log(`Found ${profiles.length} SourceProfile rows.`);

  let attempted = 0;
  let resolved = 0;
  let skipped = 0;
  let writes = 0;

  for (const profile of profiles) {
    if (profile.enrichmentModel === "wikidata" && profile.description) {
      skipped++;
      continue;
    }

    attempted++;
    const start = Date.now();
    const wd = await enrichSourceProfileFromWikidata({
      domain: profile.domain,
      sourceName: profile.sourceName,
    });

    if (!wd) {
      console.log(`  [miss] ${profile.domain}`);
    } else {
      resolved++;
      console.log(
        `  [ok]   ${profile.domain.padEnd(30)} -> ${wd.wikidataId} (${wd.headquarters ?? "no HQ"})`,
      );
      if (!dryRun) {
        try {
          await prisma.sourceProfile.update({
            where: { id: profile.id },
            data: {
              description: profile.description ?? wd.description ?? null,
              country: profile.country ?? wd.country ?? null,
              countryOfOrigin: profile.countryOfOrigin ?? wd.countryOfOrigin ?? null,
              headquarters: profile.headquarters ?? wd.headquarters ?? null,
              mediaOwner: profile.mediaOwner ?? wd.mediaOwner ?? null,
              ownershipType: profile.ownershipType ?? wd.ownershipType ?? null,
              employeeCount: profile.employeeCount ?? wd.employeeCount ?? null,
              wikipediaUrl: profile.wikipediaUrl ?? wd.wikipediaUrl ?? null,
              associatedEntities: [
                ...new Set([...profile.associatedEntities, ...wd.associatedEntities]),
              ].slice(0, 8),
              lastEnrichedAt: new Date(),
              enrichmentModel: "wikidata",
              wikidataId: wd.wikidataId,
            },
          });
          writes++;
        } catch (err) {
          console.error(
            `  [err]  ${profile.domain}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Total: ${profiles.length}`);
  console.log(`Skipped (already wikidata): ${skipped}`);
  console.log(`Attempted: ${attempted}`);
  console.log(`Resolved via Wikidata: ${resolved}`);
  console.log(`DB writes: ${writes}${dryRun ? " (dry-run)" : ""}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
