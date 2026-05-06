import { computeClusterPerspective } from "../services/cluster-perspective.js";
import { prisma } from "../lib/prisma.js";

async function main(): Promise<void> {
  const clusterId = process.argv[2];
  if (!clusterId) {
    console.error("Usage: pnpm --filter @news/api perspective:cluster <clusterId>");
    process.exit(1);
  }

  const result = await computeClusterPerspective(clusterId, { persist: true });

  console.log("=".repeat(70));
  console.log(`Cluster: ${clusterId}`);
  console.log(
    `Articles: ${result.n_articles} | Sources: ${result.n_sources} | Countries: ${result.n_countries}`,
  );
  console.log(
    `Divergence score: ${result.divergence_score ?? "n/a"} (${result.divergence_label ?? "n/a"})`,
  );
  console.log("\nDistinctive words by source:");
  for (const row of result.distinctive_words) {
    console.log(`  ${row.source_name}: ${row.words.join(", ")}`);
  }
  console.log("\nSentiment by country:");
  for (const c of result.country_sentiment) {
    console.log(
      `  ${c.country.padEnd(20)} n=${c.n_articles}  avg=${c.avg_sentiment.toFixed(3)} ± ${c.sentiment_se.toFixed(3)}  (${c.sentiment_label})`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
