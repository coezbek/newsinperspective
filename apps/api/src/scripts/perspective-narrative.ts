/**
 * Batch-generate LLM narratives for clusters that already have a perspective row.
 *
 * Skips clusters whose narrative is already populated unless --force.
 * Honours --from-date / --limit / --min-divergence so you can target only the
 * most analytically interesting clusters and stay inside OpenRouter quota.
 */
import { ScopeType } from "@prisma/client";
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import {
  type SidecarAnalyzeResponse,
  type SidecarCountrySentiment,
  type SidecarDistinctiveWords,
} from "../services/cluster-perspective.js";
import { generateClusterNarrative } from "../services/cluster-perspective-narrative.js";

interface CliOptions {
  fromDate: string | null;
  limit: number | null;
  minDivergence: number | null;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    fromDate: null,
    limit: null,
    minDivergence: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--from-date":
        opts.fromDate = argv[++i] ?? null;
        break;
      case "--limit":
        opts.limit = Number(argv[++i]);
        break;
      case "--min-divergence":
        opts.minDivergence = Number(argv[++i]);
        break;
      case "--force":
        opts.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm --filter @news/api perspective:narrative [--from-date YYYY-MM-DD] [--limit N] [--min-divergence 0.4] [--force]",
        );
        process.exit(0);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set — narrative generation cannot proceed.");
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(2));

  const dateFilter: Record<string, unknown> = {};
  if (opts.fromDate) {
    dateFilter.storyDate = { gte: new Date(`${opts.fromDate}T00:00:00.000Z`) };
  }

  const rows = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
      ...(opts.fromDate ? { cluster: dateFilter } : {}),
    },
    select: {
      id: true,
      clusterId: true,
      featureSet: true,
      cluster: { select: { title: true, translatedTitle: true, storyDate: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  let candidates = rows.filter((r) => r.clusterId !== null);
  if (opts.minDivergence !== null) {
    candidates = candidates.filter((r) => {
      const f = r.featureSet as Record<string, unknown>;
      const score = typeof f.divergenceScore === "number" ? f.divergenceScore : null;
      return score !== null && score >= (opts.minDivergence as number);
    });
  }
  if (!opts.force) {
    candidates = candidates.filter((r) => {
      const f = r.featureSet as Record<string, unknown>;
      const narrative = (f.narrative as Record<string, unknown> | undefined) ?? null;
      const has = narrative && (narrative.framingAngles || narrative.countryNarrative);
      return !has;
    });
  }
  if (opts.limit !== null) candidates = candidates.slice(0, opts.limit);

  console.log(
    `Narrative generation: ${candidates.length} cluster(s) (fromDate=${opts.fromDate ?? "any"}, limit=${opts.limit ?? "none"}, minDivergence=${opts.minDivergence ?? "any"}, force=${opts.force})`,
  );

  let ok = 0;
  let fail = 0;
  for (const [idx, row] of candidates.entries()) {
    if (!row.clusterId) continue;
    const f = row.featureSet as Record<string, unknown>;
    const title = row.cluster?.translatedTitle ?? row.cluster?.title ?? "";
    const perspective: SidecarAnalyzeResponse = {
      cluster_id: row.clusterId,
      n_articles: (f.nArticles as number) ?? 0,
      n_sources: (f.nSources as number) ?? 0,
      n_countries: (f.nCountries as number) ?? 0,
      divergence_score: (f.divergenceScore as number | null) ?? null,
      divergence_label: (f.divergenceLabel as SidecarAnalyzeResponse["divergence_label"]) ?? null,
      pairwise_distance: (f.pairwiseDistance as SidecarAnalyzeResponse["pairwise_distance"]) ?? {},
      distinctive_words: (f.distinctiveWords as SidecarDistinctiveWords[]) ?? [],
      country_sentiment: (f.countrySentiment as SidecarCountrySentiment[]) ?? [],
      article_sentiment: {},
      article_embeddings: {},
      data_quality: (f.dataQuality as SidecarAnalyzeResponse["data_quality"]) ?? {
        n_articles_truncated_for_sentiment: 0,
        sentiment_truncation_chars: 0,
        n_articles_with_text: (f.nArticles as number) ?? 0,
      },
      sbert_model: (f.sbertModel as string) ?? "",
      sentiment_model: (f.sentimentModel as string) ?? "",
    };

    const prefix = `[${idx + 1}/${candidates.length}] ${row.clusterId}`;
    try {
      const t0 = Date.now();
      const result = await generateClusterNarrative(row.clusterId, title, perspective);
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      const wrote = (result.framingAngles ? "framing" : "—") + " / " +
        (result.countryNarrative ? "country" : "—");
      console.log(`${prefix} ${wrote} ${dur}s${result.error ? ` (error: ${result.error})` : ""}`);
      if (result.framingAngles || result.countryNarrative) ok += 1;
      else fail += 1;
    } catch (err) {
      fail += 1;
      console.error(`${prefix} FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone — ok=${ok} fail=${fail}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
