import { prisma } from "../lib/prisma.js";
import { startOfUtcDay } from "../lib/runtime-date.js";
const d = startOfUtcDay("2026-05-07");
const dayEnd = new Date(d.getTime() + 24 * 3600 * 1000);
async function main() {
  const articles = await prisma.article.count({ where: { ingestionDate: { gte: d, lt: dayEnd } } });
  const enriched = await prisma.article.count({ where: { ingestionDate: { gte: d, lt: dayEnd }, translatedFullText: { not: null } } });
  const framed = await prisma.article.count({ where: { ingestionDate: { gte: d, lt: dayEnd }, framingSummary: { not: null } } });
  const failed = await prisma.article.count({ where: { ingestionDate: { gte: d, lt: dayEnd }, extractionStatus: "FAILED" } });
  const clusters = await prisma.storyCluster.count({ where: { storyDate: d } });
  console.log(JSON.stringify({ articles, enriched, framed, failed, clusters }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
