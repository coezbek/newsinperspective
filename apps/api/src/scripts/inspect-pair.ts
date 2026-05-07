/**
 * Diagnostic CLI for an article pair (or single article).
 *
 * Reports, for each of the two articles:
 *   - Enrichment state on disk (raw / translated / framingSummary lengths)
 *   - Cluster memberships
 *
 * Then, for every cluster either article belongs to:
 *   - Cluster summary (title, storyDate, article count)
 *   - All NlpFeature rows on the cluster with their `kind` and updatedAt
 *   - The CLUSTER PERSPECTIVE row (loaded via the same `getStoredClusterPerspective`
 *     the API route uses, so the field names stay correct as the schema evolves)
 *   - The pairwise distance value for the requested pair, in BOTH directions
 *     (the matrix is symmetric in principle but stored as a nested map; we
 *     check both halves and flag mismatches)
 *   - The stored cluster narrative if any
 *
 * Usage:
 *   pnpm --filter @news/api exec tsx src/scripts/inspect-pair.ts <articleAId> [articleBId]
 *   pnpm inspect:pair <articleAId> [articleBId]
 *
 * Read-only — no DB mutations, no LLM calls.
 */
import "../config/env.js";
import { ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getStoredClusterPerspective } from "../services/cluster-perspective.js";
import { getStoredNarrative } from "../services/cluster-perspective-narrative.js";

interface ArticleSummary {
  id: string;
  title: string;
  domain: string | null;
  language: string | null;
  fullTextLen: number;
  translatedFullTextLen: number;
  framingSummaryLen: number;
  framingSummary: string | null;
  extractionStatus: string;
  clusterIds: string[];
}

async function loadArticleSummary(id: string): Promise<ArticleSummary | null> {
  const row = await prisma.article.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      domain: true,
      language: true,
      fullText: true,
      translatedFullText: true,
      framingSummary: true,
      extractionStatus: true,
      clusterLinks: {
        select: { clusterId: true, rank: true },
        orderBy: { rank: "asc" },
      },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    domain: row.domain,
    language: row.language,
    fullTextLen: row.fullText?.length ?? 0,
    translatedFullTextLen: row.translatedFullText?.length ?? 0,
    framingSummaryLen: row.framingSummary?.length ?? 0,
    framingSummary: row.framingSummary,
    extractionStatus: row.extractionStatus,
    clusterIds: row.clusterLinks.map((l) => l.clusterId),
  };
}

function pad(width: number, value: string | number): string {
  return String(value).padEnd(width);
}

async function reportArticle(label: string, summary: ArticleSummary | null): Promise<void> {
  if (!summary) {
    console.log(`\n[${label}] (not found)`);
    return;
  }
  console.log(`\n[${label}] ${summary.id}`);
  console.log(`  ${pad(28, "title:")}${summary.title}`);
  console.log(`  ${pad(28, "domain:")}${summary.domain}`);
  console.log(`  ${pad(28, "language:")}${summary.language}`);
  console.log(`  ${pad(28, "extractionStatus:")}${summary.extractionStatus}`);
  console.log(`  ${pad(28, "fullText length:")}${summary.fullTextLen}`);
  console.log(`  ${pad(28, "translatedFullText length:")}${summary.translatedFullTextLen}`);
  console.log(`  ${pad(28, "framingSummary length:")}${summary.framingSummaryLen}`);
  console.log(`  ${pad(28, "clusterIds:")}${summary.clusterIds.join(", ") || "(none)"}`);
  if (summary.framingSummary) {
    console.log(`  framingSummary preview:`);
    const text = summary.framingSummary.replace(/\s+/g, " ");
    console.log(`    ${text.slice(0, 240)}${text.length > 240 ? " …" : ""}`);
  }
}

async function reportCluster(
  clusterId: string,
  aId: string,
  bId: string | null,
  aDomain: string | null,
  bDomain: string | null,
): Promise<void> {
  const cluster = await prisma.storyCluster.findUnique({
    where: { id: clusterId },
    select: {
      id: true,
      title: true,
      translatedTitle: true,
      storyDate: true,
      _count: { select: { articles: true } },
    },
  });
  console.log(`\n=== cluster ${clusterId} ===`);
  if (!cluster) {
    console.log(`  (not found)`);
    return;
  }
  console.log(`  ${pad(20, "title:")}${cluster.title}`);
  console.log(`  ${pad(20, "translatedTitle:")}${cluster.translatedTitle ?? "(null)"}`);
  console.log(`  ${pad(20, "storyDate:")}${cluster.storyDate.toISOString().slice(0, 10)}`);
  console.log(`  ${pad(20, "article count:")}${cluster._count.articles}`);

  const features = await prisma.nlpFeature.findMany({
    where: { clusterId, scopeType: ScopeType.CLUSTER },
    select: { id: true, updatedAt: true, featureSet: true },
    orderBy: { updatedAt: "desc" },
  });
  console.log(`  ${pad(20, "feature rows:")}${features.length}`);
  for (const f of features) {
    const fs = f.featureSet as Record<string, unknown>;
    const kind = (fs.kind as string | undefined) ?? "(no kind)";
    console.log(`    - ${pad(28, kind)} updatedAt=${f.updatedAt.toISOString()}`);
  }

  // Load via the same service helper the API uses, so keys stay correct as
  // the schema evolves (e.g. camelCase storage vs snake_case API shape).
  const persp = await getStoredClusterPerspective(clusterId);
  if (!persp) {
    console.log(`  (no stored perspective — pairwise_distance unavailable)`);
  } else {
    console.log(`  divergence_score:    ${persp.divergence_score}`);
    console.log(`  divergence_label:    ${persp.divergence_label}`);
    console.log(`  n_articles:          ${persp.n_articles}`);
    console.log(`  n_sources:           ${persp.n_sources}`);
    console.log(`  n_countries:         ${persp.n_countries}`);
    const pdRows = Object.keys(persp.pairwise_distance).length;
    console.log(`  pairwise_distance:   ${pdRows} rows`);
    if (bId) {
      const ab = persp.pairwise_distance?.[aId]?.[bId];
      const ba = persp.pairwise_distance?.[bId]?.[aId];
      console.log(`    [${aId.slice(-12)}][${bId.slice(-12)}] = ${ab ?? "(missing)"}`);
      console.log(`    [${bId.slice(-12)}][${aId.slice(-12)}] = ${ba ?? "(missing)"}`);
      if (typeof ab === "number" && typeof ba === "number" && Math.abs(ab - ba) > 1e-6) {
        console.log(`    !! asymmetric: |ab - ba| = ${Math.abs(ab - ba)}`);
      }
      if (ab === undefined && ba === undefined) {
        const inA = persp.pairwise_distance?.[aId];
        const inB = persp.pairwise_distance?.[bId];
        console.log(
          `    aId in matrix: ${inA ? "yes" : "no"}    bId in matrix: ${inB ? "yes" : "no"}`,
        );
        const present = Object.keys(persp.pairwise_distance).slice(0, 5);
        console.log(`    matrix sample row keys: ${present.join(", ")}…`);
      }
    }
  }

  const narrative = await getStoredNarrative(clusterId);
  if (narrative) {
    const angles = narrative.framingAngles?.replace(/\s+/g, " ") ?? "";
    console.log(`  stored narrative:    yes (model=${narrative.model ?? "?"} generatedAt=${narrative.generatedAt})`);
    if (angles) console.log(`    framingAngles: ${angles.slice(0, 160)}${angles.length > 160 ? " …" : ""}`);
    if (narrative.error) console.log(`    error: ${narrative.error}`);
  } else {
    console.log(`  stored narrative:    (none — run perspective-narrative.ts to generate)`);
  }

  // Pairwise distance is keyed by SOURCE name (domain) in the stored
  // perspective, not by article ID — each row groups all articles from a
  // single source. Look up the pair by the domains of the two articles.
  if (aDomain && bDomain) {
    const persp = await getStoredClusterPerspective(clusterId);
    if (persp) {
      const ab = persp.pairwise_distance?.[aDomain]?.[bDomain];
      const ba = persp.pairwise_distance?.[bDomain]?.[aDomain];
      console.log(`  pairwise (by domain):`);
      console.log(`    [${aDomain}][${bDomain}] = ${ab ?? "(missing)"}`);
      console.log(`    [${bDomain}][${aDomain}] = ${ba ?? "(missing)"}`);
      if (typeof ab === "number" && typeof ba === "number" && Math.abs(ab - ba) > 1e-6) {
        console.log(`    !! asymmetric: |ab - ba| = ${Math.abs(ab - ba).toFixed(6)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const aId = process.argv[2];
  const bId = process.argv[3] ?? null;
  if (!aId) {
    console.error("Usage: inspect-pair <articleA> [articleB]");
    process.exit(1);
  }

  console.log(`==================================================`);
  console.log(` inspect-pair`);
  console.log(`   A: ${aId}`);
  console.log(`   B: ${bId ?? "(none)"}`);
  console.log(`==================================================`);

  const [a, b] = await Promise.all([
    loadArticleSummary(aId),
    bId ? loadArticleSummary(bId) : Promise.resolve(null),
  ]);
  await reportArticle("A", a);
  if (bId) await reportArticle("B", b);

  const clusterIds = Array.from(
    new Set([...(a?.clusterIds ?? []), ...(b?.clusterIds ?? [])]),
  );
  if (clusterIds.length === 0) {
    console.log("\n(no clusters to inspect)");
  } else {
    for (const cid of clusterIds) {
      await reportCluster(cid, aId, bId, a?.domain ?? null, b?.domain ?? null);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
