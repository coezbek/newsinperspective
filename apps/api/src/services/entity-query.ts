/**
 * Entity Query Service
 *
 * Provides database queries for entity information:
 * - Get entities mentioned in a specific article
 * - Get detailed information about a single entity with statistics
 * - Search for entities by name with filtering and pagination
 *
 * Features:
 * - Efficient database queries with proper includes to avoid N+1
 * - Statistical calculations (mention counts, trends, cooccurrences)
 * - Type-aware filtering and disambiguation
 * - Relevance scoring for search results
 * - Pagination support
 */

import { PrismaClient, EntityType } from "@prisma/client";
import type { EntityMention, NamedEntity } from "@prisma/client";

/**
 * Query parameters for filtering entities in articles
 */
export interface ArticleEntitiesFilter {
  type?: EntityType;
  minConfidence?: number;
  limit?: number;
}

/**
 * Query parameters for searching entities
 */
export interface SearchEntitiesFilter {
  type?: EntityType;
  limit?: number;
  offset?: number;
}

/**
 * Response for entity detail endpoint with statistics
 */
export interface EntityDetailResponse {
  id: string;
  name: string;
  type: EntityType;
  wikipediaUrl?: string | null;
  summary?: string | null;
  imageUrl?: string | null;
  wikidataId?: string | null;
  statistics: {
    totalMentions: number;
    articlesCount: number;
    mentions7Days: number;
    mentions30Days: number;
    topArticles: Array<{
      articleId: string;
      title: string;
      date: string;
      url: string;
      domain: string;
      mentions: number;
    }>;
    topDomains: Array<{
      domain: string;
      mentions: number;
    }>;
    cooccurrences: Array<{
      entityId: string;
      name: string;
      type: EntityType;
      cooccurrenceCount: number;
    }>;
    trend: Array<{
      date: string;
      count: number;
    }>;
  };
}

/**
 * Search result for entity search endpoint
 */
export interface EntitySearchResult {
  id: string;
  name: string;
  type: EntityType;
  wikipediaUrl?: string | null;
  mentionsCount: number;
  articlesCount: number;
  relevanceScore: number;
}

/**
 * Entity Query Service
 * Handles all database queries for entity information
 */
class EntityQueryService {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    // Allow dependency injection for testing
    if (prisma) {
      this.prisma = prisma;
    } else {
      // Create default client for production
      this.prisma = new PrismaClient();
    }
  }

  /**
   * Get all entities mentioned in a specific article
   *
   * @param articleId - ID of the article
   * @param filter - Query filters (type, minConfidence, limit)
   * @returns Array of linked entities with Wikipedia information
   */
  async getArticleEntities(
    articleId: string,
    filter: ArticleEntitiesFilter = {}
  ) {
    const minConfidence = filter.minConfidence ?? 0;

    // Return one row per distinct entity in the article. The frontend
    // highlighter matches surface forms client-side, so we no longer paginate
    // per-occurrence rows or carry offsets — we only need the entity metadata
    // (Wikipedia link, summary, image, type) plus how many times it appears.
    const mentions = await this.prisma.entityMention.findMany({
      where: {
        articleId,
        confidence: { gte: minConfidence },
        ...(filter.type && { entity: { type: filter.type } }),
      },
      include: {
        entity: true,
      },
      orderBy: { startOffset: "asc" },
    });

    const byEntity = new Map<
      string,
      { mention: typeof mentions[number]; count: number }
    >();
    for (const mention of mentions) {
      const existing = byEntity.get(mention.entity.id);
      if (existing) {
        existing.count += 1;
      } else {
        byEntity.set(mention.entity.id, { mention, count: 1 });
      }
    }

    return Array.from(byEntity.values()).map(({ mention, count }) => ({
      id: mention.entity.id,
      entityText: mention.entity.name,
      entityType: mention.entity.type,
      confidence: mention.confidence ?? 0,
      mentionCount: count,
      context: mention.context,
      articleId: mention.articleId,
      wikipediaUrl: mention.entity.wikipediaUrl,
      summary: mention.entity.summary,
      imageUrl: mention.entity.imageUrl,
      linkedAt: mention.entity.lastUpdated,
      pageId: mention.entity.wikiId ? parseInt(mention.entity.wikiId) : undefined,
    }));
  }

  /**
   * Get detailed information about a single entity with statistics
   *
   * @param entityId - ID of the entity
   * @returns Entity detail with comprehensive statistics
   */
  async getEntityDetail(entityId: string): Promise<EntityDetailResponse> {
    // Get basic entity info
    const entity = await this.prisma.namedEntity.findUnique({
      where: { id: entityId },
      include: {
        statistics: true,
        mentions: {
          include: {
            article: true,
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
        cooccurrence1: {
          include: {
            entity2: true,
          },
          orderBy: { cooccurrenceCount: "desc" },
          take: 5,
        },
      },
    });

    if (!entity) {
      throw new Error(`Entity not found: ${entityId}`);
    }

    // Calculate statistics
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all mentions for statistics (with article info for domain data)
    const allMentions = await this.prisma.entityMention.findMany({
      where: { entityId },
      include: { article: true },
    });

    // Count unique articles
    const uniqueArticles = new Set(allMentions.map((m) => m.articleId)).size;

    // Count mentions in time ranges
    const mentions7Days = allMentions.filter(
      (m) => m.createdAt >= sevenDaysAgo
    ).length;
    const mentions30Days = allMentions.filter(
      (m) => m.createdAt >= thirtyDaysAgo
    ).length;

    // Get top articles by mention count
    const topArticles = this.getTopArticles(entity.mentions);

    // Get top domains (use allMentions which includes article info)
    const topDomains = this.getTopDomains(allMentions);

    // Get cooccurrences
    const cooccurrences = entity.cooccurrence1.map((cooc) => ({
      entityId: cooc.entity2Id,
      name: cooc.entity2.name,
      type: cooc.entity2.type,
      cooccurrenceCount: cooc.cooccurrenceCount,
    }));

    // Generate trend (daily mentions for past 30 days)
    const trend = this.generateTrend(allMentions, 30);

    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      wikipediaUrl: entity.wikipediaUrl,
      summary: entity.summary,
      imageUrl: entity.imageUrl,
      wikidataId: entity.wikidataId,
      statistics: {
        totalMentions: entity.statistics?.totalMentions ?? allMentions.length,
        articlesCount: uniqueArticles,
        mentions7Days,
        mentions30Days,
        topArticles,
        topDomains,
        cooccurrences,
        trend,
      },
    };
  }

  /**
   * Search for entities by name with filtering and pagination
   *
   * @param query - Search query (entity name substring)
   * @param filter - Search filters (type, limit, offset)
   * @returns Array of entity search results with relevance scoring
   */
  async searchEntities(
    query: string,
    filter: SearchEntitiesFilter = {}
  ): Promise<{ results: EntitySearchResult[]; totalResults: number }> {
    const limit = filter.limit ?? 10;
    const offset = filter.offset ?? 0;

    // Build where clause
    const whereClause: any = {
      name: { contains: query, mode: "insensitive" },
    };

    if (filter.type) {
      whereClause.type = filter.type;
    }

    // Count total results
    const totalResults = await this.prisma.namedEntity.count({
      where: whereClause,
    });

    // Get paginated results
    const entities = await this.prisma.namedEntity.findMany({
      where: whereClause,
      include: {
        mentions: true,
        statistics: true,
      },
      orderBy: [
        { statistics: { totalMentions: "desc" } },
        { name: "asc" },
      ],
      skip: offset,
      take: limit,
    });

    // Calculate relevance scores and format results
    const results = entities.map((entity) => {
      const mentionsCount = entity.mentions.length;
      const uniqueArticles = new Set(entity.mentions.map((m) => m.articleId)).size;

      // Relevance scoring formula
      const exactMatch = entity.name.toLowerCase() === query.toLowerCase() ? 1.0 : 0;
      const nameMatch =
        entity.name.toLowerCase().startsWith(query.toLowerCase()) ? 0.9 : 0.8;

      // Normalize by max values (to be calculated)
      const maxMentions = 10000; // Approximate max
      const maxArticles = 1000; // Approximate max

      let relevanceScore =
        (exactMatch > 0 ? exactMatch : nameMatch) *
        (Math.min(mentionsCount, maxMentions) / maxMentions) * 0.7 +
        (Math.min(uniqueArticles, maxArticles) / maxArticles) * 0.3;

      // Boost if trending (more mentions in recent 30 days)
      const stats = entity.statistics;
      if (stats && stats.mentions30Days > stats.mentions7Days * 2) {
        relevanceScore *= 1.2;
      }

      // Clamp to [0, 1]
      relevanceScore = Math.min(1.0, relevanceScore);

      return {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        wikipediaUrl: entity.wikipediaUrl,
        mentionsCount,
        articlesCount: uniqueArticles,
        relevanceScore,
      };
    });

    return { results, totalResults };
  }

  /**
   * Top entities mentioned in any article belonging to a cluster.
   * Aggregates EntityMention rows joined through ClusterArticle.
   */
  async getClusterEntities(
    clusterId: string,
    options: { limit?: number; type?: EntityType } = {},
  ): Promise<Array<{
    entityId: string;
    name: string;
    type: EntityType;
    wikipediaUrl: string | null;
    mentionCount: number;
    articleCount: number;
  }>> {
    const limit = options.limit ?? 10;
    const mentions = await this.prisma.entityMention.findMany({
      where: {
        article: { clusterLinks: { some: { clusterId } } },
        ...(options.type && { entity: { type: options.type } }),
      },
      select: {
        articleId: true,
        entity: {
          select: {
            id: true,
            name: true,
            type: true,
            wikipediaUrl: true,
          },
        },
      },
    });

    const byEntity = new Map<string, {
      entityId: string;
      name: string;
      type: EntityType;
      wikipediaUrl: string | null;
      mentionCount: number;
      articleIds: Set<string>;
    }>();
    for (const m of mentions) {
      const e = byEntity.get(m.entity.id);
      if (e) {
        e.mentionCount += 1;
        e.articleIds.add(m.articleId);
      } else {
        byEntity.set(m.entity.id, {
          entityId: m.entity.id,
          name: m.entity.name,
          type: m.entity.type,
          wikipediaUrl: m.entity.wikipediaUrl,
          mentionCount: 1,
          articleIds: new Set([m.articleId]),
        });
      }
    }
    return Array.from(byEntity.values())
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, limit)
      .map(({ articleIds, ...rest }) => ({
        ...rest,
        articleCount: articleIds.size,
      }));
  }

  /**
   * For a cluster, return top entities grouped by domain. Powers the
   * "framing differences across outlets" view.
   */
  async getClusterEntitiesByDomain(
    clusterId: string,
    options: { perDomainLimit?: number; type?: EntityType } = {},
  ): Promise<Array<{
    domain: string;
    entities: Array<{
      entityId: string;
      name: string;
      type: EntityType;
      wikipediaUrl: string | null;
      mentionCount: number;
    }>;
  }>> {
    const perDomainLimit = options.perDomainLimit ?? 10;
    const mentions = await this.prisma.entityMention.findMany({
      where: {
        article: { clusterLinks: { some: { clusterId } } },
        ...(options.type && { entity: { type: options.type } }),
      },
      select: {
        article: { select: { domain: true } },
        entity: {
          select: {
            id: true,
            name: true,
            type: true,
            wikipediaUrl: true,
          },
        },
      },
    });

    const byDomain = new Map<string, Map<string, {
      entityId: string;
      name: string;
      type: EntityType;
      wikipediaUrl: string | null;
      mentionCount: number;
    }>>();
    for (const m of mentions) {
      const domain = m.article.domain;
      if (!domain) continue;
      let domainMap = byDomain.get(domain);
      if (!domainMap) {
        domainMap = new Map();
        byDomain.set(domain, domainMap);
      }
      const existing = domainMap.get(m.entity.id);
      if (existing) {
        existing.mentionCount += 1;
      } else {
        domainMap.set(m.entity.id, {
          entityId: m.entity.id,
          name: m.entity.name,
          type: m.entity.type,
          wikipediaUrl: m.entity.wikipediaUrl,
          mentionCount: 1,
        });
      }
    }

    return Array.from(byDomain.entries())
      .map(([domain, entityMap]) => ({
        domain,
        entities: Array.from(entityMap.values())
          .sort((a, b) => b.mentionCount - a.mentionCount)
          .slice(0, perDomainLimit),
      }))
      .sort((a, b) => b.entities.length - a.entities.length);
  }

  /**
   * Top entities for a single source domain across the whole corpus.
   */
  async getDomainEntities(
    domain: string,
    options: { limit?: number; type?: EntityType } = {},
  ): Promise<Array<{
    entityId: string;
    name: string;
    type: EntityType;
    wikipediaUrl: string | null;
    mentionCount: number;
    articleCount: number;
  }>> {
    const limit = options.limit ?? 20;
    const mentions = await this.prisma.entityMention.findMany({
      where: {
        article: { domain },
        ...(options.type && { entity: { type: options.type } }),
      },
      select: {
        articleId: true,
        entity: {
          select: {
            id: true,
            name: true,
            type: true,
            wikipediaUrl: true,
          },
        },
      },
    });

    const byEntity = new Map<string, {
      entityId: string;
      name: string;
      type: EntityType;
      wikipediaUrl: string | null;
      mentionCount: number;
      articleIds: Set<string>;
    }>();
    for (const m of mentions) {
      const e = byEntity.get(m.entity.id);
      if (e) {
        e.mentionCount += 1;
        e.articleIds.add(m.articleId);
      } else {
        byEntity.set(m.entity.id, {
          entityId: m.entity.id,
          name: m.entity.name,
          type: m.entity.type,
          wikipediaUrl: m.entity.wikipediaUrl,
          mentionCount: 1,
          articleIds: new Set([m.articleId]),
        });
      }
    }
    return Array.from(byEntity.values())
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, limit)
      .map(({ articleIds, ...rest }) => ({
        ...rest,
        articleCount: articleIds.size,
      }));
  }

  /**
   * Helper: Get top 5 articles mentioning the entity
   */
  private getTopArticles(
    mentions: Array<EntityMention & { article: any }>
  ) {
    const articleGroups = new Map<
      string,
      { title: string; url: string; domain: string; date: Date; count: number }
    >();

    mentions.forEach((m) => {
      if (articleGroups.has(m.article.id)) {
        const existing = articleGroups.get(m.article.id)!;
        existing.count++;
      } else {
        articleGroups.set(m.article.id, {
          title: m.article.title,
          url: m.article.canonicalUrl,
          domain: m.article.domain,
          date: m.article.publishedAt || m.article.createdAt,
          count: 1,
        });
      }
    });

    return Array.from(articleGroups.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([articleId, article]) => ({
        articleId,
        title: article.title,
        date: article.date.toISOString().split("T")[0],
        url: article.url,
        domain: article.domain,
        mentions: article.count,
      }));
  }

  /**
   * Helper: Get top domains mentioning the entity
   */
  private getTopDomains(mentions: Array<EntityMention & { article: any }>) {
    const domainMap = new Map<string, number>();

    mentions.forEach((mention) => {
      const domain = mention.article.domain;
      if (domain) {
        domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
      }
    });

    return Array.from(domainMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, mentions]) => ({
        domain,
        mentions,
      }));
  }

  /**
   * Helper: Generate daily trend for past N days
   */
  private generateTrend(
    mentions: EntityMention[],
    days: number
  ): Array<{ date: string; count: number }> {
    const dayMap = new Map<string, number>();
    const now = new Date();

    // Initialize all days with 0
    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split("T")[0];
      dayMap.set(dateStr, 0);
    }

    // Count mentions per day
    mentions.forEach((mention) => {
      const dateStr = mention.createdAt.toISOString().split("T")[0];
      if (dayMap.has(dateStr)) {
        dayMap.set(dateStr, (dayMap.get(dateStr) || 0) + 1);
      }
    });

    // Sort by date and return
    return Array.from(dayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }));
  }
}

// Create and export singleton instance
let entityQueryServiceInstance: EntityQueryService;

try {
  const prisma = new PrismaClient();
  entityQueryServiceInstance = new EntityQueryService(prisma);
} catch {
  // If Prisma client can't be created (e.g., DATABASE_URL not set in tests),
  // create a service without a prisma instance
  entityQueryServiceInstance = new EntityQueryService();
}

export { entityQueryServiceInstance as entityQueryService };
export { EntityQueryService };
