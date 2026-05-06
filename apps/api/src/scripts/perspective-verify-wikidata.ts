/**
 * Verify SourceProfile.country against Wikidata's P495 (country of origin) for
 * every row that has a wikipediaUrl. Dry-run by default; pass --apply to
 * overwrite stored values where Wikidata disagrees.
 *
 * Why: the LLM tier-3 country resolver makes mistakes (Russia for `*sport*`,
 * US for `*time*`, Kenya for unrelated outlets). Wikidata is authoritative
 * structured data — we just need to look up the entity for each
 * Wikipedia URL we already have.
 */
import "../config/env.js";
import { prisma } from "../lib/prisma.js";

interface CliOptions {
  apply: boolean;
  limit: number | null;
  domain: string | null;
  delayMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, limit: null, domain: null, delayMs: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        opts.apply = true;
        break;
      case "--limit":
        opts.limit = Number(argv[++i]);
        break;
      case "--domain":
        opts.domain = argv[++i] ?? null;
        break;
      case "--delay-ms":
        opts.delayMs = Number(argv[++i]);
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm --filter @news/api perspective:verify-wikidata [--apply] [--limit N] [--domain example.com] [--delay-ms 200]",
        );
        process.exit(0);
    }
  }
  return opts;
}

interface WikiRef {
  host: string;
  title: string;
}

function parseWikipediaUrl(url: string): WikiRef | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/wiki\/(.+)$/);
    if (!m) return null;
    return { host: u.host, title: decodeURIComponent(m[1] ?? "") };
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "NewsInPerspective-CountryAudit/1.0 (https://github.com/coezbek/newsinperspective)" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function pageToWikidataId(ref: WikiRef): Promise<string | null> {
  const apiUrl = `https://${ref.host}/w/api.php?action=query&format=json&prop=pageprops&redirects=1&titles=${encodeURIComponent(ref.title)}`;
  const data = await fetchJson<{
    query?: { pages?: Record<string, { pageprops?: { wikibase_item?: string } }> };
  }>(apiUrl);
  if (!data?.query?.pages) return null;
  for (const page of Object.values(data.query.pages)) {
    if (page?.pageprops?.wikibase_item) return page.pageprops.wikibase_item;
  }
  return null;
}

async function fetchEntityCountry(qid: string): Promise<{ countryQid: string; raw: unknown } | null> {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const data = await fetchJson<{
    entities?: Record<string, { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }>> }>;
  }>(url);
  const entity = data?.entities?.[qid];
  if (!entity?.claims) return null;
  // Prefer P495 (country of origin), fall back to P17 (country) and P159 (HQ location → country).
  for (const prop of ["P495", "P17"]) {
    const claims = entity.claims[prop];
    if (claims && claims.length > 0) {
      const id = claims[0]?.mainsnak?.datavalue?.value?.id;
      if (id) return { countryQid: id, raw: entity };
    }
  }
  return null;
}

const labelCache = new Map<string, string>();

async function resolveCountryLabel(qid: string): Promise<string | null> {
  if (labelCache.has(qid)) return labelCache.get(qid) ?? null;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const data = await fetchJson<{
    entities?: Record<string, { labels?: Record<string, { value?: string }> }>;
  }>(url);
  const label = data?.entities?.[qid]?.labels?.en?.value ?? null;
  if (label) labelCache.set(qid, label);
  return label;
}

/** Map a few common Wikidata labels to our canonical country names. */
function canonicalize(label: string): string {
  const map: Record<string, string> = {
    "United States of America": "United States",
    "United Kingdom of Great Britain and Northern Ireland": "United Kingdom",
    "United Kingdom": "United Kingdom",
    "People's Republic of China": "China",
    "Republic of China": "Taiwan",
    "Republic of Korea": "South Korea",
    "Democratic People's Republic of Korea": "North Korea",
    "Russian Federation": "Russia",
    Czechia: "Czech Republic",
    Czechoslovakia: "Czech Republic",
    "Federal Republic of Germany": "Germany",
    "State of Palestine": "Palestine",
    Palestine: "Palestine",
  };
  return map[label] ?? label;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RowResult {
  domain: string;
  stored: string | null;
  wikidata: string | null;
  qid: string | null;
  countryQid: string | null;
  status: "agree" | "disagree" | "missing-entity" | "missing-country" | "url-parse-error";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const where: Record<string, unknown> = {
    AND: [{ wikipediaUrl: { not: null } }, { wikipediaUrl: { not: "" } }],
  };
  if (opts.domain) (where.AND as Array<Record<string, unknown>>).push({ domain: opts.domain });

  const rows = await prisma.sourceProfile.findMany({
    where,
    select: { domain: true, country: true, wikipediaUrl: true, sourceName: true, articleCount: true },
    orderBy: { articleCount: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  console.log(
    `Verifying ${rows.length} source profile(s) with wikipediaUrl${opts.domain ? ` (domain=${opts.domain})` : ""}`,
  );
  console.log(`Mode: ${opts.apply ? "APPLY (overwrite on disagreement)" : "DRY RUN (report only)"}`);

  const results: RowResult[] = [];
  for (const [i, row] of rows.entries()) {
    process.stdout.write(`  [${i + 1}/${rows.length}] ${row.domain.padEnd(34)} `);
    const ref = row.wikipediaUrl ? parseWikipediaUrl(row.wikipediaUrl) : null;
    if (!ref) {
      results.push({
        domain: row.domain,
        stored: row.country,
        wikidata: null,
        qid: null,
        countryQid: null,
        status: "url-parse-error",
      });
      console.log("url-parse-error");
      continue;
    }

    const qid = await pageToWikidataId(ref);
    if (!qid) {
      results.push({
        domain: row.domain,
        stored: row.country,
        wikidata: null,
        qid: null,
        countryQid: null,
        status: "missing-entity",
      });
      console.log("missing wikidata entity");
      await sleep(opts.delayMs);
      continue;
    }

    const country = await fetchEntityCountry(qid);
    if (!country) {
      results.push({
        domain: row.domain,
        stored: row.country,
        wikidata: null,
        qid,
        countryQid: null,
        status: "missing-country",
      });
      console.log(`${qid} no country claim`);
      await sleep(opts.delayMs);
      continue;
    }

    const label = await resolveCountryLabel(country.countryQid);
    const wikidataCountry = label ? canonicalize(label) : null;
    const stored = row.country ?? null;
    const status = stored === wikidataCountry ? "agree" : "disagree";
    results.push({
      domain: row.domain,
      stored,
      wikidata: wikidataCountry,
      qid,
      countryQid: country.countryQid,
      status,
    });
    console.log(`${qid} → ${country.countryQid} = ${wikidataCountry} (${status})`);
    await sleep(opts.delayMs);
  }

  const agree = results.filter((r) => r.status === "agree");
  const disagree = results.filter((r) => r.status === "disagree");
  const missing = results.filter((r) => r.status === "missing-entity" || r.status === "missing-country" || r.status === "url-parse-error");

  console.log(`\nSummary: agree=${agree.length}  disagree=${disagree.length}  missing=${missing.length}`);

  if (disagree.length > 0) {
    console.log(`\n── Disagreements (Wikidata vs stored) ──`);
    for (const r of disagree) {
      console.log(
        `  ${r.domain.padEnd(34)}  stored=${(r.stored ?? "null").padEnd(22)}  wikidata=${r.wikidata ?? "null"}  (${r.qid} → ${r.countryQid})`,
      );
    }
  }

  if (!opts.apply) {
    console.log(
      "\nDry run — no rows updated. Re-run with --apply to overwrite stored values where Wikidata disagrees.",
    );
    return;
  }

  let updated = 0;
  for (const r of disagree) {
    if (!r.wikidata) continue;
    await prisma.sourceProfile.update({
      where: { domain: r.domain },
      data: { country: r.wikidata, countryOfOrigin: r.wikidata },
    });
    updated += 1;
  }
  console.log(`\nApplied ${updated} update(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
