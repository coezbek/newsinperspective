# Known issues / follow-ups

Capture for things we know about but haven't fixed yet. Add ✅ when done; delete when no longer relevant.

## Recently shipped (2026-05-06)

- ✅ Perspective groups by `domain`, not `sourceName` — RSS section-feeds (SCMP had 23 sourceName variants) no longer inflate `n_sources` and weaken divergence.
- ✅ Kagi paths (`kagi-ingest.ts`, `kagi-import-clusters.ts`) compute `textFingerprint` over `fullText` instead of writing `null`.
- ✅ Entity enrichment (spaCy NER + Wikipedia/Wikidata linking) runs automatically on freshly-imported articles in `kagi-ingest`. Backfilling the historical 33k articles is out of scope — use `pnpm entity:re-enrich` if needed.
- ✅ README + About dialog corrected: API uses Fastify, not Express.

## Backlog from `/loop` data-quality audit (2026-05-06)

These items were surfaced over a 10-iteration database audit. Most are still open.

- **89% of articles missing `textFingerprint`** is mostly historical: the 2026-03-23 cohort (27,365 articles) was ingested before the current code path. A one-shot backfill that recomputes fingerprints over `fullText`/`summary` would unlock dedupe across that cohort.
- **`enrichArticleText` doesn't recompute features after extraction.** Once `fullText` is set, language / fingerprint / keywords / sentiment should be re-run over the better signal.
- **Boilerplate / paywall pages stored as `extractionStatus=SUCCESS`.** 96 articles have `fullText < 500 chars`; 48 contain paywall keywords. Should be flagged FAILED.
- **One-cluster-per-article invariant violated.** Top offender appears in 5 clusters. Add `@@unique([articleId])` to `ClusterArticle` or delete prior links before re-clustering.
- **Cluster title translation** would collapse the 8 language-fragmented Iran clusters into 1. Highest single-change UX impact for cluster quality.
- **`topCategory` is feed-bucket leakage**, not content topic.
- **Corpus geographic bias**: 38% of clusters come from Quebec + Berlin feed bundles.
- **`SourceProfile.averageSentiment` is dead data** (71.5% exactly 0.000). Either backfill from the perspective sidecar or stop displaying.
- **NlpFeature `kind` not indexed.** JSON path `featureSet->>'kind'` queries do full scans. Skipped per current scope.
- **`ClusterArticle.similarity` is degenerate** (only values 1 or 0.5). Compute real distance or rename to `isPrimary`.
- **`SourceProfile` metadata 10% complete** (description/headquarters/owner/wikipedia all null on 90% of profiles). Consider auto-enriching profiles with `articleCount > 50` once.
- **592 article-domains have no `SourceProfile`.** Backfill via stats from Article rows.
- **Same kagi `clusterKey` across snapshots → duplicate clusters** (10 cases observed).
- *RSS-only items deferred (we're kagi-only right now):* HTML-entity decode in titles · `language` normalisation (`en-US`/`en-us`/`en-CA` collapsed to `en`) · stale-article 3-day cutoff · auto-deactivate failing feeds · block `news.google.com` feeds.

## Clustering

- **Cluster fragmentation — same story split across multiple `StoryCluster` rows.**
  Observed in the 2026-05-04 backfill: ranks #2 and #3 in the divergence ranking are
  both about the Pentagon's $25 B Iran-war cost estimate but live as separate clusters
  (`cmomkd0gh018mjj16re16zmol` and `cmommo2a302kxjj16n42akft1`). Several other Iran/oil
  stories duplicate similarly. Pollutes top-N rankings on `/perspective`.
  Suspected cause: clustering threshold too tight, or per-snapshot keys preventing
  cross-day merging. Needs clustering-side investigation, not a perspective-side fix.

- **Cluster titles are not translated.** `StoryCluster.title` is whichever title the
  upstream feed produced, including non-English ones (e.g.
  "Brent premašio 125 dolara zbog blokade iranskih luka" at rank #1). UI prefers
  `story.translatedTitle` where present (StoryDetailPanel does this), but
  `/perspective` and the cluster-list endpoints render the raw `title` directly.
  Fix: backfill `translatedTitle` on `StoryCluster` (similar to `Article`), or
  translate at read time when only `title` is available.

## Source profiles

- **`SourceProfile.country` is null for most rows.** Both ingestion paths call
  `upsertSourceProfiles(..., { enrichMetadata: false })`, so the OpenRouter
  enrichment that fills `country` is never invoked at ingestion time. Mitigation
  in place: TLD + known-source dictionary fallback (`country-from-domain.ts`),
  with optional per-domain LLM tier-3 (`country-llm-resolver.ts`) that caches into
  `SourceProfile.country` on first use. To proactively populate, run a one-off
  enrichment job — script does not yet exist.

## Perspective intelligence

- **Threshold `0.15 / 0.25` is miscalibrated for this corpus.** Every cluster in the
  initial 30-cluster backfill scored ≥ 0.343 (label `very_high`). Recommend
  recalibrating after a larger sample is in (≥ 100 clusters). Look at the
  histogram on `/perspective`.

- **Embedding cache has no invalidation hook.** Cache key is
  `articleId + sbert_model`. If `Article.translatedFullText` is later updated
  (e.g. translation pipeline re-runs), the cached vector becomes stale. Mitigation
  options: hash the input text into the key, or version-stamp the translation
  pipeline.

- **303-article cluster `cmomjcler0000jj168w5rj23q` failed the backfill** with
  "fetch failed" — likely undici body-size limit on the Node side. Add per-source
  article capping (e.g. top 5 per source) so very large clusters succeed.

- **Pairwise heatmap and source axis use different N** (12 vs 10). Should agree.

- **Heatmap top-N picks by article count**, which biases toward wire-service
  outlets that show up in every cluster. Consider picking the N most extreme
  sources by mean-distance-to-others — that's actually the framing-divergence story.

- **No request-coalescing on narrative generation.** Two simultaneous calls spawn
  two OpenRouter calls.

- **No tests** for: MDS function, country resolver, perspective stats, narrative
  formatter, persist-narrative-preserving merge.

## Article body quality

- **Mid-sentence truncations in `Article.translatedFullText`.** Observed on
  `cmos0xdl7000ajj7m0stp9hnp` (swr.de Info-Date): two of three paragraphs end
  abruptly ("…his criticism of Trump, but" / "…According to Defense Minister
  Pistorius, the"). The truncations exist in the database, not the frontend —
  `splitParagraphs` only splits on blank lines. Likely cause: LLM
  translation/condensation hit a token cap mid-sentence per chunk, or the
  source extraction was already truncated before translation. Investigate the
  enrichment pipeline (`openrouter-article-enrichment.ts`) for per-chunk
  output limits and either raise them or implement sentence-boundary repair.

- **Wikipedia entity summaries are often just the lead sentence and read
  awkwardly** (e.g. "Joseph Robinette Biden Jr." for Joe Biden). The
  `extractSummary` cap was bumped from 200→600 chars / 1→5 sentences in
  `entity-linker.ts`, but cached entries (7-day TTL on disk + DB rows) still
  hold the short version. Consider a one-off re-enrichment pass to refresh
  cached summaries.

## Opinion / subjectivity score (high priority)

The current `scoreSubjectivity` in `apps/api/src/domain/text.ts:324` is a
primitive English-only lexicon ratio (`opinionated_token_count / total_tokens`,
where "opinionated" means the token appears anywhere in `biasLexicon`). The
numbers were near-meaningless, so as of 2026-05-06 the UI no longer surfaces
them — the value is still computed and stored, but hidden from the article
page and the story panel. The DB column and API field remain in place so we
can backfill once we have something better.

Replacement plan:

1. **Short term — fold into the existing OpenRouter enrichment pass**
   (`openrouter-article-enrichment.ts`). We already call an LLM per article
   for translation/summary/keywords. Add two cheap fields to the same prompt:
   - `opinion_score` (0–1): how much of the article is the author's framing /
     judgement vs. attributable reporting.
   - `opinion_evidence`: 1–2 short quoted phrases that justify the score so
     the UI can render *"high opinion: 'a brazen, reckless attack…'"* instead
     of a naked decimal. Multilingual for free.
2. **Long term — multilingual classifier in the spaCy/NLP sidecar** (e.g.
   XLM-R subjectivity head). Cheaper at scale, but only worth it once #1
   proves the signal is actually useful.

Bring the UI back once #1 lands.

## Keyword / tag quality

- **Keywords are too unique to group related stories.** The enrichment prompt was
  emitting hyper-specific compounds like "Zelenskyy ceasefire proposal",
  "Kramatorsk air strike", "Victory Day ceasefire" — each unique to one article,
  so the /tag page fragments related coverage. Prompt updated 2026-05-07
  (`openrouter-article-enrichment.ts`): tightened to 1–3 words, added a
  balanced-slot rule (1 location, 1–2 people, 1 org/event, 1–2 themes), forbade
  combining person/place + action into one keyword, and refreshed the few-shot
  Example 1 to demonstrate splitting. Follow-ups still open:
  - **Backfill required.** Existing rows in the DB still hold the old compound
    keywords. /tag page won't visibly improve until we re-run enrichment over
    historical articles (or at least a recent date range to sanity-check).
  - **Canonicalization pass.** Even with the prompt fix, "Ukraine conflict" vs
    "Ukraine war" vs "Ukraine" still fragment. Plan: maintain a growing canonical
    keyword vocabulary in the DB, embed each new keyword on enrichment, snap to
    the nearest existing tag above a similarity threshold (e.g. cosine > 0.85),
    otherwise add it. Only approach that survives model variance and merges
    near-synonyms across articles.
  - **Sanity-check after backfill.** Look at the top-50 tags by frequency and
    confirm they read as reusable topics ("Trump", "ceasefire", "AI regulation")
    rather than per-article one-offs.

## Ingestion

- **Roundup-format detector.** Some sources publish a single article that
  bundles N unrelated stories (e.g. SWR's "Info-Date am Morgen", broadcaster
  morning-briefings, Kagi-style daily digests). Today these land as one
  `Article` row, which muddles clustering, keyword tagging and
  perspective-word extraction (one row contributes keywords from 3+ topics).
  Detect roundup format heuristically — title contains separators like `++`,
  `|`, `·`; or matches patterns like `^(Info-Date|Briefing|Newsletter|Morning Briefing|Daily Digest)`;
  or body has N independent sub-headlines — and split into N child Article
  rows linked back to a `parentArticleId`.

## Performance

- **Backfill performance.** ~120 s/cluster × thousands of clusters = days for a
  full backfill. SBERT encoding dominates first-pass cost; the embedding cache
  only helps recomputes. For continuous backfill on every ingestion run, need to
  either parallelise (process pool in sidecar) or make it incremental (only encode
  articles that aren't already cached).
