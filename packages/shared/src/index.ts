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

export const storyComparisonSchema = z.object({
  storyId: z.string(),
  date: isoDateSchema,
  dateFrom: isoDateSchema,
  dateUntil: isoDateSchema,
  title: z.string(),
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
export type StoryComparison = z.infer<typeof storyComparisonSchema>;
export type SourceProfileDto = z.infer<typeof sourceProfileSchema>;
export type StoryFacetDto = z.infer<typeof storyFacetSchema>;
export type TagProfileDto = z.infer<typeof tagProfileSchema>;
