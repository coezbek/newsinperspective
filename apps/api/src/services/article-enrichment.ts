import { Prisma, EntityType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createFileLogger } from "../lib/file-logger.js";
import { entityRecognitionService } from "./entity-recognition.js";
import { entityLinkerService } from "./entity-linker.js";

const logger = createFileLogger("article-enrichment.log");

export interface ArticleEnrichmentOptions {
  date?: string;
  limit?: number;
  force?: boolean;
  articleIds?: string[];
  /** How many articles to enrich in parallel. Defaults to ENRICHMENT_CONCURRENCY env or 3. */
  concurrency?: number;
}

export interface ArticleEnrichmentResult {
  matched: number;
  attempted: number;
  succeeded: number;
  failed: number;
  entitiesExtracted: number;
}

interface LinkedFields {
  wikipediaUrl: string | null;
  summary: string | null;
  imageUrl: string | null;
}

interface EntityCandidate {
  entityText: string;
  entityType: EntityType;
  confidence: number;
  startOffset: number;
  endOffset: number;
  context: string;
}

/**
 * Per-batch in-memory cache of name→linked-fields. Wikipedia is the slow step;
 * a single shared cache means each unique entity name in a run is linked at most
 * once even if it appears across many articles.
 */
type LinkCache = Map<string, Promise<LinkedFields>>;

function makeLinkCache(): LinkCache {
  return new Map();
}

function linkCacheKey(name: string, type: EntityType): string {
  return `${type}::${name.toLowerCase()}`;
}

async function getLinkedFields(
  cache: LinkCache,
  candidate: EntityCandidate,
): Promise<LinkedFields> {
  const key = linkCacheKey(candidate.entityText, candidate.entityType);
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<LinkedFields> => {
    try {
      const linked = await entityLinkerService.linkEntity({
        entityText: candidate.entityText,
        entityType: candidate.entityType,
        confidence: candidate.confidence,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        context: candidate.context,
      });
      return {
        wikipediaUrl: linked.wikipediaUrl ?? null,
        summary: linked.summary ?? null,
        imageUrl: linked.imageUrl ?? null,
      };
    } catch (error) {
      logger.warn(`Wikipedia link failed for "${candidate.entityText}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { wikipediaUrl: null, summary: null, imageUrl: null };
    }
  })();
  cache.set(key, promise);
  return promise;
}

async function enrichOne(
  articleId: string,
  cache: LinkCache,
): Promise<{ success: boolean; entitiesCount: number; error?: string }> {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      title: true,
      summary: true,
      fullText: true,
      translatedFullText: true,
      language: true,
    },
  });
  if (!article) {
    return { success: false, entitiesCount: 0, error: `Article not found: ${articleId}` };
  }

  // spaCy uses en_core_web_sm; on non-English articles, prefer the LLM-produced
  // translatedFullText when it's available. Same convention as cluster-perspective.
  const isEnglish = !article.language || article.language.toLowerCase().slice(0, 2) === "en";
  const useTranslated = !isEnglish && article.translatedFullText && article.translatedFullText.trim().length > 0;
  const sourceText = useTranslated
    ? article.translatedFullText!.trim()
    : article.fullText || `${article.title}\n\n${article.summary || ""}`;
  const fullText = sourceText;
  if (!fullText.trim()) {
    return { success: false, entitiesCount: 0, error: "No text available for entity extraction" };
  }

  let candidates: EntityCandidate[] = [];
  try {
    const nerResult = await entityRecognitionService.recognizeEntities(fullText);
    candidates = nerResult.entities.map((entity) => ({
      entityText: entity.entityText,
      entityType: entity.entityType as EntityType,
      confidence: entity.confidence ?? 0.85,
      startOffset: entity.startOffset ?? 0,
      endOffset: entity.endOffset ?? (entity.startOffset ?? 0) + entity.entityText.length,
      context: extractContext(fullText, entity.startOffset ?? 0, 50),
    }));
  } catch (error) {
    return {
      success: true,
      entitiesCount: 0,
      error: `NER failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (candidates.length === 0) {
    return { success: true, entitiesCount: 0 };
  }

  // Dedupe per article on (name, type) — multiple mentions of the same entity
  // become one mention here; the per-mention table is for offset highlighting,
  // not frequency counting (counts come from grouping queries).
  const byKey = new Map<string, EntityCandidate>();
  for (const c of candidates) {
    const key = linkCacheKey(c.entityText, c.entityType);
    const prev = byKey.get(key);
    if (!prev || c.confidence > prev.confidence) byKey.set(key, c);
  }
  const unique = Array.from(byKey.values());

  // Single round-trip lookup for entities already in DB.
  const names = unique.map((c) => c.entityText);
  const existing = await prisma.namedEntity.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true },
  });
  const existingByName = new Map(existing.map((e) => [e.name, e.id]));

  // Link only the ones we don't already have, sharing the cache across articles.
  const toCreate: Array<{
    candidate: EntityCandidate;
    linked: LinkedFields;
  }> = [];
  for (const c of unique) {
    if (existingByName.has(c.entityText)) continue;
    const linked = await getLinkedFields(cache, c);
    toCreate.push({ candidate: c, linked });
  }

  // Bulk-create new NamedEntity rows; skipDuplicates handles the race where
  // a parallel article created the same entity between our findMany and now.
  if (toCreate.length > 0) {
    await prisma.namedEntity.createMany({
      data: toCreate.map(({ candidate, linked }) => ({
        name: candidate.entityText,
        type: candidate.entityType,
        wikipediaUrl: linked.wikipediaUrl,
        summary: linked.summary,
        imageUrl: linked.imageUrl,
      })),
      skipDuplicates: true,
    });
    const refreshed = await prisma.namedEntity.findMany({
      where: { name: { in: toCreate.map((x) => x.candidate.entityText) } },
      select: { id: true, name: true },
    });
    for (const r of refreshed) existingByName.set(r.name, r.id);
  }

  const mentionRows: Prisma.EntityMentionCreateManyInput[] = [];
  for (const c of unique) {
    const entityId = existingByName.get(c.entityText);
    if (!entityId) continue;
    mentionRows.push({
      entityId,
      articleId,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      context: c.context,
      confidence: c.confidence,
    });
  }

  if (mentionRows.length > 0) {
    await prisma.entityMention.createMany({ data: mentionRows });
  }

  return { success: true, entitiesCount: mentionRows.length };
}

/**
 * Enrich a single article. The kagi-ingest hook calls this; it builds a
 * one-shot link cache so the function stays self-contained.
 */
export async function enrichArticleWithEntities(
  articleId: string,
  _originalUrl: string,
): Promise<{ success: boolean; entitiesCount: number; error?: string }> {
  try {
    return await enrichOne(articleId, makeLinkCache());
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Article enrichment failed for ${articleId}`, { error: errorMsg });
    return { success: false, entitiesCount: 0, error: errorMsg };
  }
}

/**
 * Batch enrich articles. Shares one Wikipedia link cache across the run and
 * runs a small number of articles in parallel to keep the sidecar busy
 * without overwhelming the box.
 */
export async function enrichArticlesWithEntities(
  options: ArticleEnrichmentOptions = {},
): Promise<ArticleEnrichmentResult> {
  const where: Prisma.ArticleWhereInput = {};

  if (options.date) {
    where.ingestionDate = {
      gte: new Date(`${options.date}T00:00:00.000Z`),
      lte: new Date(`${options.date}T23:59:59.999Z`),
    };
  }
  if (!options.force) {
    where.entityMentions = { none: {} };
  }
  if (options.articleIds && options.articleIds.length > 0) {
    where.id = { in: options.articleIds };
  }

  const matched = await prisma.article.count({ where });
  const articles = await prisma.article.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
    ...(options.limit ? { take: options.limit } : {}),
  });

  const envConcurrency = Number.parseInt(process.env.ENRICHMENT_CONCURRENCY ?? "", 10);
  const concurrency = Math.max(
    1,
    options.concurrency ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 3),
  );
  const cache = makeLinkCache();

  let succeeded = 0;
  let failed = 0;
  let entitiesExtracted = 0;

  logger.info(
    `Starting entity enrichment: matched=${matched}, attempting=${articles.length}, concurrency=${concurrency}`,
  );

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= articles.length) return;
      const article = articles[idx]!;
      try {
        const result = await enrichOne(article.id, cache);
        if (result.success) {
          succeeded++;
          entitiesExtracted += result.entitiesCount;
        } else {
          failed++;
          if (result.error) logger.warn(`Enrichment error for ${article.id}: ${result.error}`);
        }
      } catch (error) {
        failed++;
        logger.error(`Article enrichment failed for ${article.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, articles.length) }, () => worker()),
  );

  logger.info(
    `Entity enrichment completed: succeeded=${succeeded}, failed=${failed}, entitiesExtracted=${entitiesExtracted}`,
  );

  return {
    matched,
    attempted: articles.length,
    succeeded,
    failed,
    entitiesExtracted,
  };
}

function extractContext(text: string, offset: number, contextLength: number = 50): string {
  const start = Math.max(0, offset - contextLength);
  const end = Math.min(text.length, offset + contextLength);
  return text.slice(start, end).trim();
}
