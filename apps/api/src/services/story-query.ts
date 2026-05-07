import { ExtractionStatus, ScopeType } from "@prisma/client";
import type { ArticleDetail, SourceProfileDto, StoryComparison, StoryDetail, StoryFacetDto, StoryListItem, TagProfileDto } from "@news/shared";
import { extractRegion } from "../domain/category.js";
import { computeAuthorityStats, isGlobalTierDomain, scoreDomainAuthority } from "../domain/source-ranking.js";
import { prisma } from "../lib/prisma.js";
import { resolveCountryFromDomain } from "./country-from-domain.js";

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function listStoryDates(): Promise<string[]> {
  const rows = await prisma.storyCluster.findMany({
    distinct: ["storyDate"],
    orderBy: { storyDate: "desc" },
    select: { storyDate: true },
  });

  return rows.map((row) => toIsoDate(row.storyDate));
}

interface StoryFilters {
  category?: string | undefined;
  region?: string | undefined;
  keyword?: string | undefined;
}

interface StoryPaging {
  offset?: number | undefined;
  limit?: number | undefined;
}

function buildStoryWhere(date: string, filters: StoryFilters = {}) {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  const where: {
    storyDate: { gte: Date; lte: Date };
    topCategory?: string | { startsWith: string };
  } = {
    storyDate: { gte: start, lte: end },
  };

  if (filters.category) {
    where.topCategory = filters.category;
  } else if (filters.region) {
    where.topCategory = { startsWith: `${filters.region}` };
  }

  if (filters.keyword) {
    const keyword = normalizeKeyword(filters.keyword);
    return {
      ...where,
      OR: [
        {
          features: {
            some: {
              scopeType: ScopeType.CLUSTER,
              featureSet: {
                path: ["keywords"],
                array_contains: keyword,
              },
            },
          },
        },
        {
          articles: {
            some: {
              article: {
                features: {
                  some: {
                    scopeType: ScopeType.ARTICLE,
                    featureSet: {
                      path: ["keywordsEnglish"],
                      array_contains: keyword,
                    },
                  },
                },
              },
            },
          },
        },
        {
          articles: {
            some: {
              article: {
                features: {
                  some: {
                    scopeType: ScopeType.ARTICLE,
                    featureSet: {
                      path: ["keywords"],
                      array_contains: keyword,
                    },
                  },
                },
              },
            },
          },
        },
      ],
    };
  }

  return where;
}

function uniqueDomains(article: { domain: string; duplicateDomains: string[] }): string[] {
  return [...new Set([article.domain, ...article.duplicateDomains])];
}

function buildTopDomainsForDisplay(
  articles: Array<{ article: { domain: string; duplicateDomains: string[] } }>,
  limit = 4,
): string[] {
  // Only count the article's primary domain — including duplicateDomains
  // (syndication mirrors) inflates the strip past `sourceCount` and creates
  // confusing "3 articles across 3 sources" + 4 chips renderings.
  const domainCounts = new Map<string, number>();
  for (const { article } of articles) {
    const key = article.domain.trim().toLowerCase();
    if (!key) continue;
    domainCounts.set(key, (domainCounts.get(key) ?? 0) + 1);
  }

  const ranked = [...domainCounts.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      authority: scoreDomainAuthority(domain),
    }))
    .sort((left, right) => {
      if (right.authority !== left.authority) return right.authority - left.authority;
      if (right.count !== left.count) return right.count - left.count;
      return left.domain.localeCompare(right.domain);
    });

  const known = ranked.filter((item) => item.authority > 0);
  const unknown = ranked.filter((item) => item.authority <= 0);
  return [...known, ...unknown].slice(0, limit).map((item) => item.domain);
}

function pickRepresentativeArticles(
  articles: Array<{
    article: { id: string; canonicalUrl: string; domain: string; duplicateDomains: string[]; publishedAt: Date | null };
  }>,
  domains: string[],
): Array<{ domain: string; articleId: string; url: string }> {
  const result: Array<{ domain: string; articleId: string; url: string }> = [];
  for (const domain of domains) {
    const key = domain.trim().toLowerCase();
    const matches = articles
      .filter(({ article }) => uniqueDomains(article).some((value) => value.trim().toLowerCase() === key))
      .sort((left, right) => {
        const leftPrimary = left.article.domain.trim().toLowerCase() === key ? 0 : 1;
        const rightPrimary = right.article.domain.trim().toLowerCase() === key ? 0 : 1;
        if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
        const leftTime = left.article.publishedAt?.getTime() ?? 0;
        const rightTime = right.article.publishedAt?.getTime() ?? 0;
        return rightTime - leftTime;
      });
    const pick = matches[0]?.article;
    if (!pick) continue;
    result.push({ domain, articleId: pick.id, url: pick.canonicalUrl });
  }
  return result;
}

function safeDisplaySummary(article: {
  summary: string | null;
  contentSnippet: string | null;
  fullText: string | null;
}): string | null {
  const summary = article.summary?.trim() ?? "";
  const snippet = article.contentSnippet?.trim() ?? "";
  const fullText = article.fullText?.trim() ?? "";

  if (summary && summary !== fullText) {
    return summary;
  }

  if (snippet && snippet !== fullText) {
    return snippet;
  }

  return null;
}

type ArticleFeaturePayload = {
  keywords?: string[];
  keywordsEnglish?: string[];
  entities?: string[];
  biasSignals?: string[];
  sentiment?: number;
  subjectivity?: number;
  translatedSummary?: string | null;
  translatedTitle?: string | null;
};

type ClusterFeaturePayload = {
  keywords?: string[];
  kagiClusterNumber?: number;
  keywordStatus?: string;
};

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase();
}

function matchesKeyword(candidate: string, keyword: string): boolean {
  return normalizeKeyword(candidate) === normalizeKeyword(keyword);
}

function collectTopCounts(values: string[], limit = 8): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.label.localeCompare(right.label);
    })
    .slice(0, limit);
}

function collectUniqueKeywords(values: string[], limit = 12): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, limit);
}

function toIsoDateOrFallback(value: Date | null | undefined, fallback: Date): string {
  return toIsoDate(value ?? fallback);
}

function getClusterDateRange(
  storyDate: Date,
  articles: Array<{ article: { publishedAt: Date | null } }>,
): { dateFrom: string; dateUntil: string } {
  const publishedDates = articles
    .map(({ article }) => article.publishedAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());

  return {
    dateFrom: toIsoDateOrFallback(publishedDates[0], storyDate),
    dateUntil: toIsoDateOrFallback(publishedDates[publishedDates.length - 1], storyDate),
  };
}

function englishTokenCount(value: string): number {
  const matches = value.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? [];
  return matches.filter((token) => isGlobalTierDomain(token) === false).length;
}

function nonAsciiLetterRatio(value: string): number {
  const letters = value.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const nonAsciiLetters = letters.filter((letter) => !/[a-z]/i.test(letter)).length;
  return nonAsciiLetters / letters.length;
}

function isLikelyEnglishStory(
  title: string,
  keywords: string[],
  articles: Array<{ article: { title: string; summary: string | null; contentSnippet: string | null } }>,
): boolean {
  const combinedLeadText = [
    title,
    ...articles.slice(0, 3).flatMap(({ article }) => [article.title, article.summary, article.contentSnippet]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  const englishTokenScore = englishTokenCount(combinedLeadText);
  const keywordEnglishCount = keywords.filter((keyword) => /^[a-z]{3,}$/i.test(keyword)).length;
  const foreignScriptRatio = nonAsciiLetterRatio(combinedLeadText);

  return foreignScriptRatio < 0.18 && (englishTokenScore >= 12 || keywordEnglishCount >= 3);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function differenceInDays(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000));
}

function computeImportanceScore(
  storyDate: Date,
  articleCount: number,
  sourceCount: number,
  articles: Array<{ article: { domain: string; duplicateDomains: string[]; publishedAt: Date | null } }>,
  dateFrom: string,
  dateUntil: string,
  authorityAverage: number,
  authorityBest: number,
  tierDomainCount: number,
  sourceProfileTrustScore: number,
  kagiClusterNumber: number | null,
): number {
  const uniqueDomainCount = new Set(articles.flatMap(({ article }) => uniqueDomains(article))).size;
  const latestPublishedAt = articles
    .map(({ article }) => article.publishedAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? storyDate;
  const domainFrequency = new Map<string, number>();
  for (const { article } of articles) {
    const domain = article.domain.trim().toLowerCase();
    domainFrequency.set(domain, (domainFrequency.get(domain) ?? 0) + 1);
  }
  const dominantDomainShare =
    articleCount > 0
      ? [...domainFrequency.values()].reduce((current, count) => Math.max(current, count), 0) / articleCount
      : 0;

  const storyDayEnd = new Date(storyDate);
  storyDayEnd.setUTCHours(23, 59, 59, 999);
  const freshnessHours = Math.max(0, (storyDayEnd.getTime() - latestPublishedAt.getTime()) / 3_600_000);

  const sourceDiversityScore = clamp01(Math.log1p(uniqueDomainCount) / Math.log(18));
  const volumeScore = clamp01(Math.log1p(articleCount) / Math.log(30));
  const tierScore = clamp01(tierDomainCount / 4);
  const freshnessScore = clamp01(1 - freshnessHours / 30);
  const persistenceScore = clamp01(differenceInDays(dateFrom, dateUntil) / 3);
  const breadthScore = clamp01(Math.log1p(sourceCount) / Math.log(20));
  const concentrationPenalty = clamp01((dominantDomainShare - 0.35) / 0.65);
  const kagiRankScore =
    typeof kagiClusterNumber === "number" && Number.isFinite(kagiClusterNumber)
      ? clamp01(1 - (Math.max(1, kagiClusterNumber) - 1) / 20)
      : 0.5;

  const rawScore =
    authorityAverage * 0.18
    + authorityBest * 0.08
    + sourceProfileTrustScore * 0.12
    + tierScore * 0.18
    + sourceDiversityScore * 0.18
    + freshnessScore * 0.12
    + volumeScore * 0.08
    + persistenceScore * 0.04
    + breadthScore * 0.04
    + kagiRankScore * 0.06
    - concentrationPenalty * 0.08;

  return Number((clamp01(rawScore) * 100).toFixed(1));
}

function scoreSourceProfileTrust(domains: string[], profileCountByDomain: Map<string, number>): number {
  const uniqueDomainList = [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (uniqueDomainList.length === 0) return 0;

  const score =
    uniqueDomainList
      .map((domain) => {
        const count = profileCountByDomain.get(domain) ?? 0;
        return clamp01(Math.log1p(count) / Math.log(120));
      })
      .reduce((sum, value) => sum + value, 0) / uniqueDomainList.length;

  return Number(score.toFixed(3));
}

export async function listStoryFacets(date: string): Promise<StoryFacetDto> {
  return listStoryFacetsFiltered(date);
}

export async function listStoryFacetsFiltered(date: string, filters: StoryFilters = {}): Promise<StoryFacetDto> {
  const rows = await prisma.storyCluster.findMany({
    where: buildStoryWhere(date, filters),
    include: {
      articles: {
        include: {
          article: {
            include: {
              features: {
                where: { scopeType: ScopeType.ARTICLE },
              },
            },
          },
        },
      },
    },
  });

  const englishRows = rows.filter((row) => {
    const keywords = row.articles
      .flatMap((item) => item.article.features)
      .flatMap((feature) => {
        const payload = feature.featureSet as { keywords?: string[] };
        return payload.keywords ?? [];
      })
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .slice(0, 8);

    return isLikelyEnglishStory(row.title, keywords, row.articles);
  });

  const categorySourceRows = englishRows.length >= 5 ? englishRows : rows;

  const categories = categorySourceRows
    .map((row) => row.topCategory)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));

  const regions = categories
    .map((category) => extractRegion(category))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));

  return {
    date,
    regions,
    categories,
  };
}

export async function listStoriesByDate(
  date: string,
  filters: StoryFilters = {},
  paging: StoryPaging = {},
): Promise<StoryListItem[]> {
  const rows = await prisma.storyCluster.findMany({
    where: buildStoryWhere(date, filters),
    include: {
      features: {
        where: { scopeType: ScopeType.CLUSTER },
        take: 1,
      },
      articles: {
        include: {
          article: {
            include: {
              features: {
                where: { scopeType: ScopeType.ARTICLE },
              },
            },
          },
        },
      },
    },
  });

  // Hide clusters whose pipeline hasn't fully run yet. A cluster surfaces
  // in the listing only after stage 2 has enriched at least half of its
  // articles AND stage 4 has produced a `perspective_v1` feature row.
  // Anything less and the divergence label / pairwise heatmap on the
  // cluster page is computed against pre-translation text (or worse,
  // empty strings for non-English bodies), which gives users a wrong
  // first impression and persists into the embedding cache.
  //
  // The main query above uses `features: { take: 1 }` and the downstream
  // code expects that one row to be the kagi-ingest keyword feature
  // (which has no `kind` field). Pulling more rows there would risk
  // breaking the keyword extraction. Do a separate batched query just
  // for perspective_v1 row existence — one extra DB call, no per-row N+1.
  const perspectiveRows = await prisma.nlpFeature.findMany({
    where: {
      clusterId: { in: rows.map((r) => r.id) },
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
    },
    select: { clusterId: true },
  });
  const clustersWithPerspective = new Set(
    perspectiveRows.map((r) => r.clusterId).filter((v): v is string => Boolean(v)),
  );
  const readyRows = rows.filter((row) => {
    const total = row.articles.length;
    if (total === 0) return false;
    const enriched = row.articles.filter(
      (item) =>
        (item.article.translatedFullText && item.article.translatedFullText.trim()) ||
        (item.article.framingSummary && item.article.framingSummary.trim()),
    ).length;
    if (enriched / total < 0.5) return false;
    return clustersWithPerspective.has(row.id);
  });

  const allDomains = [...new Set(readyRows.flatMap((row) => row.articles.flatMap((item) => uniqueDomains(item.article))))];
  const profileRows = allDomains.length > 0
    ? await prisma.sourceProfile.findMany({
        where: { domain: { in: allDomains } },
        select: { domain: true, articleCount: true },
      })
    : [];
  const profileCountByDomain = new Map(profileRows.map((row) => [row.domain, row.articleCount]));

  const scoredRows = readyRows.map((row) => {
    const clusterDomains = [...new Set(row.articles.flatMap((item) => uniqueDomains(item.article)))];
    const usableArticles = row.articles.filter(
      ({ article }) => article.extractionStatus !== ExtractionStatus.FAILED,
    );
    const topDomains = buildTopDomainsForDisplay(usableArticles, 4);
    const topDomainArticles = pickRepresentativeArticles(usableArticles, topDomains);
    const clusterFeature = row.features[0]?.featureSet as
      | { keywords?: string[]; kagiClusterNumber?: number; keywordStatus?: string }
      | undefined;
    const keywords = clusterFeature?.keywords?.slice(0, 8) ?? [];
    const authorityStats = computeAuthorityStats(clusterDomains);
    const sourceProfileTrustScore = scoreSourceProfileTrust(clusterDomains, profileCountByDomain);
    const kagiClusterNumber =
      typeof clusterFeature?.kagiClusterNumber === "number" ? clusterFeature.kagiClusterNumber : null;
    const { dateFrom, dateUntil } = getClusterDateRange(row.storyDate, row.articles);
    const importanceScore = computeImportanceScore(
      row.storyDate,
      row.articleCount,
      row.sourceCount,
      row.articles,
      dateFrom,
      dateUntil,
      authorityStats.average,
      authorityStats.best,
      authorityStats.globalTierCount,
      sourceProfileTrustScore,
      kagiClusterNumber,
    );

    return {
      likelyEnglish: isLikelyEnglishStory(row.title, keywords, row.articles),
      item: {
      id: row.id,
      date,
      dateFrom,
      dateUntil,
      importanceScore,
      title: row.title,
      translatedTitle: row.translatedTitle,
      region: extractRegion(row.topCategory),
      category: row.topCategory,
      articleCount: row.articleCount,
      sourceCount: row.sourceCount,
      topDomains,
      topDomainArticles,
      keywords,
      },
    };
  });

  const preferredItems = scoredRows.filter((row) => row.likelyEnglish).map((row) => row.item);
  const fallbackItems = scoredRows.map((row) => row.item);
  const candidateItems = preferredItems.length >= 10 ? preferredItems : fallbackItems;

  const items = candidateItems.sort((left, right) => {
    if (right.importanceScore !== left.importanceScore) {
      return right.importanceScore - left.importanceScore;
    }
    if (right.sourceCount !== left.sourceCount) {
      return right.sourceCount - left.sourceCount;
    }
    return right.articleCount - left.articleCount;
  });

  const offset = Math.max(0, paging.offset ?? 0);
  const limit = Math.max(1, paging.limit ?? items.length);
  return items.slice(offset, offset + limit);
}

export async function getStoryDetail(id: string): Promise<StoryDetail | null> {
  const row = await prisma.storyCluster.findUnique({
    where: { id },
    include: {
      features: {
        where: { scopeType: ScopeType.CLUSTER },
        take: 1,
      },
      articles: {
        include: {
          article: {
            include: {
              features: {
                where: { scopeType: ScopeType.ARTICLE },
              },
            },
          },
        },
        orderBy: { rank: "asc" },
      },
    },
  });

  if (!row) return null;
  const clusterDomains = [...new Set(row.articles.flatMap((item) => uniqueDomains(item.article)))];
  const profileRows = clusterDomains.length > 0
    ? await prisma.sourceProfile.findMany({
        where: { domain: { in: clusterDomains } },
        select: { domain: true, articleCount: true, country: true, countryOfOrigin: true },
      })
    : [];
  const profileCountByDomain = new Map(profileRows.map((item) => [item.domain, item.articleCount]));
  const countryByDomain = new Map(
    profileRows.map((item) => [item.domain, item.countryOfOrigin ?? item.country ?? null]),
  );

  // Drop articles whose body extraction failed — they have no text to compare,
  // so they pollute the per-article list, near-duplicate detection and counts
  // without contributing any signal. They remain in the underlying StoryCluster
  // row; we just stop surfacing them via this API.
  const usableArticles = row.articles.filter(
    ({ article }) => article.extractionStatus !== ExtractionStatus.FAILED,
  );
  const usableArticleCount = usableArticles.length;
  const usableSourceCount = new Set(
    usableArticles.map(({ article }) => article.domain.trim().toLowerCase()),
  ).size;
  const topDomainsForDisplay = buildTopDomainsForDisplay(usableArticles, 4);
  const topDomainRank = new Map(topDomainsForDisplay.map((domain, index) => [domain, index]));
  const sortedRows = [...usableArticles].sort((left, right) => {
    const leftDomain = left.article.domain.trim().toLowerCase();
    const rightDomain = right.article.domain.trim().toLowerCase();
    const leftRank = topDomainRank.get(leftDomain) ?? Number.POSITIVE_INFINITY;
    const rightRank = topDomainRank.get(rightDomain) ?? Number.POSITIVE_INFINITY;

    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftAuthority = scoreDomainAuthority(leftDomain);
    const rightAuthority = scoreDomainAuthority(rightDomain);
    if (rightAuthority !== leftAuthority) return rightAuthority - leftAuthority;

    const leftPublishedAt = left.article.publishedAt?.getTime() ?? 0;
    const rightPublishedAt = right.article.publishedAt?.getTime() ?? 0;
    if (rightPublishedAt !== leftPublishedAt) return rightPublishedAt - leftPublishedAt;

    return left.article.title.localeCompare(right.article.title);
  });

  const baseArticles = sortedRows.map(({ article }) => {
    const feature = article.features[0]?.featureSet as
      | { keywords?: string[]; sentiment?: number; subjectivity?: number; biasSignals?: string[] }
      | undefined;

    const isEnglish = !article.language || article.language.toLowerCase().slice(0, 2) === "en";
    const hasTranslatedTitle = !!(article.translatedTitle && article.translatedTitle.trim().length > 0);
    const hasTranslatedSummary = !!(article.translatedSummary && article.translatedSummary.trim().length > 0);
    const hasTranslatedBody = !!(article.translatedFullText && article.translatedFullText.trim().length > 0);
    // Same rationale as the article-detail path: the LLM-cleaned body is
    // higher signal than the raw scrape regardless of source language.
    const listFullText = hasTranslatedBody ? article.translatedFullText : article.fullText;
    const listTitle = !isEnglish && hasTranslatedTitle ? article.translatedTitle : article.title;
    const listSummary = !isEnglish && hasTranslatedSummary ? article.translatedSummary : article.summary;
    const isTranslated = !isEnglish && (hasTranslatedTitle || hasTranslatedSummary || hasTranslatedBody);

    return {
      id: article.id,
      title: listTitle,
      url: article.canonicalUrl,
      domain: article.domain,
      syndicatedDomains: article.duplicateDomains,
      sourceName: article.sourceName,
      publishedAt: article.publishedAt?.toISOString() ?? new Date().toISOString(),
      summary: safeDisplaySummary({
        summary: listSummary,
        contentSnippet: article.contentSnippet,
        fullText: listFullText,
      }),
      contentSnippet: null,
      fullText: null,
      language: article.language ?? null,
      isTranslated,
      extractionStatus: article.extractionStatus,
      keywords: feature?.keywords ?? [],
      sentiment: feature?.sentiment ?? 0,
      subjectivity: feature?.subjectivity ?? 0,
      biasSignals: feature?.biasSignals ?? [],
      country:
        countryByDomain.get(article.domain) ??
        resolveCountryFromDomain(article.domain, article.sourceName),
    };
  });
  const articlesByDomain = new Map<string, typeof baseArticles>();
  for (const article of baseArticles) {
    const key = article.domain.trim().toLowerCase();
    const bucket = articlesByDomain.get(key) ?? [];
    bucket.push(article);
    articlesByDomain.set(key, bucket);
  }
  const articleById = new Map(baseArticles.map((article) => [article.id, article]));
  const peerMapByArticleId = new Map<string, Map<string, {
    articleId: string;
    title: string;
    domain: string;
    url: string;
  }>>();

  function addPeer(
    sourceId: string,
    peer: { articleId: string; title: string; domain: string; url: string },
  ): void {
    if (sourceId === peer.articleId) return;
    const bucket = peerMapByArticleId.get(sourceId) ?? new Map<string, {
      articleId: string;
      title: string;
      domain: string;
      url: string;
    }>();
    bucket.set(peer.articleId, peer);
    peerMapByArticleId.set(sourceId, bucket);
  }

  for (const article of baseArticles) {
    const domains = article.syndicatedDomains
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean)
      .filter((domain, index, list) => list.indexOf(domain) === index);

    for (const domain of domains) {
      const peer = (articlesByDomain.get(domain) ?? []).find((candidate) => candidate.id !== article.id);
      if (!peer) continue;
      addPeer(article.id, {
        articleId: peer.id,
        // Article.title is nullable in the schema; coalesce so the peer
        // entry's `title: string` contract holds. An empty title still renders
        // — the URL is what the user clicks on.
        title: peer.title ?? "",
        domain: peer.domain,
        url: peer.url,
      });
    }
  }

  for (const [sourceId, peers] of peerMapByArticleId.entries()) {
    const source = articleById.get(sourceId);
    if (!source) continue;
    for (const peer of peers.values()) {
      addPeer(peer.articleId, {
        articleId: source.id,
        title: source.title ?? "",
        domain: source.domain,
        url: source.url,
      });
    }
  }

  const articles = baseArticles.map((article) => {
    const nearDuplicatePeers = [...(peerMapByArticleId.get(article.id)?.values() ?? [])].sort((left, right) => {
      const domainCompare = left.domain.localeCompare(right.domain);
      if (domainCompare !== 0) return domainCompare;
      return left.title.localeCompare(right.title);
    });
    return {
      ...article,
      // Same Article.title-is-nullable issue as above; the API contract
      // promises a string. Empty string is the safe default.
      title: article.title ?? "",
      nearDuplicatePeers,
    };
  });
  const { dateFrom, dateUntil } = getClusterDateRange(row.storyDate, row.articles);
  const clusterFeature = row.features[0]?.featureSet as
    | { keywords?: string[]; kagiClusterNumber?: number; keywordStatus?: string }
    | undefined;
  const detailKeywords = clusterFeature?.keywords?.slice(0, 8) ?? [];
  const authorityStats = computeAuthorityStats(clusterDomains);
  const sourceProfileTrustScore = scoreSourceProfileTrust(clusterDomains, profileCountByDomain);
  const kagiClusterNumber =
    typeof clusterFeature?.kagiClusterNumber === "number" ? clusterFeature.kagiClusterNumber : null;
  const importanceScore = computeImportanceScore(
    row.storyDate,
    row.articleCount,
    row.sourceCount,
    row.articles,
    dateFrom,
    dateUntil,
    authorityStats.average,
    authorityStats.best,
    authorityStats.globalTierCount,
    sourceProfileTrustScore,
    kagiClusterNumber,
  );

  return {
    id: row.id,
    date: toIsoDate(row.storyDate),
    dateFrom,
    dateUntil,
    importanceScore,
    title: row.title,
    translatedTitle: row.translatedTitle,
    region: extractRegion(row.topCategory),
    category: row.topCategory,
    articleCount: usableArticleCount,
    sourceCount: usableSourceCount,
    topDomains: topDomainsForDisplay,
    keywords: detailKeywords,
    articles,
  };
}

export async function getStoryComparison(id: string): Promise<StoryComparison | null> {
  const detail = await getStoryDetail(id);
  if (!detail) return null;

  const sharedKeywords = detail.keywords.slice(0, 8);
  const commonEntities = detail.articles
    .flatMap((article) => article.title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? [])
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 8);

  const articleComparisons = detail.articles.map((article) => ({
    articleId: article.id,
    title: article.title,
    domain: article.domain,
    publishedAt: article.publishedAt,
    sentiment: article.sentiment,
    subjectivity: article.subjectivity,
    biasSignals: article.biasSignals,
    sharedKeywords: article.keywords.filter((keyword) => sharedKeywords.includes(keyword)),
  }));

  const framingSummary: string[] = [];

  return {
    storyId: detail.id,
    date: detail.date,
    dateFrom: detail.dateFrom,
    dateUntil: detail.dateUntil,
    title: detail.title,
    translatedTitle: detail.translatedTitle,
    sharedKeywords,
    commonEntities,
    domainSpread: detail.topDomains,
    framingSummary,
    articleComparisons,
  };
}

export async function getArticleDetail(id: string): Promise<ArticleDetail | null> {
  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      features: {
        where: { scopeType: ScopeType.ARTICLE },
        take: 1,
      },
      clusterLinks: {
        include: {
          cluster: true,
        },
        orderBy: [{ cluster: { storyDate: "desc" } }, { rank: "asc" }],
        take: 1,
      },
    },
  });

  if (!article) return null;

  // Display in English: when the source is non-English and a translation exists,
  // return the translated body. Entity offsets were computed against this same
  // translated text, so the highlighter stays aligned.
  const isEnglish = !article.language || article.language.toLowerCase().slice(0, 2) === "en";
  const hasTranslatedBody = !!(article.translatedFullText && article.translatedFullText.trim().length > 0);
  // Prefer the LLM-cleaned `translatedFullText` for ALL articles when it's
  // populated. For non-English articles it's the English translation; for
  // English articles it's the chrome-stripped cleaned body (nav menus,
  // image captions, "Subscribe" prompts, etc. all removed). Both are
  // strictly higher signal than the raw scrape, which often includes the
  // entire site navigation rendered as text.
  // `fullTextIsTranslated` stays narrow: it remains true only for
  // language-shifted output, so the UI's "Translated from <Language>"
  // affordance doesn't mislabel cleaned-but-not-translated English bodies.
  const displayFullText = hasTranslatedBody ? article.translatedFullText : article.fullText;
  const fullTextIsTranslated = !isEnglish && hasTranslatedBody;
  const hasTranslatedTitle = !!(article.translatedTitle && article.translatedTitle.trim().length > 0);
  const displayTitle = !isEnglish && hasTranslatedTitle
    ? article.translatedTitle!
    : article.title;
  const originalTitle: string | null = !isEnglish && hasTranslatedTitle ? article.title : null;

  const feature = article.features[0]?.featureSet as ArticleFeaturePayload | undefined;
  const relatedStory = article.clusterLinks[0]?.clusterId
    ? await getStoryDetail(article.clusterLinks[0].clusterId)
    : null;
  const nearDuplicatePeers = relatedStory?.articles
    .filter((peer) => peer.id !== article.id)
    .filter((peer) => article.duplicateDomains.includes(peer.domain.trim().toLowerCase()))
    .map((peer) => ({
      articleId: peer.id,
      title: peer.title,
      domain: peer.domain,
      url: peer.url,
    })) ?? [];

  return {
    id: article.id,
    title: displayTitle,
    originalTitle,
    language: article.language ?? null,
    url: article.canonicalUrl,
    domain: article.domain,
    syndicatedDomains: article.duplicateDomains,
    nearDuplicatePeers,
    sourceName: article.sourceName,
    publishedAt: article.publishedAt?.toISOString() ?? article.createdAt.toISOString(),
    summary: safeDisplaySummary({
      summary: !isEnglish && article.translatedSummary ? article.translatedSummary : article.summary,
      contentSnippet: article.contentSnippet,
      fullText: displayFullText,
    }),
    contentSnippet: article.contentSnippet,
    fullText: displayFullText,
    fullTextIsTranslated,
    extractionStatus: article.extractionStatus,
    keywords: feature?.keywords ?? [],
    sentiment: feature?.sentiment ?? 0,
    subjectivity: feature?.subjectivity ?? 0,
    biasSignals: feature?.biasSignals ?? [],
    relatedStory: relatedStory
      ? {
          id: relatedStory.id,
          title: relatedStory.title,
          translatedTitle: relatedStory.translatedTitle,
          date: relatedStory.date,
          dateFrom: relatedStory.dateFrom,
          dateUntil: relatedStory.dateUntil,
          region: relatedStory.region,
          category: relatedStory.category,
          articleCount: relatedStory.articleCount,
          sourceCount: relatedStory.sourceCount,
        }
      : null,
  };
}

export async function getSourceProfile(domain: string): Promise<SourceProfileDto | null> {
  const normalizedDomain = domain.trim().toLowerCase();
  const row = await prisma.sourceProfile.findUnique({
    where: { domain: normalizedDomain },
  });
  const storyRows = await prisma.storyCluster.findMany({
    where: {
      articles: {
        some: {
          article: {
            OR: [
              { domain: normalizedDomain },
              { duplicateDomains: { has: normalizedDomain } },
            ],
          },
        },
      },
    },
    include: {
      features: {
        where: { scopeType: ScopeType.CLUSTER },
        take: 1,
      },
      articles: {
        include: {
          article: {
            include: {
              features: {
                where: { scopeType: ScopeType.ARTICLE },
              },
            },
          },
        },
      },
    },
    orderBy: { storyDate: "desc" },
    take: 20,
  });

  if (!row && storyRows.length === 0) return null;

  const allMatchedArticles = storyRows.flatMap((story) =>
    story.articles
      .map((link) => link.article)
      .filter((article) =>
        article.domain.trim().toLowerCase() === normalizedDomain
        || article.duplicateDomains.some((value) => value.trim().toLowerCase() === normalizedDomain),
      ),
  );

  const topCategories = collectTopCounts(
    allMatchedArticles.map((article) => article.category).filter((value): value is string => Boolean(value)),
    6,
  );
  const topKeywords = collectUniqueKeywords(
    allMatchedArticles.flatMap((article) => {
      const feature = article.features[0]?.featureSet as ArticleFeaturePayload | undefined;
      return feature?.keywordsEnglish ?? feature?.keywords ?? [];
    }),
    10,
  );
  const latestStoryDate = storyRows[0] ? toIsoDate(storyRows[0].storyDate) : null;
  const stories = (await Promise.all(storyRows.map((story) => getStoryDetail(story.id)))).filter(
    (value): value is StoryDetail => Boolean(value),
  );

  return {
    domain: normalizedDomain,
    sourceName: row?.sourceName ?? allMatchedArticles[0]?.sourceName ?? normalizedDomain,
    description: row?.description ?? null,
    country: row?.country ?? null,
    countryOfOrigin: row?.countryOfOrigin ?? null,
    headquarters: row?.headquarters ?? null,
    mediaOwner: row?.mediaOwner ?? null,
    ownershipType: row?.ownershipType ?? null,
    employeeCount: row?.employeeCount ?? null,
    wikipediaUrl: row?.wikipediaUrl ?? null,
    associatedEntities: row?.associatedEntities ?? [],
    articleCount: allMatchedArticles.length,
    averageSentiment: row?.averageSentiment ?? 0,
    commonBiasSignals: row?.commonBiasSignals ?? [],
    topCategories,
    topKeywords,
    latestStoryDate,
    stories,
  };
}

export async function getTagProfile(keyword: string): Promise<TagProfileDto | null> {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) return null;

  const rows = await prisma.storyCluster.findMany({
    include: {
      features: {
        where: { scopeType: ScopeType.CLUSTER },
        take: 1,
      },
      articles: {
        include: {
          article: {
            include: {
              features: {
                where: { scopeType: ScopeType.ARTICLE },
              },
            },
          },
        },
      },
    },
    orderBy: { storyDate: "desc" },
  });

  const relatedKeywords: string[] = [];
  const relatedEntities: string[] = [];
  const topDomains: string[] = [];
  const topCategories: string[] = [];
  const matchedDates: string[] = [];
  const matchedStoryIds = new Set<string>();
  const matchedArticleIds = new Set<string>();
  const matchedSourceDomains = new Set<string>();

  for (const row of rows) {
    const clusterFeature = row.features[0]?.featureSet as ClusterFeaturePayload | undefined;
    const clusterKeywords = clusterFeature?.keywords ?? [];
    const matchingArticles = row.articles
      .map((link) => link.article)
      .filter((article) => {
        const feature = article.features[0]?.featureSet as ArticleFeaturePayload | undefined;
        const articleKeywords = feature?.keywordsEnglish ?? feature?.keywords ?? [];
        return articleKeywords.some((value) => matchesKeyword(value, normalizedKeyword));
      });

    const clusterMatched = clusterKeywords.some((value) => matchesKeyword(value, normalizedKeyword));
    if (!clusterMatched && matchingArticles.length === 0) continue;

    matchedStoryIds.add(row.id);
    topDomains.push(...row.articles.map((item) => item.article.domain));
    if (row.topCategory) topCategories.push(row.topCategory);
    matchedDates.push(toIsoDate(row.storyDate));

    for (const article of matchingArticles) {
      const feature = article.features[0]?.featureSet as ArticleFeaturePayload | undefined;
      const articleKeywords = feature?.keywordsEnglish ?? feature?.keywords ?? [];
      relatedKeywords.push(...articleKeywords.filter((value) => !matchesKeyword(value, normalizedKeyword)));
      relatedEntities.push(...(feature?.entities ?? []));
      matchedArticleIds.add(article.id);
      matchedSourceDomains.add(article.domain);
      topDomains.push(article.domain);
      if (article.category) topCategories.push(article.category);
      if (article.publishedAt) {
        matchedDates.push(toIsoDate(article.publishedAt));
      }
    }

    relatedKeywords.push(...clusterKeywords.filter((value) => !matchesKeyword(value, normalizedKeyword)));
  }

  if (matchedStoryIds.size === 0 && matchedArticleIds.size === 0) return null;
  const sortedDates = matchedDates.filter(Boolean).sort((left, right) => left.localeCompare(right));

  const orderedStoryIds = rows
    .filter((row) => matchedStoryIds.has(row.id))
    .slice(0, 20)
    .map((row) => row.id);
  const stories = (await Promise.all(orderedStoryIds.map((id) => getStoryDetail(id)))).filter(
    (value): value is StoryDetail => Boolean(value),
  );

  return {
    keyword,
    normalizedKeyword,
    storyCount: matchedStoryIds.size,
    articleCount: matchedArticleIds.size,
    sourceCount: matchedSourceDomains.size,
    dateFrom: sortedDates[0] ?? null,
    dateUntil: sortedDates[sortedDates.length - 1] ?? null,
    topDomains: collectTopCounts(topDomains, 8),
    topCategories: collectTopCounts(topCategories, 8),
    relatedKeywords: collectUniqueKeywords(relatedKeywords.filter((value) => !matchesKeyword(value, normalizedKeyword)), 12),
    relatedEntities: collectUniqueKeywords(relatedEntities, 12),
    stories,
    articles: [],
  };
}
