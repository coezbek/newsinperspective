import "../config/env.js";
import { ScopeType } from "@prisma/client";
import { computeClusterPerspective } from "../services/cluster-perspective.js";
import { prisma } from "../lib/prisma.js";

interface CliOptions {
  date: string | null;
  fromDate: string | null;
  limit: number | null;
  force: boolean;
  minSources: number;
  webBase: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    date: null,
    fromDate: null,
    limit: null,
    force: false,
    minSources: 2,
    webBase: process.env.WEB_ORIGIN || "http://localhost:5317",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--date":
        opts.date = argv[++i] ?? null;
        break;
      case "--from-date":
        opts.fromDate = argv[++i] ?? null;
        break;
      case "--limit":
        opts.limit = Number(argv[++i]);
        break;
      case "--force":
        opts.force = true;
        break;
      case "--min-sources":
        opts.minSources = Number(argv[++i]);
        break;
      case "--web-base":
        opts.webBase = argv[++i] ?? opts.webBase;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm --filter @news/api perspective:backfill [--date YYYY-MM-DD] [--from-date YYYY-MM-DD] [--limit N] [--min-sources 2] [--force]",
        );
        process.exit(0);
    }
  }
  return opts;
}

interface Candidate {
  id: string;
  title: string;
}

async function findCandidateClusters(opts: CliOptions): Promise<Candidate[]> {
  const where: Record<string, unknown> = {
    sourceCount: { gte: opts.minSources },
  };
  if (opts.date) {
    const start = new Date(`${opts.date}T00:00:00.000Z`);
    const end = new Date(`${opts.date}T23:59:59.999Z`);
    where.storyDate = { gte: start, lte: end };
  } else if (opts.fromDate) {
    where.storyDate = { gte: new Date(`${opts.fromDate}T00:00:00.000Z`) };
  }

  const rows = await prisma.storyCluster.findMany({
    where,
    select: { id: true, title: true },
    orderBy: { storyDate: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });
  return rows.map((r) => ({ id: r.id, title: r.title }));
}

/**
 * Returns true only when a perspective_v1 row exists AND was written after
 * the most recent change to any article in the cluster. This means the
 * perspective is current with respect to translations / re-extractions that
 * happened later (e.g. stage 2 OpenRouter translation populating
 * translatedFullText), and the backfill can safely skip recompute.
 */
async function alreadyComputed(clusterId: string): Promise<boolean> {
  const row = await prisma.nlpFeature.findFirst({
    where: {
      clusterId,
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
    },
    select: { id: true, updatedAt: true },
  });
  if (!row) return false;

  const latestArticle = await prisma.article.findFirst({
    where: { clusterLinks: { some: { clusterId } } },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  if (!latestArticle) return true;

  return row.updatedAt >= latestArticle.updatedAt;
}

interface Result {
  id: string;
  title: string;
  score: number | null;
  label: string | null;
  sources: number;
  countries: number;
  status: "ok" | "skipped" | "failed";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const candidates = await findCandidateClusters(opts);

  console.log(
    `Backfill: ${candidates.length} candidate cluster(s) (date=${opts.date ?? "any"}, fromDate=${opts.fromDate ?? "any"}, limit=${opts.limit ?? "none"}, force=${opts.force}, minSources=${opts.minSources})`,
  );

  const results: Result[] = [];
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (const [idx, candidate] of candidates.entries()) {
    const prefix = `[${idx + 1}/${candidates.length}] ${candidate.id}`;
    if (!opts.force && (await alreadyComputed(candidate.id))) {
      skipped += 1;
      const cached = await prisma.nlpFeature.findFirst({
        where: {
          clusterId: candidate.id,
          featureSet: { path: ["kind"], equals: "perspective_v1" },
        },
        select: { featureSet: true },
      });
      const f = (cached?.featureSet as Record<string, unknown> | undefined) ?? {};
      results.push({
        id: candidate.id,
        title: candidate.title,
        score: (f.divergenceScore as number | null) ?? null,
        label: (f.divergenceLabel as string | null) ?? null,
        sources: (f.nSources as number) ?? 0,
        countries: (f.nCountries as number) ?? 0,
        status: "skipped",
      });
      console.log(`${prefix} skipped (already computed)`);
      continue;
    }
    try {
      const t0 = Date.now();
      const result = await computeClusterPerspective(candidate.id, { persist: true });
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      processed += 1;
      results.push({
        id: candidate.id,
        title: candidate.title,
        score: result.divergence_score,
        label: result.divergence_label,
        sources: result.n_sources,
        countries: result.n_countries,
        status: "ok",
      });
      console.log(
        `${prefix} score=${result.divergence_score ?? "n/a"} (${result.divergence_label ?? "n/a"}) sources=${result.n_sources} countries=${result.n_countries} ${dur}s`,
      );
    } catch (err) {
      failed += 1;
      results.push({
        id: candidate.id,
        title: candidate.title,
        score: null,
        label: null,
        sources: 0,
        countries: 0,
        status: "failed",
      });
      console.error(`${prefix} FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nDone in ${elapsed}s — processed=${processed} skipped=${skipped} failed=${failed}`,
  );

  const ranked = results
    .filter((r) => r.status !== "failed")
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  if (ranked.length > 0) {
    console.log("\n── Cluster links (sorted by framing divergence, desc) ──");
    for (const r of ranked) {
      const score = r.score === null ? "  n/a" : r.score.toFixed(3);
      const label = (r.label ?? "n/a").padEnd(10);
      const url = `${opts.webBase.replace(/\/$/, "")}/stories/${encodeURIComponent(r.id)}`;
      const title = r.title.length > 60 ? `${r.title.slice(0, 57)}…` : r.title;
      console.log(`  ${score}  ${label}  ${url}  ${title}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
