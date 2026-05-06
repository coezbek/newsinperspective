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
import { resolveCountryWithLlm } from "../services/country-llm-resolver.js";

interface CliOptions {
  limit: number | null;
  noLlm: boolean;
  domain: string | null;
  /**
   * Re-run tier-1+2 (free) over every SourceProfile and overwrite the stored
   * country if the local resolver now produces a different non-null answer.
   * Useful after fixing dictionary entries. Never calls the LLM.
   */
  rerunLocal: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { limit: null, noLlm: false, domain: null, rerunLocal: false };
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
    select: { domain: true, sourceName: true, country: true },
    orderBy: { articleCount: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  console.log(
    `Re-running local resolver across ${rows.length} source profile(s)${opts.domain ? ` (domain=${opts.domain})` : ""}`,
  );

  let changed = 0;
  let unchanged = 0;
  let nullLocal = 0;

  for (const row of rows) {
    const local = resolveCountryFromDomain(row.domain, row.sourceName);
    if (!local) {
      nullLocal += 1;
      continue;
    }
    if ((row.country ?? null) === local) {
      unchanged += 1;
      continue;
    }
    await prisma.sourceProfile.update({
      where: { domain: row.domain },
      data: { country: local },
    });
    changed += 1;
    console.log(`  ${row.domain}: ${row.country ?? "null"} → ${local}`);
  }

  console.log(
    `\nDone — changed=${changed}, unchanged=${unchanged}, no-local-match=${nullLocal} (preserved as-is)`,
  );
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
