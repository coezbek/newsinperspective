import "../config/env.js";
import { ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

async function resyncDomain(domain: string): Promise<void> {
  const articles = await prisma.article.findMany({
    where: { domain },
    include: {
      features: {
        where: { scopeType: ScopeType.ARTICLE },
        take: 1,
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const sentiments = articles.map((article) => {
    const payload = article.features[0]?.featureSet as { sentiment?: number } | undefined;
    return payload?.sentiment ?? 0;
  });
  const biasSignals = articles.flatMap((article) => {
    const payload = article.features[0]?.featureSet as { biasSignals?: string[] } | undefined;
    return payload?.biasSignals ?? [];
  });

  const articleCount = articles.length;
  const averageSentiment =
    articleCount > 0
      ? Number((sentiments.reduce((sum, value) => sum + value, 0) / articleCount).toFixed(3))
      : 0;

  if (articleCount === 0) {
    // No articles point to this domain anymore (e.g. google.com after the
    // redirect backfill). Drop the profile so the UI doesn't keep listing it.
    await prisma.sourceProfile.deleteMany({ where: { domain } });
    console.log(`[resync] removed empty profile ${domain}`);
    return;
  }

  await prisma.sourceProfile.upsert({
    where: { domain },
    update: {
      sourceName: articles[0]?.sourceName ?? domain,
      articleCount,
      averageSentiment,
      commonBiasSignals: [...new Set(biasSignals)].slice(0, 8),
    },
    create: {
      domain,
      sourceName: articles[0]?.sourceName ?? domain,
      articleCount,
      averageSentiment,
      commonBiasSignals: [...new Set(biasSignals)].slice(0, 8),
      associatedEntities: [],
    },
  });
  console.log(`[resync] ${domain} :: ${articleCount} articles, sentiment=${averageSentiment}`);
}

async function main() {
  // Domains the article redirect backfill could have touched: every
  // SourceProfile.domain that no longer matches any Article.domain (stale),
  // plus every Article.domain (covers the newly-correct publisher domains).
  const articleDomains = await prisma.article.findMany({
    select: { domain: true },
    distinct: ["domain"],
  });
  const profileDomains = await prisma.sourceProfile.findMany({
    select: { domain: true },
  });

  const domains = new Set<string>();
  for (const row of articleDomains) domains.add(row.domain);
  for (const row of profileDomains) domains.add(row.domain);

  console.log(`[resync] processing ${domains.size} domains`);

  for (const domain of domains) {
    await resyncDomain(domain);
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
