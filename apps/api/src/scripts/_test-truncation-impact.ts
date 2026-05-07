import "../config/env.js";
import { prisma } from "../lib/prisma.js";

(async () => {
  // Total articles with non-empty translatedFullText
  const total = await prisma.article.count({
    where: { translatedFullText: { not: null } },
  });

  // Truncation heuristic: ends with a non-terminal punctuation char
  // (comma, semicolon, dash, "and", "but", "the", "a", "an", "of", "to", "in")
  // OR ends with a lowercase letter (mid-word truncation).
  // Indexed-friendly approximation: PostgreSQL substring on the last 30 chars.
  const truncated = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Article"
    WHERE "translatedFullText" IS NOT NULL
      AND length("translatedFullText") > 200
      AND (
        -- Ends with a low-confidence sentence-end marker
        regexp_replace("translatedFullText", '\s+$', '') ~ '[a-z,]$'
        OR regexp_replace("translatedFullText", '\s+$', '') ~ '\b(and|but|or|the|a|an|of|to|in|on|with|for|by|from|that|which)$'
      )
  `;

  console.log(`Articles with translatedFullText: ${total}`);
  console.log(`  ending mid-sentence (heuristic): ${truncated[0]?.count} (${
    total > 0 ? ((Number(truncated[0]?.count) / total) * 100).toFixed(1) : "0"
  }%)`);

  // Sample 10 truncated articles to see what they look like.
  const samples = await prisma.$queryRaw<Array<{ id: string; tail: string; len: number }>>`
    SELECT id,
           right("translatedFullText", 80) AS tail,
           length("translatedFullText") AS len
    FROM "Article"
    WHERE "translatedFullText" IS NOT NULL
      AND length("translatedFullText") > 200
      AND regexp_replace("translatedFullText", '\s+$', '') ~ '[a-z,]$'
    ORDER BY random()
    LIMIT 10
  `;
  console.log("\n10 truncated samples (last 80 chars):");
  for (const s of samples) {
    console.log(`  [len=${s.len}] ${s.id}: ...${s.tail.replace(/\n/g, " ")}`);
  }

  await prisma.$disconnect();
})();
