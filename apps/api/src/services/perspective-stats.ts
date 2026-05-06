import { ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export interface DivergenceBucket {
  min: number;
  max: number;
  count: number;
}

export interface TopCluster {
  clusterId: string;
  title: string;
  divergenceScore: number;
  divergenceLabel: string | null;
  nSources: number;
  nCountries: number;
  nArticles: number;
}

export interface CountryCoverage {
  country: string;
  clusters: number;
  articles: number;
  meanSentiment: number;
}

export interface SentimentBin {
  min: number;
  max: number;
  count: number;
}

export interface CorrelationMatrixEntry {
  metric: string;
  values: Record<string, number>;
}

export interface PerspectiveStats {
  totalClusters: number;
  divergenceHistogram: DivergenceBucket[];
  divergenceMean: number;
  divergenceMedian: number;
  topClusters: TopCluster[];
  countryCoverage: CountryCoverage[];
  sentimentHistogram: SentimentBin[];
  correlation: CorrelationMatrixEntry[];
}

interface PerspectiveRow {
  clusterId: string;
  title: string;
  divergenceScore: number;
  divergenceLabel: string | null;
  nSources: number;
  nArticles: number;
  nCountries: number;
  countrySentiment: Array<{
    country: string;
    n_articles: number;
    avg_sentiment: number;
  }>;
}

async function loadPerspectiveRows(): Promise<PerspectiveRow[]> {
  const rows = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
    },
    select: {
      clusterId: true,
      featureSet: true,
      cluster: { select: { title: true, translatedTitle: true } },
    },
  });
  const out: PerspectiveRow[] = [];
  for (const row of rows) {
    if (!row.clusterId) continue;
    const f = row.featureSet as Record<string, unknown>;
    const score = f.divergenceScore;
    if (typeof score !== "number") continue;
    out.push({
      clusterId: row.clusterId,
      title: row.cluster?.translatedTitle ?? row.cluster?.title ?? "",
      divergenceScore: score,
      divergenceLabel: typeof f.divergenceLabel === "string" ? f.divergenceLabel : null,
      nSources: typeof f.nSources === "number" ? f.nSources : 0,
      nArticles: typeof f.nArticles === "number" ? f.nArticles : 0,
      nCountries: typeof f.nCountries === "number" ? f.nCountries : 0,
      countrySentiment: Array.isArray(f.countrySentiment)
        ? (f.countrySentiment as PerspectiveRow["countrySentiment"])
        : [],
    });
  }
  return out;
}

function histogram(values: number[], binCount: number, lo: number, hi: number): { min: number; max: number; count: number }[] {
  if (binCount <= 0 || values.length === 0) return [];
  const width = (hi - lo) / binCount;
  const buckets = Array.from({ length: binCount }, (_, i) => ({
    min: lo + i * width,
    max: lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    if (v < lo || v > hi) continue;
    let idx = Math.floor((v - lo) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    const bucket = buckets[idx];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2 : sorted[m] ?? 0;
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const a = (xs[i] ?? 0) - mx;
    const b = (ys[i] ?? 0) - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;
  return num / denom;
}

export async function getPerspectiveStats(): Promise<PerspectiveStats> {
  const rows = await loadPerspectiveRows();
  const scores = rows.map((r) => r.divergenceScore);

  const topClusters: TopCluster[] = [...rows]
    .sort((a, b) => b.divergenceScore - a.divergenceScore)
    .slice(0, 15)
    .map((r) => ({
      clusterId: r.clusterId,
      title: r.title,
      divergenceScore: Number(r.divergenceScore.toFixed(4)),
      divergenceLabel: r.divergenceLabel,
      nSources: r.nSources,
      nCountries: r.nCountries,
      nArticles: r.nArticles,
    }));

  // Country coverage aggregated across all stored country_sentiment payloads.
  const byCountry = new Map<string, { clusters: Set<string>; articles: number; sentSum: number; sentN: number }>();
  for (const r of rows) {
    for (const cs of r.countrySentiment) {
      if (!cs.country) continue;
      const entry = byCountry.get(cs.country) ?? { clusters: new Set(), articles: 0, sentSum: 0, sentN: 0 };
      entry.clusters.add(r.clusterId);
      entry.articles += cs.n_articles ?? 0;
      const w = cs.n_articles ?? 0;
      entry.sentSum += (cs.avg_sentiment ?? 0) * w;
      entry.sentN += w;
      byCountry.set(cs.country, entry);
    }
  }
  const countryCoverage: CountryCoverage[] = Array.from(byCountry.entries())
    .map(([country, e]) => ({
      country,
      clusters: e.clusters.size,
      articles: e.articles,
      meanSentiment: e.sentN > 0 ? Number((e.sentSum / e.sentN).toFixed(3)) : 0,
    }))
    .sort((a, b) => b.articles - a.articles)
    .slice(0, 25);

  // Sentiment distribution at country granularity (each country×cluster average is one sample).
  const sentSamples: number[] = [];
  for (const r of rows) {
    for (const cs of r.countrySentiment) sentSamples.push(cs.avg_sentiment ?? 0);
  }

  // Correlation across cluster-level metrics.
  const corrMetrics = ["nSources", "nArticles", "nCountries", "divergenceScore"] as const;
  const series: Record<(typeof corrMetrics)[number], number[]> = {
    nSources: rows.map((r) => r.nSources),
    nArticles: rows.map((r) => r.nArticles),
    nCountries: rows.map((r) => r.nCountries),
    divergenceScore: rows.map((r) => r.divergenceScore),
  };
  const correlation: CorrelationMatrixEntry[] = corrMetrics.map((m1) => ({
    metric: m1,
    values: Object.fromEntries(corrMetrics.map((m2) => [m2, Number(pearson(series[m1], series[m2]).toFixed(3))])),
  }));

  return {
    totalClusters: rows.length,
    divergenceHistogram: histogram(scores, 20, 0, 1),
    divergenceMean: Number(mean(scores).toFixed(4)),
    divergenceMedian: Number(median(scores).toFixed(4)),
    topClusters,
    countryCoverage,
    sentimentHistogram: histogram(sentSamples, 21, -1, 1),
    correlation,
  };
}
