/**
 * Standalone country resolver.
 *
 * For every SourceProfile whose `country` is null, try local resolver first
 * (free), then fall back to LLM tier-3 (OpenRouter). Results are persisted
 * onto SourceProfile.country so subsequent perspective computes pick them up
 * for free.
 *
 * Pass --no-llm to skip the LLM tier and only fill in matches the source
 * dictionary / ccTLD map cover.
 */
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveCountryFromDomain } from "../services/country-from-domain.js";
import {
  buildFeedCatalogCountryMap,
  KNOWN_COUNTRIES,
} from "../services/country-from-feed-catalog.js";
import { resolveCountryWithLlm } from "../services/country-llm-resolver.js";

interface CliOptions {
  limit: number | null;
  noLlm: boolean;
  domain: string | null;
  /**
   * Re-run tier-1+2 (dictionary + ccTLD) and the Kagi feed-catalog tier
   * across every SourceProfile. Default behaviour is *report only* — prints
   * disagreements without writing.
   *
   *   --apply         applies dict-disagreements + empty-fills (safe).
   *   --apply-empty   only fills rows whose stored value is null/empty.
   *   --apply-catalog additionally applies feed-catalog disagreements
   *                   (noisier signal — Kagi's small-country buckets pull
   *                   in random feeds; review the report first).
   */
  rerunLocal: boolean;
  apply: boolean;
  applyEmpty: boolean;
  applyCatalog: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: null,
    noLlm: false,
    domain: null,
    rerunLocal: false,
    apply: false,
    applyEmpty: false,
    applyCatalog: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--limit":
        opts.limit = Number(argv[++i]);
        break;
      case "--no-llm":
        opts.noLlm = true;
        break;
      case "--domain":
        opts.domain = argv[++i] ?? null;
        break;
      case "--rerun-local":
        opts.rerunLocal = true;
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--apply-empty":
        opts.applyEmpty = true;
        break;
      case "--apply-catalog":
        opts.applyCatalog = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm --filter @news/api perspective:resolve-countries [--no-llm] [--limit N] [--domain example.com]",
        );
        process.exit(0);
    }
  }
  return opts;
}

async function rerunLocalPass(opts: CliOptions): Promise<void> {
  const where: Record<string, unknown> = {};
  if (opts.domain) where.domain = opts.domain;

  const rows = await prisma.sourceProfile.findMany({
    where,
    select: { domain: true, sourceName: true, country: true, articleCount: true },
    orderBy: { articleCount: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  console.log(`Building Kagi feed-catalog country map…`);
  const catalogMap = await buildFeedCatalogCountryMap(KNOWN_COUNTRIES);
  console.log(`  ${catalogMap.size} domain(s) resolved from feed catalog`);

  const dryRun = !opts.apply && !opts.applyEmpty && !opts.applyCatalog;
  console.log(
    `Re-running local resolver across ${rows.length} source profile(s)${opts.domain ? ` (domain=${opts.domain})` : ""}`,
  );
  console.log(
    `Mode: ${dryRun ? "DRY RUN (report only)" : opts.apply ? "APPLY (overwrite all disagreements)" : "APPLY-EMPTY (fill nulls only)"}`,
  );

  interface Row {
    domain: string;
    stored: string | null;
    dictCountry: string | null;
    catalogCountry: string | null;
    articleCount: number;
  }

  const results: Row[] = [];
  for (const row of rows) {
    const dictCountry = resolveCountryFromDomain(row.domain, row.sourceName);
    const catalogCountry = catalogMap.get(row.domain) ?? null;
    results.push({
      domain: row.domain,
      stored: row.country ?? null,
      dictCountry,
      catalogCountry,
      articleCount: row.articleCount,
    });
  }

  // ── Buckets ─────────────────────────────────────────────────────────
  const stored = (r: Row) => r.stored ?? null;
  const proposed = (r: Row) => r.dictCountry ?? r.catalogCountry ?? null;

  const empty = results.filter((r) => !stored(r) && proposed(r));
  const agree = results.filter((r) => stored(r) && proposed(r) === stored(r));
  const dictDisagree = results.filter(
    (r) => stored(r) && r.dictCountry && r.dictCountry !== stored(r),
  );
  const catalogDisagree = results.filter(
    (r) =>
      stored(r) &&
      !r.dictCountry &&
      r.catalogCountry &&
      r.catalogCountry !== stored(r),
  );
  const noLocal = results.filter((r) => !r.dictCountry && !r.catalogCountry);

  // ── Reporting ───────────────────────────────────────────────────────
  function printRows(label: string, list: Row[], maxRows = 100): void {
    if (list.length === 0) return;
    console.log(`\n── ${label} (${list.length}) ──`);
    for (const r of list.slice(0, maxRows)) {
      const dict = r.dictCountry ?? "—";
      const cat = r.catalogCountry ?? "—";
      console.log(
        `  [${String(r.articleCount).padStart(4)}]  ${r.domain.padEnd(34)}  stored=${(r.stored ?? "null").padEnd(22)}  dict=${dict.padEnd(20)}  catalog=${cat}`,
      );
    }
    if (list.length > maxRows) {
      console.log(`  …and ${list.length - maxRows} more`);
    }
  }

  printRows("Dictionary disagrees with stored value", dictDisagree);
  printRows("Feed catalog disagrees with stored value (no dict match)", catalogDisagree);
  printRows("Stored is empty, proposed value available", empty);
  console.log(
    `\nSummary: agree=${agree.length}  dict-disagree=${dictDisagree.length}  catalog-disagree=${catalogDisagree.length}  empty-fillable=${empty.length}  no-local-signal=${noLocal.length}`,
  );

  if (dryRun) {
    console.log(
      "\nDry run — no rows updated. Re-run with --apply to overwrite all disagreements, or --apply-empty to only fill in null/empty stored values.",
    );
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────
  let updated = 0;
  const toUpdate: Row[] = [];
  if (opts.apply || opts.applyEmpty) toUpdate.push(...empty);
  if (opts.apply) toUpdate.push(...dictDisagree);
  if (opts.applyCatalog) toUpdate.push(...catalogDisagree);

  for (const r of toUpdate) {
    const newCountry = proposed(r);
    if (!newCountry) continue;
    if (newCountry === stored(r)) continue;
    await prisma.sourceProfile.update({
      where: { domain: r.domain },
      data: { country: newCountry },
    });
    updated += 1;
  }

  console.log(`\nApplied ${updated} update(s).`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.rerunLocal) {
    await rerunLocalPass(opts);
    return;
  }

  const where: Record<string, unknown> = {
    OR: [{ country: null }, { country: "" }],
  };
  if (opts.domain) where.domain = opts.domain;

  const rows = await prisma.sourceProfile.findMany({
    where,
    select: { domain: true, sourceName: true },
    orderBy: { articleCount: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  console.log(
    `Resolving country for ${rows.length} source profile(s) (no-llm=${opts.noLlm}${opts.domain ? `, domain=${opts.domain}` : ""})`,
  );

  let local = 0;
  let llm = 0;
  let unknown = 0;

  for (const row of rows) {
    const localResult = resolveCountryFromDomain(row.domain, row.sourceName);
    if (localResult) {
      await prisma.sourceProfile.update({
        where: { domain: row.domain },
        data: { country: localResult },
      });
      local += 1;
      continue;
    }

    if (opts.noLlm) {
      unknown += 1;
      continue;
    }

    const llmResult = await resolveCountryWithLlm(row.domain, row.sourceName);
    if (llmResult) {
      // resolveCountryWithLlm persists internally; nothing more to do here.
      llm += 1;
    } else {
      unknown += 1;
    }
  }

  console.log(
    `\nDone — local=${local} (tier 1+2), llm=${llm} (tier 3), unknown=${unknown}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
