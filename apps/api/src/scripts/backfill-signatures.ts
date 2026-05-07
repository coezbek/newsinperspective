/**
 * One-shot backfill for the article-enrichment and cluster-keyword input
 * signatures introduced in May 2026.
 *
 * Pre-existing NlpFeature rows don't have an `aiEnrichmentInputSignature`
 * (article scope) or `keywordInputSignature` (cluster scope). The runtime
 * filters in `openrouter-backlog.ts` would otherwise either:
 *   - re-enrich every grandfathered row (wasting LLM credits on data that
 *     was already fine), or
 *   - leave them grandfathered forever (the future text-change auto-heal
 *     would never fire on those rows).
 *
 * This script writes the *current* signature into rows that are missing
 * one, so the runtime treats them as validated and a real text change
 * later will produce a signature mismatch and trigger re-enrichment.
 *
 * Idempotent: only touches rows whose signature field is missing. Re-run
 * any time without effect on already-backfilled rows.
 *
 * Usage:
 *   pnpm --filter @news/api exec tsx src/scripts/backfill-signatures.ts
 *   pnpm --filter @news/api exec tsx src/scripts/backfill-signatures.ts --date YYYY-MM-DD
 */
import "../config/env.js";
import { Prisma, ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { buildClusterKeywordSignature, hashKeywordInput } from "../services/openrouter-backlog.js";

function getDateArg(): { gte: Date; lte: Date } | undefined {
  const idx = process.argv.findIndex((a) => a === "--date");
  if (idx < 0) return undefined;
  const d = process.argv[idx + 1];
  if (!d) return undefined;
  return {
    gte: new Date(`${d}T00:00:00.000Z`),
    lte: new Date(`${d}T23:59:59.999Z`),
  };
}

async function backfillArticleSignatures(dateWhere: { gte: Date; lte: Date } | undefined): Promise<number> {
  const rows = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.ARTICLE,
      ...(dateWhere ? { article: { ingestionDate: dateWhere } } : {}),
    },
    select: {
      id: true,
      featureSet: true,
      article: { select: { title: true, summary: true, fullText: true, contentSnippet: true } },
    },
  });
  let touched = 0;
  for (const row of rows) {
    if (!row.article) continue;
    const f = row.featureSet as Record<string, unknown>;
    if (f.aiEnrichmentStatus !== "ready") continue;
    if (typeof f.aiEnrichmentInputSignature === "string") continue;
    const sig = hashKeywordInput({
      title: row.article.title,
      summary: row.article.summary,
      body: row.article.fullText ?? row.article.contentSnippet,
    });
    const next = { ...f, aiEnrichmentInputSignature: sig } as Prisma.InputJsonValue;
    await prisma.nlpFeature.update({
      where: { id: row.id },
      data: { featureSet: next },
    });
    touched += 1;
  }
  return touched;
}

async function backfillClusterKeywordSignatures(dateWhere: { gte: Date; lte: Date } | undefined): Promise<number> {
  const features = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      ...(dateWhere ? { cluster: { storyDate: dateWhere } } : {}),
    },
    select: {
      id: true,
      featureSet: true,
      cluster: {
        select: {
          articles: {
            orderBy: { rank: "asc" },
            include: {
              article: {
                select: {
                  id: true,
                  title: true,
                  summary: true,
                  contentSnippet: true,
                  fullText: true,
                },
              },
            },
          },
        },
      },
    },
  });
  let touched = 0;
  for (const feature of features) {
    if (!feature.cluster) continue;
    const f = feature.featureSet as Record<string, unknown>;
    if (f.keywordStatus !== "ready") continue;
    if (typeof f.keywordInputSignature === "string") continue;
    const articles = feature.cluster.articles.slice(0, 6).map((item) => item.article);
    const signature = buildClusterKeywordSignature(
      articles.map((a) => ({
        articleId: a.id,
        hash: hashKeywordInput({
          title: a.title,
          summary: a.summary,
          body: a.fullText ?? a.contentSnippet,
        }),
      })),
    );
    const next = { ...f, keywordInputSignature: signature } as Prisma.InputJsonValue;
    await prisma.nlpFeature.update({
      where: { id: feature.id },
      data: { featureSet: next },
    });
    touched += 1;
  }
  return touched;
}

async function main(): Promise<void> {
  const dateWhere = getDateArg();
  console.log(
    `Backfilling input signatures${dateWhere ? ` for ${process.argv[process.argv.indexOf("--date") + 1]}` : " across all dates"}…`,
  );
  const articles = await backfillArticleSignatures(dateWhere);
  console.log(`  article-enrichment signatures written: ${articles}`);
  const clusters = await backfillClusterKeywordSignatures(dateWhere);
  console.log(`  cluster-keyword signatures written:    ${clusters}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
