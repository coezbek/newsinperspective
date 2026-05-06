import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

interface CliOptions {
  out: string;
  date: string | null;
  minSources: number;
}

interface Row {
  clusterId: string;
  storyDate: string;
  title: string;
  nArticles: number;
  nSources: number;
  nCountries: number;
  divergenceScore: number | null;
  divergenceLabel: string | null;
  nTruncated: number | null;
}

const HISTOGRAM_BINS: Array<{ lo: number; hi: number }> = [
  { lo: 0.0, hi: 0.04 },
  { lo: 0.04, hi: 0.08 },
  { lo: 0.08, hi: 0.12 },
  { lo: 0.12, hi: 0.15 },
  { lo: 0.15, hi: 0.2 },
  { lo: 0.2, hi: 0.25 },
  { lo: 0.25, hi: 0.3 },
  { lo: 0.3, hi: 0.4 },
  { lo: 0.4, hi: 1.0 },
];

const LABEL_THRESHOLDS = [
  { label: "low", upper: 0.08 },
  { label: "moderate", upper: 0.15 },
  { label: "high", upper: 0.25 },
  { label: "very_high", upper: Infinity },
] as const;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    out: "perspective-evaluation",
    date: null,
    minSources: 2,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        opts.out = argv[++i] ?? opts.out;
        break;
      case "--date":
        opts.date = argv[++i] ?? null;
        break;
      case "--min-sources":
        opts.minSources = Number(argv[++i] ?? opts.minSources);
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm --filter @news/api perspective:evaluation [--out PATH_PREFIX] [--date YYYY-MM-DD] [--min-sources N]",
        );
        process.exit(0);
    }
  }
  return opts;
}

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

function expectedLabel(score: number): string {
  for (const t of LABEL_THRESHOLDS) {
    if (score < t.upper) return t.label;
  }
  return "very_high";
}

async function loadRows(opts: CliOptions): Promise<Row[]> {
  const where: Record<string, unknown> = {
    scopeType: ScopeType.CLUSTER,
    featureSet: { path: ["kind"], equals: "perspective_v1" },
  };
  const features = await prisma.nlpFeature.findMany({
    where,
    include: {
      cluster: { select: { id: true, title: true, storyDate: true, sourceCount: true } },
    },
  });

  const rows: Row[] = [];
  for (const f of features) {
    if (!f.cluster) continue;
    const c = f.cluster;
    if (opts.date) {
      const start = new Date(`${opts.date}T00:00:00.000Z`).getTime();
      const end = new Date(`${opts.date}T23:59:59.999Z`).getTime();
      const t = c.storyDate.getTime();
      if (t < start || t > end) continue;
    }
    if (c.sourceCount < opts.minSources) continue;

    const payload = f.featureSet as Record<string, unknown>;
    const dq = payload.dataQuality as
      | { n_articles_truncated_for_sentiment?: number }
      | undefined;

    rows.push({
      clusterId: c.id,
      storyDate: c.storyDate.toISOString().slice(0, 10),
      title: c.title,
      nArticles: (payload.nArticles as number | undefined) ?? 0,
      nSources: (payload.nSources as number | undefined) ?? 0,
      nCountries: (payload.nCountries as number | undefined) ?? 0,
      divergenceScore: (payload.divergenceScore as number | null) ?? null,
      divergenceLabel: (payload.divergenceLabel as string | null) ?? null,
      nTruncated: dq?.n_articles_truncated_for_sentiment ?? null,
    });
  }
  rows.sort((a, b) => (b.divergenceScore ?? -1) - (a.divergenceScore ?? -1));
  return rows;
}

function buildHistogram(scores: number[]): { bin: string; count: number; bar: string }[] {
  const bins = HISTOGRAM_BINS.map((b) => ({ ...b, count: 0 }));
  for (const s of scores) {
    for (const b of bins) {
      if (s >= b.lo && s < b.hi) {
        b.count += 1;
        break;
      }
    }
  }
  const max = bins.reduce((m, b) => Math.max(m, b.count), 0) || 1;
  return bins.map((b) => ({
    bin: `[${b.lo.toFixed(2)}, ${b.hi.toFixed(2)})`,
    count: b.count,
    bar: "█".repeat(Math.round((b.count / max) * 40)),
  }));
}

function summariseLabels(rows: Row[]): { label: string; expected: number; observed: number; matches: number }[] {
  const counts = new Map<string, { expected: number; observed: number; matches: number }>();
  for (const t of LABEL_THRESHOLDS) {
    counts.set(t.label, { expected: 0, observed: 0, matches: 0 });
  }
  for (const r of rows) {
    if (r.divergenceScore === null) continue;
    const exp = expectedLabel(r.divergenceScore);
    const obs = r.divergenceLabel ?? "";
    counts.get(exp)!.expected += 1;
    if (counts.has(obs)) counts.get(obs)!.observed += 1;
    if (exp === obs) counts.get(exp)!.matches += 1;
  }
  return [...counts.entries()].map(([label, v]) => ({ label, ...v }));
}

async function writeCsv(path: string, rows: Row[]): Promise<void> {
  const header = [
    "cluster_id",
    "story_date",
    "title",
    "n_articles",
    "n_sources",
    "n_countries",
    "divergence_score",
    "divergence_label",
    "n_articles_truncated_for_sentiment",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.clusterId,
        r.storyDate,
        r.title,
        r.nArticles,
        r.nSources,
        r.nCountries,
        r.divergenceScore ?? "",
        r.divergenceLabel ?? "",
        r.nTruncated ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await loadRows(opts);
  console.log(
    `Loaded ${rows.length} cluster perspective(s) (date=${opts.date ?? "any"}, minSources=${opts.minSources})`,
  );
  if (rows.length === 0) return;

  const csvPath = resolve(`${opts.out}.csv`);
  await writeCsv(csvPath, rows);
  console.log(`Wrote CSV: ${csvPath}`);

  const scores = rows.map((r) => r.divergenceScore).filter((s): s is number => s !== null);
  const sources = rows.filter((r) => r.divergenceScore !== null).map((r) => r.nSources);
  const articles = rows.filter((r) => r.divergenceScore !== null).map((r) => r.nArticles);
  const countries = rows.filter((r) => r.divergenceScore !== null).map((r) => r.nCountries);

  console.log("\n── Divergence-score histogram ──");
  for (const b of buildHistogram(scores)) {
    console.log(`  ${b.bin.padEnd(16)}  ${String(b.count).padStart(5)}  ${b.bar}`);
  }

  console.log("\n── Threshold validation (label expected vs observed) ──");
  for (const r of summariseLabels(rows)) {
    console.log(
      `  ${r.label.padEnd(10)}  expected=${String(r.expected).padStart(4)}  observed=${String(r.observed).padStart(4)}  matches=${String(r.matches).padStart(4)}`,
    );
  }

  console.log("\n── Pearson correlations vs divergence_score ──");
  const corrSources = pearson(sources, scores);
  const corrArticles = pearson(articles, scores);
  const corrCountries = pearson(countries, scores);
  const fmt = (v: number | null): string => (v === null ? "n/a" : v.toFixed(3));
  console.log(`  n_sources    r = ${fmt(corrSources)}`);
  console.log(`  n_articles   r = ${fmt(corrArticles)}`);
  console.log(`  n_countries  r = ${fmt(corrCountries)}`);

  const truncated = rows
    .map((r) => r.nTruncated)
    .filter((v): v is number => typeof v === "number");
  if (truncated.length > 0) {
    const sum = truncated.reduce((a, b) => a + b, 0);
    const clustersWithTrunc = truncated.filter((v) => v > 0).length;
    console.log(
      `\n── Sentiment truncation ── ${clustersWithTrunc}/${truncated.length} clusters had ≥1 truncated article (total ${sum})`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
