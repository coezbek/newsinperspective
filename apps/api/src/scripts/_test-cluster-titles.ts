import "../config/env.js";
import { prisma } from "../lib/prisma.js";

(async () => {
  // Find non-ASCII NULL-translatedTitle clusters and count how many have at
  // least one English-titled article (cheapest fallback).
  const nullNonAscii = await prisma.storyCluster.findMany({
    where: { translatedTitle: null },
    select: {
      id: true,
      title: true,
      articles: {
        select: {
          article: {
            select: { id: true, title: true, language: true, translatedTitle: true },
          },
        },
      },
    },
    take: 5000,
  });

  let nonAsciiTotal = 0;
  let withEnglishArticleByLang = 0;
  let withEnglishArticleByTitle = 0;
  let withCachedTranslatedTitle = 0;
  let zeroFallback = 0;

  // Quick "looks-English" heuristic: title is ASCII-only AND contains a
  // common English short word. Ratio crudely catches news headlines.
  const englishHints = /\b(the|and|of|in|to|for|on|with|after|says|over|amid|at|as|is|are)\b/i;
  function looksEnglish(s: string): boolean {
    return /^[\x00-\x7F]+$/.test(s) && englishHints.test(s);
  }

  for (const c of nullNonAscii) {
    if (/^[\x00-\x7F]+$/.test(c.title)) continue;
    nonAsciiTotal++;
    let langHit = false;
    let titleHit = false;
    let cachedHit = false;
    for (const link of c.articles) {
      const a = link.article;
      const lang = (a.language ?? "").toLowerCase().slice(0, 2);
      if (lang === "en") langHit = true;
      if (looksEnglish(a.title)) titleHit = true;
      if (a.translatedTitle && a.translatedTitle.trim()) cachedHit = true;
    }
    if (langHit) withEnglishArticleByLang++;
    if (titleHit) withEnglishArticleByTitle++;
    if (cachedHit) withCachedTranslatedTitle++;
    if (!langHit && !titleHit && !cachedHit) zeroFallback++;
  }

  console.log(`Non-ASCII NULL-translatedTitle clusters: ${nonAsciiTotal}`);
  console.log(`  with at least one English-language article (Article.language='en'): ${withEnglishArticleByLang}`);
  console.log(`  with at least one English-titled article (heuristic): ${withEnglishArticleByTitle}`);
  console.log(`  with at least one cached Article.translatedTitle: ${withCachedTranslatedTitle}`);
  console.log(`  with NO fallback (would need direct LLM translation): ${zeroFallback}`);

  await prisma.$disconnect();
})();
