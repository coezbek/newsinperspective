import { createHash } from "node:crypto";
import { Prisma, ScopeType } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildArticleFeaturesWithOpenRouter, buildClusterKeywordsWithOpenRouter } from "./nlp.js";
import { enrichSourceProfileWithOpenRouter } from "./source-profile-enrichment.js";
import { enrichSourceProfileFromWikidata } from "./source-profile-wikidata.js";

type JsonObject = Record<string, unknown>;

/**
 * Stable signature over the (articleId, title|summary|body) tuples that
 * went into a cluster's LLM-generated keyword set. Stored alongside the
 * keywords so a later run can detect whether any contributing article has
 * been re-enriched and the keywords are now stale.
 *
 * Mirror of `buildClusterInputSignature` in cluster-perspective.ts but
 * keyed on the keyword-input fields (title + summary + body) rather than
 * the embedding-input field (framingSummary / translatedFullText). Both
 * caches invalidate independently; an article body re-extraction can
 * change keywords without changing the perspective if framingSummary
 * stays stable, and vice versa.
 */
export function hashKeywordInput(input: { title: string; summary: string | null; body: string | null }): string {
  const concat = `${input.title}\n\n${input.summary ?? ""}\n\n${input.body ?? ""}`;
  return createHash("sha256").update(concat).digest("hex").slice(0, 16);
}

export function buildClusterKeywordSignature(
  pairs: Array<{ articleId: string; hash: string }>,
): string {
  const sorted = [...pairs].sort((a, b) => a.articleId.localeCompare(b.articleId));
  const joined = sorted.map((p) => `${p.articleId}:${p.hash}`).join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function joinText(parts: Array<string | null | undefined>, maxLength: number): string {
  return parts.filter((value): value is string => Boolean(value)).join("\n\n").slice(0, maxLength);
}

function pickLanguage(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Detect whether a cluster title is plausibly already English.
 *
 * Heuristic: pure-ASCII titles are treated as English. Headlines are
 * frequently telegraphic ("U.S. launches Hormuz shipping mission; Iran warns
 * forces away") and lack common function words, so a function-word check
 * over-flags them. The cost of mis-classifying an ASCII non-English title
 * (e.g. unaccented Spanish) as English is that we leave it untranslated —
 * acceptable, since populating `translatedTitle` with a different English
 * headline would only add noise. The cost of mis-classifying an English
 * headline as non-English is real noise in the column, which we want to avoid.
 */
function clusterTitleLooksEnglish(title: string): boolean {
  return /^[\x00-\x7F]+$/.test(title);
}

/**
 * Fallback: when no cached translation exists, borrow the title of an
 * English-language article in the cluster. Kagi clusters often span
 * languages — an English wire-feed item in the cluster makes a perfectly
 * legible substitute for an unreadable Croatian/Macedonian/Romanian
 * cluster title, even if the wording isn't a direct translation.
 *
 * Returns the highest-ranked (most-representative) English article's title,
 * or null if the cluster has no English-language article.
 */
async function pickEnglishArticleTitleFallback(clusterId: string): Promise<string | null> {
  const links = await prisma.clusterArticle.findMany({
    where: {
      clusterId,
      article: { language: { startsWith: "en", mode: "insensitive" } },
    },
    select: { article: { select: { title: true } } },
    orderBy: { rank: "asc" },
    take: 5,
  });
  for (const link of links) {
    const t = link.article?.title?.trim();
    if (t) return t;
  }
  return null;
}

/**
 * For non-English clusters, look at the cluster's articles' cached
 * NlpFeature.featureSet.translatedTitle and reuse one. Prefer an exact match
 * to the cluster title (Kagi often picks the cluster title from one of the
 * articles); otherwise fall back to the first non-empty translated title;
 * otherwise fall back to an English-language article's title in the same
 * cluster (free — no LLM call).
 */
async function pickClusterTranslatedTitle(
  clusterId: string,
  clusterTitle: string,
): Promise<string | null> {
  const features = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.ARTICLE,
      article: { clusterLinks: { some: { clusterId } } },
    },
    select: {
      featureSet: true,
      article: { select: { title: true, language: true } },
    },
  });
  const candidates: Array<{ original: string; translated: string }> = [];
  for (const f of features) {
    const set = f.featureSet as JsonObject;
    const translated = typeof set.translatedTitle === "string" ? set.translatedTitle.trim() : "";
    if (!translated || !f.article) continue;
    const isEnglish =
      !f.article.language || f.article.language.toLowerCase().slice(0, 2) === "en";
    if (isEnglish) continue;
    if (translated.toLowerCase() === f.article.title.toLowerCase()) continue;
    candidates.push({ original: f.article.title, translated });
  }
  if (candidates.length === 0) {
    // No cached translations from foreign-language articles — try the
    // English-article-title fallback before giving up. Skip the fallback for
    // titles that already look English; preserving them as-is is harmless
    // and avoids cluttering the column when no translation is needed.
    if (clusterTitleLooksEnglish(clusterTitle)) return null;
    return pickEnglishArticleTitleFallback(clusterId);
  }
  const exact = candidates.find(
    (c) => c.original.trim().toLowerCase() === clusterTitle.trim().toLowerCase(),
  );
  if (exact) return exact.translated;
  // Prefer the article whose original title shares the most word tokens with
  // the cluster title — clusters typically rephrase one of their articles, so
  // token overlap is a decent heuristic for "this article is the cluster's
  // canonical headline". Tie-breaker: insertion order.
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
  const clusterTokens = tokenize(clusterTitle);
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    for (const tok of tokenize(c.original)) if (clusterTokens.has(tok)) score += 1;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best.translated;
}

/**
 * Public alias for use by the one-off cluster-translate-titles backfill
 * script. Exposes the same logic the runtime backlog uses, without
 * importing all of runOpenRouterBacklog.
 */
export const pickClusterTranslatedTitleForBackfill = pickClusterTranslatedTitle;

function sourceProfileNeedsEnrichment(row: {
  description: string | null;
  country: string | null;
  headquarters: string | null;
  mediaOwner: string | null;
  wikipediaUrl: string | null;
}): boolean {
  return !row.description || !row.country || !row.headquarters || !row.mediaOwner || !row.wikipediaUrl;
}

export async function runOpenRouterBacklog(options?: {
  articleLimit?: number;
  clusterLimit?: number;
  sourceLimit?: number;
  date?: string;
  log?: (message: string) => void;
}): Promise<{
  articles: { attempted: number; ready: number; failed: number };
  clusters: { attempted: number; ready: number; pending: number };
  sources: { attempted: number; enriched: number; failed: number };
}> {
  const log = options?.log ?? (() => {});
  const articleLimit = parsePositiveInt(options?.articleLimit, 25);
  const clusterLimit = parsePositiveInt(options?.clusterLimit, 10);
  const sourceLimit = parsePositiveInt(options?.sourceLimit, 10);
  const dateWhere = options?.date
    ? {
        gte: new Date(`${options.date}T00:00:00.000Z`),
        lte: new Date(`${options.date}T23:59:59.999Z`),
      }
    : undefined;

  const articleFeatures = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.ARTICLE,
      ...(dateWhere ? { article: { ingestionDate: dateWhere } } : {}),
    },
    include: {
      article: {
        select: {
          id: true,
          title: true,
          summary: true,
          contentSnippet: true,
          fullText: true,
          language: true,
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: articleLimit * 4,
  });

  // Compute the current article-enrichment input signature for every
  // fetched article up-front. The signature mirrors what the LLM will
  // see in `buildArticleFeaturesWithOpenRouter` — title + summary + body
  // — so a body re-extraction or a title cleanup automatically marks
  // the existing enrichment as stale.
  const currentArticleSignatures = new Map<string, string>();
  for (const feature of articleFeatures) {
    if (!feature.article) continue;
    const a = feature.article;
    const sig = hashKeywordInput({
      title: a.title,
      summary: a.summary,
      body: a.fullText ?? a.contentSnippet,
    });
    currentArticleSignatures.set(feature.id, sig);
  }

  const pendingArticles = articleFeatures
    .filter((feature) => feature.article)
    .filter((feature) => {
      const payload = feature.featureSet as JsonObject;
      // Pending: never enriched, OR previously enriched but the input
      // text has changed since (re-extraction / title cleanup / etc.) so
      // the cached translatedFullText / framingSummary / keywords now
      // describe stale text. Without this guard, an article re-enriched
      // by a weaker model in an earlier run (returning empty keywords →
      // heuristic native-language fallback) stays "ready" forever — see
      // the orf.at "angriff getötet menschen" bug from May 2026.
      if (payload.aiEnrichmentStatus !== "ready") return true;
      const stored = typeof payload.aiEnrichmentInputSignature === "string"
        ? payload.aiEnrichmentInputSignature
        : null;
      const current = currentArticleSignatures.get(feature.id) ?? null;
      // Trust-by-default: only re-enrich when BOTH signatures are present
      // and they actually disagree. Missing-signature is treated as
      // "grandfathered, leave alone" — pre-this-guard data is validated
      // explicitly via the one-shot `backfill-signatures` script which
      // writes a current signature to every "ready" row, after which any
      // future text change reliably invalidates.
      return stored !== null && current !== null && stored !== current;
    })
    .slice(0, articleLimit);

  let articleReady = 0;
  let articleFailed = 0;

  for (const feature of pendingArticles) {
    const article = feature.article!;
    const body = article.fullText ?? article.contentSnippet;
    const current = feature.featureSet as JsonObject;
    try {
      const next = await buildArticleFeaturesWithOpenRouter(
        article.title,
        article.summary,
        body,
        article.language,
        {
          onAttemptLog: (msg) =>
            console.log(`[openrouter-backlog][article ${article.id}] ${msg}`),
        },
      );
      await prisma.nlpFeature.update({
        where: { id: feature.id },
        data: {
          featureSet: toInputJson({
            ...current,
            ...next,
            aiEnrichmentStatus: "ready",
            // Persist the actual model that produced this enrichment so
            // we can audit which OpenRouter free model carried the load,
            // and so cache hits surface as "openrouter-cache" instead of
            // a misleading model name.
            aiEnrichmentModel: next.llmModel ?? "openrouter-cache",
            aiEnrichmentError: next.llmError ?? null,
            aiEnrichedAt: new Date().toISOString(),
            // Truncation signals from the enrichment call. `inputTruncated`
            // tells us whether WE sliced the body before sending it to the
            // model — true means downstream consumers should prioritise this
            // article for re-extraction with longer source text.
            // `bodyAppearsTruncated` is the model's own judgment of whether
            // the body it received looked cut off. Stored alongside the
            // enrichment so future re-extraction / quality dashboards can
            // surface partial-content articles without recomputing.
            aiEnrichmentInputTruncated: next.inputTruncated,
            aiEnrichmentBodyAppearsTruncated: next.bodyAppearsTruncated,
            // Hash of the title+summary+body the LLM saw. On the next
            // backlog pass, a mismatch flips this row back to pending
            // automatically — covers body re-extraction, title cleanup,
            // or any other upstream content change. Mirrors the
            // signature pattern used for cluster perspective and cluster
            // keywords.
            aiEnrichmentInputSignature: currentArticleSignatures.get(feature.id) ?? null,
          }),
        },
      });
      // When the LLM determines the input is non-newsworthy boilerplate, we
      // explicitly null stance-bearing fields so a re-classification (or a
      // model upgrade that newly recognises boilerplate) clears stale values
      // instead of leaving them stuck at whatever the previous enrichment
      // produced. Same goes for re-classification in the other direction:
      // when isNewsworthy is true we always write the latest values, even if
      // they're null (model couldn't extract a usable framing summary etc.).
      const articleUpdate: {
        summary?: string;
        translatedTitle?: string | null;
        translatedSummary?: string | null;
        translatedFullText?: string | null;
        framingSummary?: string | null;
        language?: string;
        extractionStatus?: "FAILED";
        extractionError?: string;
      } = {};
      if (next.isNewsworthy === false) {
        articleUpdate.translatedTitle = null;
        articleUpdate.translatedSummary = null;
        articleUpdate.translatedFullText = null;
        articleUpdate.framingSummary = null;
        articleUpdate.extractionStatus = "FAILED";
        articleUpdate.extractionError = `Not newsworthy: ${next.notNewsworthyReason ?? "boilerplate"}`;
      } else {
        if (!article.summary && next.translatedSummary) {
          articleUpdate.summary = next.translatedSummary;
        }
        articleUpdate.translatedTitle = next.translatedTitle;
        articleUpdate.translatedSummary = next.translatedSummary;
        articleUpdate.translatedFullText = next.translatedFullText;
        articleUpdate.framingSummary = next.framingSummary;
      }
      // Persist detected language so downstream stages (entity-re-enrich) can
      // branch on it without inspecting NlpFeature.featureSet.
      if (!article.language && typeof next.language === "string" && next.language.trim()) {
        articleUpdate.language = next.language.trim().toLowerCase();
      }
      if (Object.keys(articleUpdate).length > 0) {
        await prisma.article.update({
          where: { id: article.id },
          data: articleUpdate as never,
        });
      }
      articleReady += 1;
      log(
        `[openrouter-backlog][article] ready ${article.id}${
          next.isNewsworthy === false
            ? ` (not newsworthy: ${next.notNewsworthyReason ?? "boilerplate"})`
            : ""
        }`,
      );
    } catch (error) {
      await prisma.nlpFeature.update({
        where: { id: feature.id },
        data: {
          featureSet: toInputJson({
            ...current,
            aiEnrichmentStatus: "failed",
            aiEnrichmentError: error instanceof Error ? error.message : String(error),
            aiEnrichedAt: new Date().toISOString(),
          }),
        },
      });
      articleFailed += 1;
      log(`[openrouter-backlog][article] failed ${article.id}`);
    }
  }

  const clusterFeatures = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      ...(dateWhere ? { cluster: { storyDate: dateWhere } } : {}),
    },
    include: {
      cluster: {
        select: {
          id: true,
          title: true,
          translatedTitle: true,
          articles: {
            orderBy: { rank: "asc" },
            include: {
              article: {
                select: {
                  id: true,
                  title: true,
                  summary: true,
                  contentSnippet: true,
                  fullText: true,
                  language: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: clusterLimit * 4,
  });

  // Compute the current keyword-input signature for every fetched cluster
  // up-front, so the staleness check can compare against the stored value
  // without re-walking article text inside the filter callback.
  const currentKeywordSignatures = new Map<string, string>();
  for (const feature of clusterFeatures) {
    if (!feature.cluster) continue;
    const articles = feature.cluster.articles.slice(0, 6).map((item) => item.article);
    const signature = buildClusterKeywordSignature(
      articles.map((a) => ({
        articleId: a.id,
        hash: hashKeywordInput({
          title: a.title,
          summary: a.summary,
          body: a.fullText ?? a.contentSnippet,
        }),
      })),
    );
    currentKeywordSignatures.set(feature.id, signature);
  }

  const pendingClusters = clusterFeatures
    .filter((feature) => feature.cluster)
    .filter((feature) => {
      const payload = feature.featureSet as JsonObject;
      // Pending: never been keyworded, or keywords went stale because at
      // least one contributing article got re-enriched / re-extracted.
      // Stale "ready" rows fall back through this filter so the LLM gets
      // a fresh shot — without this, keyword sets persist forever and end
      // up describing pre-translation German/Korean/etc. body text long
      // after stage 2 has populated proper translations.
      if (payload.keywordStatus === "keywords_pending") return true;
      if (payload.keywordStatus === "ready") {
        const stored = typeof payload.keywordInputSignature === "string"
          ? payload.keywordInputSignature
          : null;
        const current = currentKeywordSignatures.get(feature.id) ?? null;
        // Trust-by-default (see equivalent comment on the article-level
        // filter above). Missing-signature rows are validated by the
        // backfill script, not by burning fresh LLM credits per-row.
        return stored !== null && current !== null && stored !== current;
      }
      return false;
    })
    .slice(0, clusterLimit);

  let clusterReady = 0;
  let clusterPending = 0;

  for (const feature of pendingClusters) {
    const cluster = feature.cluster!;
    const articles = cluster.articles.slice(0, 6).map((item) => item.article);
    const language = pickLanguage(articles.map((article) => article.language));
    const summary = joinText(articles.map((article) => article.summary), 3000);
    const body = joinText(articles.map((article) => article.fullText ?? article.contentSnippet), 6000);
    const current = feature.featureSet as JsonObject;

    const openrouter = await buildClusterKeywordsWithOpenRouter(
      cluster.title,
      articles.map((article) => ({
        title: article.title,
        summary: article.summary,
        body: article.fullText ?? article.contentSnippet,
        language: article.language ?? language,
      })),
      {
        onAttemptLog: (msg) =>
          console.log(`[openrouter-backlog][cluster ${cluster.id}] ${msg}`),
      },
    );

    await prisma.nlpFeature.update({
      where: { id: feature.id },
      data: {
        featureSet: toInputJson({
          ...current,
          keywords: openrouter.keywords.length > 0 ? openrouter.keywords : current.keywords,
          keywordSource: "openrouter",
          keywordStatus: openrouter.status,
          keywordModel: openrouter.model,
          keywordError: openrouter.error,
          // Record the input signature so a later run can detect when the
          // cluster's articles have been re-enriched and the keyword set
          // is stale. Recomputed on every read; mismatch = re-keyword.
          keywordInputSignature: currentKeywordSignatures.get(feature.id) ?? null,
        }),
      },
    });

    if (openrouter.status === "ready") {
      clusterReady += 1;
      log(`[openrouter-backlog][cluster] ready ${cluster.id}`);
    } else {
      clusterPending += 1;
      log(`[openrouter-backlog][cluster] pending ${cluster.id}`);
    }
  }

  // Backfill cluster translatedTitle for non-English clusters that don't yet
  // have one. Runs every backlog pass; cheap (no LLM call — just reuses the
  // article-level translatedTitle already cached in NlpFeature).
  const clustersMissingTranslation = await prisma.storyCluster.findMany({
    where: {
      translatedTitle: null,
      ...(dateWhere ? { storyDate: dateWhere } : {}),
    },
    select: { id: true, title: true },
    orderBy: { storyDate: "desc" },
    take: 200,
  });
  for (const cluster of clustersMissingTranslation) {
    const translatedTitle = await pickClusterTranslatedTitle(cluster.id, cluster.title);
    if (translatedTitle) {
      await prisma.storyCluster.update({
        where: { id: cluster.id },
        data: { translatedTitle },
      });
      log(`[openrouter-backlog][cluster] translatedTitle set ${cluster.id}`);
    }
  }

  const sourceProfiles = await prisma.sourceProfile.findMany({
    ...(dateWhere
      ? {
          where: {
            updatedAt: dateWhere,
          },
        }
      : {}),
    orderBy: { updatedAt: "asc" },
    take: sourceLimit * 4,
  });

  const pendingSources = sourceProfiles
    .filter((profile) => sourceProfileNeedsEnrichment(profile))
    .slice(0, sourceLimit);

  let sourceEnriched = 0;
  let sourceFailed = 0;

  // First pass: parallel-fetch Wikidata for every pending source. WDQS
  // tolerates a small fan-out, and the long-tail enrichment loop was
  // previously serial — turning it parallel collapses minutes of wall-clock
  // into seconds for the common case where Wikidata has the answer.
  // Filter out rows already fully resolved by Wikidata before spending
  // the round-trip.
  const wikidataConcurrency = env.SOURCE_ENRICHMENT_WIKIDATA_CONCURRENCY;
  const wikidataResults = new Map<
    string,
    Awaited<ReturnType<typeof enrichSourceProfileFromWikidata>>
  >();
  const candidates = pendingSources.filter((profile) => {
    if (profile.enrichmentModel === "wikidata" && profile.description) {
      return false;
    }
    return true;
  });
  for (let i = 0; i < candidates.length; i += wikidataConcurrency) {
    const batch = candidates.slice(i, i + wikidataConcurrency);
    const settled = await Promise.allSettled(
      batch.map((profile) =>
        enrichSourceProfileFromWikidata({
          domain: profile.domain,
          sourceName: profile.sourceName,
        }),
      ),
    );
    settled.forEach((s, idx) => {
      const profile = batch[idx]!;
      wikidataResults.set(
        profile.id,
        s.status === "fulfilled" ? s.value : null,
      );
    });
  }

  for (const profile of pendingSources) {
    // Skip rows already enriched from Wikidata that have a description —
    // re-running won't pull anything new from WDQS.
    if (profile.enrichmentModel === "wikidata" && profile.description) {
      continue;
    }

    let enrichment: Awaited<ReturnType<typeof enrichSourceProfileWithOpenRouter>> | null = null;
    let nextWikidataId: string | null = profile.wikidataId ?? null;

    const wd = wikidataResults.get(profile.id) ?? null;
    if (wd) {
      const { wikidataId: qid, ...rest } = wd;
      enrichment = rest;
      nextWikidataId = qid;
    }

    if (!enrichment) {
      // Wikidata had no entry for this domain. Niche / regional / blog
      // sources frequently fall here. With SOURCE_ENRICHMENT_WIKIDATA_ONLY
      // the LLM fallback is skipped — preferable when running budget-
      // sensitive batches, since the LLM otherwise hallucinates plausible
      // but unverifiable values for unknown outlets. We still mark the row
      // as "attempted" via lastEnrichedAt so it doesn't get re-picked on
      // every drain-loop iteration; the previous behaviour left
      // lastEnrichedAt unchanged on failure, which kept the same niche
      // sources looping forever and burned LLM credits each round.
      if (env.SOURCE_ENRICHMENT_WIKIDATA_ONLY) {
        await prisma.sourceProfile.update({
          where: { id: profile.id },
          data: { lastEnrichedAt: new Date() },
        });
        sourceFailed += 1;
        log(`[openrouter-backlog][source] skipped ${profile.domain} (no wikidata, LLM disabled)`);
        continue;
      }
      enrichment = await enrichSourceProfileWithOpenRouter({
        domain: profile.domain,
        sourceName: profile.sourceName,
      });
    }

    await prisma.sourceProfile.update({
      where: { id: profile.id },
      data: {
        description: profile.description ?? enrichment.description ?? null,
        country: profile.country ?? enrichment.country ?? null,
        countryOfOrigin: profile.countryOfOrigin ?? enrichment.countryOfOrigin ?? null,
        headquarters: profile.headquarters ?? enrichment.headquarters ?? null,
        mediaOwner: profile.mediaOwner ?? enrichment.mediaOwner ?? null,
        ownershipType: profile.ownershipType ?? enrichment.ownershipType ?? null,
        employeeCount: profile.employeeCount ?? enrichment.employeeCount ?? null,
        wikipediaUrl: profile.wikipediaUrl ?? enrichment.wikipediaUrl ?? null,
        associatedEntities: [...new Set([...profile.associatedEntities, ...enrichment.associatedEntities])].slice(0, 8),
        // Always advance lastEnrichedAt — even on enrichment failure. The
        // pendingSources query orders by updatedAt asc so an unchanged
        // timestamp would put failed niche sources back at the front of the
        // queue every drain-loop round, burning LLM credits on the same
        // un-enrichable rows. Recording the attempt ensures the next round
        // picks fresh candidates first; a separate periodic re-attempt job
        // can revisit failures later if their Wikidata coverage improves.
        lastEnrichedAt: new Date(),
        enrichmentModel: enrichment.model ?? profile.enrichmentModel,
        wikidataId: nextWikidataId,
      },
    });

    if (enrichment.error) {
      sourceFailed += 1;
      log(`[openrouter-backlog][source] failed ${profile.domain}`);
    } else {
      sourceEnriched += 1;
      log(`[openrouter-backlog][source] ready ${profile.domain} (${enrichment.model ?? "?"})`);
    }
  }

  return {
    articles: { attempted: pendingArticles.length, ready: articleReady, failed: articleFailed },
    clusters: { attempted: pendingClusters.length, ready: clusterReady, pending: clusterPending },
    sources: { attempted: pendingSources.length, enriched: sourceEnriched, failed: sourceFailed },
  };
}
