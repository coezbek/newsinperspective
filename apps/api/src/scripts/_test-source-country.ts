import "../config/env.js";
import { prisma } from "../lib/prisma.js";

(async () => {
  const total = await prisma.sourceProfile.count();
  const withCountry = await prisma.sourceProfile.count({
    where: { country: { not: null, notIn: [""] } },
  });
  const nullCountry = total - withCountry;
  console.log(`SourceProfile total: ${total}`);
  console.log(`  with country: ${withCountry} (${((withCountry / total) * 100).toFixed(1)}%)`);
  console.log(`  NULL/empty country: ${nullCountry} (${((nullCountry / total) * 100).toFixed(1)}%)`);

  // Article counts on null-country profiles
  const sums = await prisma.$queryRaw<Array<{ total_articles: bigint }>>`
    SELECT COALESCE(SUM("articleCount"), 0)::bigint AS total_articles
    FROM "SourceProfile"
    WHERE "country" IS NULL OR "country" = ''
  `;
  console.log(`  total articles attributable to NULL-country sources: ${sums[0]?.total_articles}`);

  // Sample 10 NULL-country sources by article count
  const sample = await prisma.sourceProfile.findMany({
    where: { OR: [{ country: null }, { country: "" }] },
    select: { domain: true, sourceName: true, articleCount: true },
    orderBy: { articleCount: "desc" },
    take: 10,
  });
  console.log("\nTop NULL-country sources by article count:");
  for (const s of sample) console.log(`  [${s.articleCount.toString().padStart(4)}] ${s.domain} (${s.sourceName})`);

  await prisma.$disconnect();
})();
