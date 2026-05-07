import "../config/env.js";
import { prisma } from "../lib/prisma.js";

(async () => {
  const total = await prisma.namedEntity.count();
  const withUrl = await prisma.namedEntity.count({ where: { wikipediaUrl: { not: null } } });
  const nullUrl = total - withUrl;
  console.log("NamedEntity total:", total);
  console.log(`  with wikipediaUrl: ${withUrl} (${((withUrl / total) * 100).toFixed(1)}%)`);
  console.log(`  NULL wikipediaUrl: ${nullUrl} (${((nullUrl / total) * 100).toFixed(1)}%)`);
  // Spot-check the eBay row that started this whole investigation.
  const ebay = await prisma.namedEntity.findFirst({
    where: { name: { equals: "eBay", mode: "insensitive" } },
    select: { id: true, name: true, type: true, wikipediaUrl: true, summary: true, firstSeen: true, lastUpdated: true },
  });
  console.log("\neBay row:", ebay);
  await prisma.$disconnect();
})();
