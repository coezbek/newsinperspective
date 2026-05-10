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
  console.log(`[enrich:${articleId}] step=findUnique`);
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      title: true,
      summary: true,
      fullText: true,
      translatedFullText: true,
      language: true,
      // Pull the per-article LLM enrichment so we can correct spaCy's
      // type errors (Stratford Butterfly Farm → PERSON, Wikimedia →
      // GPE, Taronga Zoo → PERSON). The LLM enrichment classifies
      // names directly into persons/organizations/places, which is
      // both more accurate than en_core_web_sm and free at this point
      // (we already paid for the call in stage 2).
      features: {
        where: { scopeType: "ARTICLE" },
        select: { featureSet: true },
        take: 1,
      },
    },
  });
  if (!article) {
    return { success: false, entitiesCount: 0, error: `Article not found: ${articleId}` };
  }
  console.log(`[enrich:${articleId}] step=text-picked len=${(article.translatedFullText ?? article.fullText ?? "").length}`);

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

  console.log(`[enrich:${articleId}] step=ner-call chars=${fullText.length}`);
  let candidates: EntityCandidate[] = [];
  try {
    const nerResult = await entityRecognitionService.recognizeEntities(fullText);
    console.log(`[enrich:${articleId}] step=ner-done entities=${nerResult.entities.length}`);
    candidates = nerResult.entities.map((entity) => ({
      entityText: entity.entityText,
      entityType: entity.entityType as EntityType,
      confidence: entity.confidence ?? 0.85,
      startOffset: entity.startOffset ?? 0,
      endOffset: entity.endOffset ?? (entity.startOffset ?? 0) + entity.entityText.length,
      context: extractContext(fullText, entity.startOffset ?? 0, 50),
    }));
  } catch (error) {
    // NER outage / misconfiguration is a real failure — count it as such so
    // the script's success rate reflects reality. Returning success:true here
    // hid a missing NER_SERVICE_URL behind "25/25 succeeded, 0 mentions".
    return {
      success: false,
      entitiesCount: 0,
      error: `NER failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (candidates.length === 0) {
    return { success: true, entitiesCount: 0 };
  }

  // LLM type override: when stage-2 enrichment classified a name as
  // PERSON/ORG/PLACE that disagrees with spaCy, trust the LLM. spaCy's
  // small model (en_core_web_sm) routinely mis-types organization names
  // as PERSON ("Stratford Butterfly Farm", "Taronga Zoo"), GPE
  // ("Wikimedia"), or partial-name fragments as the wrong type
  // ("Attenborough"→GPE while "David Attenborough"→PERSON). Match on the
  // full surface form, case-insensitive; ambiguous tokens stay spaCy-typed.
  const llmTypeBySurface = new Map<string, EntityType>();
  const featureSet = article.features?.[0]?.featureSet as
    | { persons?: unknown; organizations?: unknown; places?: unknown }
    | undefined;
  const collectNames = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  for (const n of collectNames(featureSet?.persons)) {
    llmTypeBySurface.set(n.toLowerCase().trim(), EntityType.PERSON);
  }
  for (const n of collectNames(featureSet?.organizations)) {
    llmTypeBySurface.set(n.toLowerCase().trim(), EntityType.ORG);
  }
  for (const n of collectNames(featureSet?.places)) {
    llmTypeBySurface.set(n.toLowerCase().trim(), EntityType.GPE);
  }
  let overrides = 0;
  for (const c of candidates) {
    const llmType = llmTypeBySurface.get(c.entityText.toLowerCase().trim());
    if (llmType && llmType !== c.entityType) {
      c.entityType = llmType;
      overrides += 1;
    }
  }
  if (overrides > 0) {
    console.log(`[enrich:${articleId}] step=llm-type-override applied=${overrides}`);
  }

  // Within-article partial-name fold for PERSON / ORG. spaCy frequently
  // emits both the full name and bare surname / first-name on subsequent
  // mentions ("David Attenborough" + "David" + "Attenborough", "Mike
  // Gunton" + "Gunton"). Each variant otherwise creates a separate
  // NamedEntity row and a separate Wikipedia lookup. Fold each single-token
  // mention into the matching multi-token canonical iff there is EXACTLY
  // ONE multi-token candidate of the same type that contains the bare
  // token — preserves disambiguation when an article mentions both
  // "David Attenborough" and "David Cameron".
  //
  // We mutate `candidates[].entityText` so downstream `distinctByKey`,
  // DB lookup, Wikipedia link, and the per-mention writes all converge
  // on the canonical surface form. Highlight offsets stay anchored to
  // the ORIGINAL token in the source text — clicking the bare "David"
  // highlights its 5-char span but resolves to the David Attenborough
  // entity row.
  for (const type of [EntityType.PERSON, EntityType.ORG] as const) {
    const multiTokenContaining = new Map<string, Set<string>>(); // bare token → multi-token names
    for (const c of candidates) {
      if (c.entityType !== type) continue;
      const tokens = c.entityText.split(/\s+/);
      if (tokens.length < 2) continue;
      for (const t of tokens) {
        const key = t.toLowerCase();
        const set = multiTokenContaining.get(key) ?? new Set<string>();
        set.add(c.entityText);
        multiTokenContaining.set(key, set);
      }
    }
    for (const c of candidates) {
      if (c.entityType !== type) continue;
      const tokens = c.entityText.split(/\s+/);
      if (tokens.length !== 1) continue;
      const longers = multiTokenContaining.get(c.entityText.toLowerCase());
      if (!longers || longers.size !== 1) continue;
      // Single unambiguous parent — fold.
      c.entityText = longers.values().next().value!;
    }
  }

  // Dedupe ONLY for the entity-creation/lookup pass — keep one canonical
  // candidate per (name, type) so we make one Wikipedia call per distinct
  // entity. The frontend needs every mention's offset to highlight all
  // occurrences, so we still emit one EntityMention row per occurrence below.
  const distinctByKey = new Map<string, EntityCandidate>();
  for (const c of candidates) {
    const key = linkCacheKey(c.entityText, c.entityType);
    const prev = distinctByKey.get(key);
    if (!prev || c.confidence > prev.confidence) distinctByKey.set(key, c);
  }
  const distinct = Array.from(distinctByKey.values());

  console.log(`[enrich:${articleId}] step=db-lookup distinct=${distinct.length} candidates=${candidates.length}`);
  // Single round-trip lookup for entities already in DB.
  const names = distinct.map((c) => c.entityText);
  const existing = await prisma.namedEntity.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true },
  });
  const existingByName = new Map(existing.map((e) => [e.name, e.id]));
  console.log(`[enrich:${articleId}] step=link-loop existing=${existing.length} toLink=${distinct.length - existing.length}`);

  // Link only the ones we don't already have, sharing the cache across articles.
  const toCreate: Array<{
    candidate: EntityCandidate;
    linked: LinkedFields;
  }> = [];
  // Two-phase: collect uncached candidates, batch-link them, then merge with
  // any in-flight LinkCache hits from concurrent workers. Cuts Wikipedia
  // round-trips from N (per entity) to N searches + ⌈hits/50⌉ summaries.
  const toLink: EntityCandidate[] = [];
  const linkedByText = new Map<string, LinkedFields>();
  for (const c of distinct) {
    if (existingByName.has(c.entityText)) continue;
    const inflight = cache.get(linkCacheKey(c.entityText, c.entityType));
    if (inflight) {
      const linked = await inflight;
      linkedByText.set(c.entityText, linked);
      continue;
    }
    toLink.push(c);
  }
  if (toLink.length > 0) {
    console.log(`[enrich:${articleId}] step=batch-link n=${toLink.length}`);
    const linkedEntities = await entityLinkerService.linkEntities(
      toLink.map((c) => ({
        entityText: c.entityText,
        entityType: c.entityType,
        confidence: c.confidence,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        context: c.context,
      })),
    );
    for (let i = 0; i < toLink.length; i++) {
      const c = toLink[i]!;
      const le = linkedEntities[i]!;
      const fields: LinkedFields = {
        wikipediaUrl: le.wikipediaUrl ?? null,
        summary: le.summary ?? null,
        imageUrl: le.imageUrl ?? null,
      };
      linkedByText.set(c.entityText, fields);
      // Seed the in-flight cache for sibling workers covering the same name.
      cache.set(linkCacheKey(c.entityText, c.entityType), Promise.resolve(fields));
    }
  }
  for (const c of distinct) {
    if (existingByName.has(c.entityText)) continue;
    const linked = linkedByText.get(c.entityText) ?? {
      wikipediaUrl: null,
      summary: null,
      imageUrl: null,
    };
    toCreate.push({ candidate: c, linked });
  }
  console.log(`[enrich:${articleId}] step=write toCreate=${toCreate.length}`);

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

  // Emit one EntityMention per ORIGINAL candidate (not per distinct entity)
  // so the frontend can highlight every occurrence by its own offset.
  const mentionRows: Prisma.EntityMentionCreateManyInput[] = [];
  for (const c of candidates) {
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

  console.log(`[enrich] counting matched articles…`);
  const matched = await prisma.article.count({ where });
  console.log(`[enrich] matched=${matched}, fetching ids…`);
  const articles = await prisma.article.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
    ...(options.limit ? { take: options.limit } : {}),
  });
  console.log(`[enrich] got ${articles.length} ids`);

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
      console.log(`[enrich] start ${idx + 1}/${articles.length} ${article.id}`);
      try {
        const result = await enrichOne(article.id, cache);
        console.log(`[enrich] done ${idx + 1}/${articles.length} ${article.id} success=${result.success} mentions=${result.entitiesCount}${result.error ? " err=" + result.error : ""}`);
        if (result.success) {
          succeeded++;
          entitiesExtracted += result.entitiesCount;
        } else {
          failed++;
          if (result.error) logger.warn(`Enrichment error for ${article.id}: ${result.error}`);
        }
      } catch (error) {
        failed++;
        console.log(`[enrich] threw ${article.id}: ${error instanceof Error ? error.message : String(error)}`);
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
