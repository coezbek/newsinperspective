import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { enrichArticlesWithEntities } from "../services/article-enrichment.js";
import { createFileLogger } from "../lib/file-logger.js";
import {
  acquireProcessLock,
  acquireProcessLockWithWait,
  ProcessLockError,
} from "../lib/process-lock.js";

const logger = createFileLogger("re-enrich.log");

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main() {
  // CLI:
  //   tsx entity-re-enrich.ts                       # all articles without entities
  //   tsx entity-re-enrich.ts --date=YYYY-MM-DD     # only that ingestion date
  //   tsx entity-re-enrich.ts --limit=N             # cap how many to process
  //   tsx entity-re-enrich.ts --force               # re-process even if already enriched
  //   tsx entity-re-enrich.ts --wait[=seconds]      # if locked, wait up to N seconds (default 1800)
  const date = parseFlag("date");
  const limitFlag = parseFlag("limit");
  const limit = limitFlag ? Number.parseInt(limitFlag, 10) : undefined;
  const force = process.argv.includes("--force");
  const waitFlag = parseFlag("wait");
  const waitArg = process.argv.includes("--wait") || waitFlag !== undefined;
  const waitSeconds = waitFlag ? Number.parseInt(waitFlag, 10) : 1800;

  // Single-instance lock: parallel runs all hammer Wikipedia past the throttle
  // and produce duplicate work. With --wait, poll until the holder releases.
  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = waitArg
      ? await acquireProcessLockWithWait("entity-re-enrich", {
          timeoutMs: waitSeconds * 1000,
          log: (message) => console.log(message),
        })
      : acquireProcessLock("entity-re-enrich");
  } catch (err) {
    if (err instanceof ProcessLockError) {
      console.error(`Another entity-re-enrich is already running: ${err.message}`);
      process.exitCode = 2;
      await prisma.$disconnect();
      return;
    }
    throw err;
  }

  console.log(`\n=== ENTITY RE-ENRICHMENT ===`);
  console.log(`Date: ${date ?? "(no filter)"}`);
  console.log(`Limit: ${limit ?? "(none)"}`);
  console.log(`Force: ${force}`);
  console.log("-".repeat(60));

  try {
    const result = await enrichArticlesWithEntities({
      date,
      limit,
      force,
    });

    console.log("\n✓ Enrichment completed");
    console.log(`  Matched articles: ${result.matched}`);
    console.log(`  Attempted: ${result.attempted}`);
    console.log(`  Succeeded: ${result.succeeded}`);
    console.log(`  Failed: ${result.failed}`);
    console.log(`  Entity mentions written: ${result.entitiesExtracted}`);

    if (result.succeeded > 0) {
      const totalEntities = await prisma.namedEntity.count();
      const entitiesWithWiki = await prisma.namedEntity.count({
        where: { wikipediaUrl: { not: null } },
      });
      const coverage =
        totalEntities > 0 ? ((entitiesWithWiki / totalEntities) * 100).toFixed(1) : "0";
      console.log(
        `  Wikipedia coverage: ${entitiesWithWiki}/${totalEntities} (${coverage}%)`,
      );
    }
  } catch (error) {
    logger.error("Re-enrichment failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    releaseLock?.();
  }
}

main();
