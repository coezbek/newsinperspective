/**
 * Entity Recognition Type Definitions
 *
 * This file defines all types and interfaces used for Named Entity Recognition (NER)
 * including raw NER results, processed entities, and statistics.
 */

// Re-export Prisma-generated EntityType so domain & DB types are identical.
export { EntityType } from "@prisma/client";
import { EntityType } from "@prisma/client";

/**
 * Raw entity recognition result from NLP model
 * This is what the NER model returns before any processing
 */
export interface RawEntity {
  text: string;                    // The actual text of the entity
  type: EntityType;                // Classification of the entity
  startOffset: number;             // Character position where entity starts in text
  endOffset: number;               // Character position where entity ends
  confidence?: number;             // Model confidence score (0-1)
  context?: string;                // Surrounding context (optional)
}

/**
 * Processed entity mention in an article
 * Represents a specific occurrence of an entity in a document
 */
export interface EntityMention {
  entityText: string;              // The recognized entity text
  entityType: EntityType;          // Type of entity
  startOffset: number;             // Start character position
  endOffset: number;               // End character position
  confidence: number;              // Confidence score (0-1)
  context: string;                 // 50 characters of surrounding context
  articleId?: string;              // Reference to article (if processed)
}

/**
 * Named entity with metadata
 * Represents a unique entity that may appear in multiple articles
 */
export interface NamedEntityInfo {
  id?: string;                     // Database ID
  name: string;                    // Canonical name of entity
  type: EntityType;                // Entity type classification
  mentions: number;                // Total number of mentions
  confidence: number;              // Average confidence across mentions
  wikiUrl?: string;                // Wikipedia URL (if linked)
  summary?: string;                // Wikipedia summary
  imageUrl?: string;               // Image URL
}

/**
 * Entity recognition result with statistics
 * Complete information about a recognized and processed entity
 */
export interface EntityRecognitionResult {
  entities: EntityMention[];       // List of recognized entities
  totalEntities: number;           // Total count of entities
  processingTime: number;          // Time taken to process (ms)
  confidence: {
    min: number;                   // Minimum confidence in results
    max: number;                   // Maximum confidence in results
    average: number;               // Average confidence
  };
  byType: {                        // Count of entities by type
    [key in EntityType]?: number;
  };
}

/**
 * Entity statistics from database
 * Aggregated statistics about entity mentions over time
 */
export interface EntityStatistics {
  totalMentions: number;           // Total mentions across all articles
  uniqueArticles: number;          // Number of different articles mentioning entity
  mentions7Days: number;           // Mentions in past 7 days
  mentions30Days: number;          // Mentions in past 30 days
  lastUpdated: Date;               // When statistics were last updated
  trend?: {                        // Trend data (daily)
    date: string;                  // YYYY-MM-DD format
    mentions: number;              // Mentions on that day
  }[];
}

/**
 * Co-occurrence relationship between two entities
 * Tracks which entities appear together in articles
 */
export interface EntityCooccurrence {
  entity1: {
    id: string;
    name: string;
    type: EntityType;
  };
  entity2: {
    id: string;
    name: string;
    type: EntityType;
  };
  cooccurrenceCount: number;       // Number of times they appear together
  lastOccurrence: Date;            // Most recent co-occurrence
}

/**
 * Configuration for entity recognition
 */
export interface NERConfig {
  minConfidence: number;           // Minimum confidence threshold (0-1)
  entityTypes?: EntityType[];      // Filter to specific entity types
  maxEntitiesPerArticle?: number;  // Limit number of entities returned
}

/**
 * Error response for entity processing
 */
export interface EntityProcessingError {
  articleId: string;
  error: string;
  timestamp: Date;
  failedEntities?: RawEntity[];
}

/**
 * Wikipedia search result from Wikipedia API
 * Used during entity linking process
 */
export interface WikipediaSearchResult {
  title: string;                // 页面标题 (e.g., "Vladimir Putin")
  pageid: number;               // Wikipedia 页面ID
  ns: number;                   // 命名空间 (0 = main article, 1 = talk page)
  snippet?: string;             // 搜索摘要
  thumbnail?: {
    url: string;                // 缩略图URL
  };
}

/**
 * Entity with Wikipedia information
 * Extended EntityMention with Wikipedia links and metadata
 */
export interface LinkedEntity extends EntityMention {
  wikipediaUrl?: string;        // https://en.wikipedia.org/wiki/Vladimir_Putin
  summary?: string;             // Wikipedia摘要 (前2-3句)
  imageUrl?: string;            // Infobox图片URL
  linkedAt?: Date;              // 链接时间戳
  pageId?: number;              // Wikipedia 页面ID
}

/**
 * Wikipedia page content
 * Data fetched from Wikipedia API for display
 */
export interface WikipediaPageContent {
  summary?: string;             // 文章摘要
  imageUrl?: string;            // Infobox或第一张图片
  lastModified?: string;        // 最后编辑时间
}
