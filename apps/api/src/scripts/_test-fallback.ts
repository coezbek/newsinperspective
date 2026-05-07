import "../config/env.js";
import { prisma } from "../lib/prisma.js";

(async () => {
  const sample = await prisma.storyCluster.findMany({
    where: { translatedTitle: null },
    select: {
      id: true,
      title: true,
      articles: { select: { article: { select: { id: true, language: true, title: true } } } },
    },
    take: 5000,
  });

  // Genuinely non-Latin titles (Cyrillic, etc.) where an English article exists.
  const targets = sample.filter((c) => {
    if (/^[\x00-\x7F]+$/.test(c.title)) return false;
    if (/^[\x00-\xFF]+$/.test(c.title)) return false; // skip Latin-1 (covers most western European diacritics)
    return c.articles.some((l) => (l.article?.language ?? "").toLowerCase().startsWith("en"));
  });

  console.log(`Found ${targets.length} non-Latin-script clusters with English articles:`);
  for (const t of targets.slice(0, 5)) {
    console.log(`\n  cluster: ${t.title}`);
    const en = t.articles.find((l) => (l.article?.language ?? "").toLowerCase().startsWith("en"));
    console.log(`  english article: ${en?.article?.title}`);
  }

  // Now check: is the cluster title equal to one of the article titles in
  // such cases? Look at "diacritic-bearing Latin" titles instead.
  const latinTargets = sample.filter((c) => {
    if (/^[\x00-\x7F]+$/.test(c.title)) return false; // not ASCII (good — non-English)
    return c.articles.some((l) => {
      const a = l.article;
      if (!a) return false;
      if (!(a.language ?? "").toLowerCase().startsWith("en")) return false;
      // Article title differs from cluster title.
      return a.title.trim() !== c.title.trim();
    });
  });
  console.log(`\nNon-ASCII clusters with English article whose title DIFFERS: ${latinTargets.length}`);
  for (const t of latinTargets.slice(0, 8)) {
    const en = t.articles.find(
      (l) =>
        (l.article?.language ?? "").toLowerCase().startsWith("en") &&
        l.article?.title?.trim() !== t.title.trim(),
    );
    console.log(`  cluster: ${t.title.slice(0, 70)}`);
    console.log(`  → en  : ${en?.article?.title?.slice(0, 70)}`);
  }

  await prisma.$disconnect();
})();
