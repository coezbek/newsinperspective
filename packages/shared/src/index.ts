import { z } from "zod";

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const articleComparisonSchema = z.object({
  articleId: z.string(),
  title: z.string(),
  domain: z.string(),
  publishedAt: z.string(),
  sentiment: z.number(),
  subjectivity: z.number(),
  biasSignals: z.array(z.string()),
  sharedKeywords: z.array(z.string()),
});

export const storyListItemSchema = z.object({
  id: z.string(),
  date: isoDateSchema,
  dateFrom: isoDateSchema,
  dateUntil: isoDateSchema,
  importanceScore: z.number(),
  title: z.string(),
  translatedTitle: z.string().nullable().optional(),
  region: z.string().nullable(),
  category: z.string().nullable(),
  articleCount: z.number().int(),
  sourceCount: z.number().int(),
  topDomains: z.array(z.string()),
  keywords: z.array(z.string()),
});

export const storyDetailSchema = storyListItemSchema.extend({
  articles: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string().url(),
      domain: z.string(),
      syndicatedDomains: z.array(z.string()),
      nearDuplicatePeers: z.array(
        z.object({
          articleId: z.string(),
          title: z.string(),
          domain: z.string(),
          url: z.string().url(),
        }),
      ),
      sourceName: z.string(),
      publishedAt: z.string(),
      summary: z.string().nullable(),
      contentSnippet: z.string().nullable(),
      fullText: z.string().nullable(),
      extractionStatus: z.enum(["PENDING", "SUCCESS", "FAILED"]),
      keywords: z.array(z.string()),
      sentiment: z.number(),
      subjectivity: z.number(),
      biasSignals: z.array(z.string()),
    }),
  ),
});

export const articleDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  language: z.string().nullable(),
  url: z.string().url(),
  domain: z.string(),
  syndicatedDomains: z.array(z.string()),
  nearDuplicatePeers: z.array(
    z.object({
      articleId: z.string(),
      title: z.string(),
      domain: z.string(),
      url: z.string().url(),
    }),
  ),
  sourceName: z.string(),
  publishedAt: z.string(),
  summary: z.string().nullable(),
  contentSnippet: z.string().nullable(),
  fullText: z.string().nullable(),
  fullTextIsTranslated: z.boolean(),
  extractionStatus: z.enum(["PENDING", "SUCCESS", "FAILED"]),
  keywords: z.array(z.string()),
  sentiment: z.number(),
  subjectivity: z.number(),
  biasSignals: z.array(z.string()),
  relatedStory: z
    .object({
      id: z.string(),
      title: z.string(),
      translatedTitle: z.string().nullable().optional(),
      date: isoDateSchema,
      dateFrom: isoDateSchema,
      dateUntil: isoDateSchema,
      region: z.string().nullable(),
      category: z.string().nullable(),
      articleCount: z.number().int(),
      sourceCount: z.number().int(),
    })
    .nullable(),
});

export const storyComparisonSchema = z.object({
  storyId: z.string(),
  date: isoDateSchema,
  dateFrom: isoDateSchema,
  dateUntil: isoDateSchema,
  title: z.string(),
  translatedTitle: z.string().nullable().optional(),
  sharedKeywords: z.array(z.string()),
  commonEntities: z.array(z.string()),
  domainSpread: z.array(z.string()),
  framingSummary: z.array(z.string()),
  articleComparisons: z.array(articleComparisonSchema),
});

export const sourceProfileSchema = z.object({
  domain: z.string(),
  sourceName: z.string(),
  description: z.string().nullable(),
  country: z.string().nullable(),
  countryOfOrigin: z.string().nullable(),
  headquarters: z.string().nullable(),
  mediaOwner: z.string().nullable(),
  ownershipType: z.string().nullable(),
  employeeCount: z.number().int().nullable(),
  wikipediaUrl: z.string().url().nullable(),
  associatedEntities: z.array(z.string()),
  articleCount: z.number().int(),
  averageSentiment: z.number(),
  commonBiasSignals: z.array(z.string()),
  topCategories: z.array(
    z.object({
      label: z.string(),
      count: z.number().int(),
    }),
  ),
  topKeywords: z.array(z.string()),
  latestStoryDate: isoDateSchema.nullable(),
  stories: z.array(storyListItemSchema),
});

export const tagProfileSchema = z.object({
  keyword: z.string(),
  normalizedKeyword: z.string(),
  storyCount: z.number().int(),
  articleCount: z.number().int(),
  sourceCount: z.number().int(),
  dateFrom: isoDateSchema.nullable(),
  dateUntil: isoDateSchema.nullable(),
  topDomains: z.array(
    z.object({
      label: z.string(),
      count: z.number().int(),
    }),
  ),
  topCategories: z.array(
    z.object({
      label: z.string(),
      count: z.number().int(),
    }),
  ),
  relatedKeywords: z.array(z.string()),
  relatedEntities: z.array(z.string()),
  stories: z.array(storyListItemSchema),
  articles: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string().url(),
      domain: z.string(),
      publishedAt: z.string(),
      summary: z.string().nullable(),
      keywords: z.array(z.string()),
    }),
  ),
});

export const storyFacetSchema = z.object({
  date: isoDateSchema,
  regions: z.array(z.string()),
  categories: z.array(z.string()),
});

export type StoryListItem = z.infer<typeof storyListItemSchema>;
export type StoryDetail = z.infer<typeof storyDetailSchema>;
export type ArticleDetail = z.infer<typeof articleDetailSchema>;
export type StoryComparison = z.infer<typeof storyComparisonSchema>;
export type SourceProfileDto = z.infer<typeof sourceProfileSchema>;
export type StoryFacetDto = z.infer<typeof storyFacetSchema>;
export type TagProfileDto = z.infer<typeof tagProfileSchema>;

// ============================================================
// Entity API Schemas (NER + Wikipedia linking)
// ============================================================

const entityTypeEnum = z.enum(["PERSON", "GPE", "ORG", "EVENT"]);

export const articleEntitiesQuerySchema = z.object({
  type: entityTypeEnum.optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const linkedEntitySchema = z.object({
  id: z.string(),
  entityText: z.string(),
  entityType: entityTypeEnum,
  confidence: z.number().min(0).max(1),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  context: z.string(),
  articleId: z.string(),
  wikipediaUrl: z.string().url().optional(),
  summary: z.string().optional(),
  imageUrl: z.string().url().optional(),
  linkedAt: z.date().optional(),
  pageId: z.number().int().optional(),
});

export const articleEntitiesResponseSchema = z.object({
  articleId: z.string(),
  title: z.string(),
  totalEntities: z.number().int(),
  byType: z.object({
    PERSON: z.number().int().optional(),
    GPE: z.number().int().optional(),
    ORG: z.number().int().optional(),
    EVENT: z.number().int().optional(),
  }),
  entities: z.array(linkedEntitySchema),
});

export const entityIdParamsSchema = z.object({
  entityId: z.string().min(1),
});

export const entityStatisticsSchema = z.object({
  totalMentions: z.number().int(),
  articlesCount: z.number().int(),
  mentions7Days: z.number().int(),
  mentions30Days: z.number().int(),
  topArticles: z.array(
    z.object({
      articleId: z.string(),
      title: z.string(),
      date: isoDateSchema,
      url: z.string().url(),
      domain: z.string(),
      mentions: z.number().int(),
    }),
  ),
  topDomains: z.array(
    z.object({
      domain: z.string(),
      mentions: z.number().int(),
    }),
  ),
  cooccurrences: z.array(
    z.object({
      entityId: z.string(),
      name: z.string(),
      type: entityTypeEnum,
      cooccurrenceCount: z.number().int(),
    }),
  ),
  trend: z.array(
    z.object({
      date: isoDateSchema,
      count: z.number().int(),
    }),
  ),
});

export const entityDetailResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: entityTypeEnum,
  wikipediaUrl: z.string().url().optional(),
  summary: z.string().optional(),
  imageUrl: z.string().url().optional(),
  wikidataId: z.string().optional(),
  statistics: entityStatisticsSchema,
});

export const searchEntitiesQuerySchema = z.object({
  q: z.string().min(1).max(100),
  type: entityTypeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const entitySearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: entityTypeEnum,
  wikipediaUrl: z.string().url().optional(),
  mentionsCount: z.number().int(),
  articlesCount: z.number().int(),
  relevanceScore: z.number().min(0).max(1),
});

export const searchEntitiesResponseSchema = z.object({
  query: z.string(),
  totalResults: z.number().int(),
  results: z.array(entitySearchResultSchema),
});

export type ArticleEntitiesQuery = z.infer<typeof articleEntitiesQuerySchema>;
export type LinkedEntity = z.infer<typeof linkedEntitySchema>;
export type ArticleEntitiesResponse = z.infer<typeof articleEntitiesResponseSchema>;
export type EntityIdParams = z.infer<typeof entityIdParamsSchema>;
export type EntityStatistics = z.infer<typeof entityStatisticsSchema>;
export type EntityDetailResponse = z.infer<typeof entityDetailResponseSchema>;
export type SearchEntitiesQuery = z.infer<typeof searchEntitiesQuerySchema>;
export type EntitySearchResult = z.infer<typeof entitySearchResultSchema>;
export type SearchEntitiesResponse = z.infer<typeof searchEntitiesResponseSchema>;
