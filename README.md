# News In Perspective

![News In Perspective](./Hero.png)

Monorepo for a news-comparison project that ingests RSS feeds from Kagi's public `kite_feeds.json` catalog, stores normalized article data in Postgres, clusters same-day coverage, and exposes lightweight NLP comparison signals to a Svelte frontend.

## Contents
- [About this project](#about-this-project)
- [Workspace](#workspace)
- [Local setup](#local-setup)
  - [Prerequisites](#prerequisites)
  - [Steps](#steps)
  - [Defaults & ports](#defaults--ports)
  - [API keys you need](#api-keys-you-need)
  - [Troubleshooting](#troubleshooting)
- [Ingestion](#ingestion)
- [Daily pipeline](#daily-pipeline)
  - [Single-command pipeline run](#single-command-pipeline-run)
  - [Cluster selection knobs (kagi-ingest)](#cluster-selection-knobs-kagi-ingest)
  - [Article enrichment & framing summary](#article-enrichment--framing-summary)
- [Sidecar services](#sidecar-services)
  - [Perspective sidecar](#perspective-sidecar)
  - [NER sidecar](#ner-sidecar)
- [API endpoints](#api-endpoints)
- [Validation](#validation)
- [Notebook workflow](#notebook-workflow)

## About this project

This is an NLP experiment for the [UTS Applied Natural Language Processing (36118)](https://coursehandbook.uts.edu.au/subject/2026/36118) class, Autumn 2026.

Repository: https://github.com/coezbek/newsinperspective

### Subject coordinator & teachers
- [Dr Arnick Abdollahi](https://www.linkedin.com/in/arnick-abdollahi-28416b80/) (subject coordinator) — [UTS profile](https://profiles.uts.edu.au/Arnick.Abdollahi)
- [Mutaz Abu Ghazaleh](https://www.linkedin.com/in/mutazag/) (teacher, Founder of MAGTech.ai)
- [Sarah Fawcett](https://www.linkedin.com/in/sarah-fawcett-6b120114a/) (teacher)

### Authors
- [Christopher Oezbek](https://www.linkedin.com/in/coezbek/)
- Raul Perez Garcia
- [Siqi Zhang](https://www.linkedin.com/in/siqi-zhang-a785b334b/)
- Myeongjin Han
- Andrew Fenelon

### Data & key technologies
- News data from [Kagi News (Kite)](https://kite.kagi.com/)
- [Svelte](https://svelte.dev/) + [Vite](https://vitejs.dev/) frontend
- [Node.js](https://nodejs.org/) + [Fastify](https://fastify.dev/) + [TypeScript](https://www.typescriptlang.org/) API
- [Prisma](https://www.prisma.io/) ORM with [PostgreSQL](https://www.postgresql.org/)
- [OpenRouter](https://openrouter.ai/) for LLM-based keyword and entity enrichment
- Named entity recognition (spaCy) and entity linking against [Wikipedia](https://en.wikipedia.org/)

## Workspace
- `apps/api`: Fastify API plus ingestion jobs
- `apps/web`: Svelte + Vite frontend
- `apps/perspective`: Python FastAPI sidecar for SBERT framing-divergence + RoBERTa sentiment + TF-IDF (registered as `@news/perspective`; `pnpm run dev` starts it alongside api + web)
- `apps/ner`: Python FastAPI sidecar for spaCy named-entity recognition. Defaults to `en_core_web_trf` (transformer); set `NER_SPACY_MODEL=en_core_web_lg` to fall back to the lighter model
- `packages/db`: Prisma schema and generated client
- `packages/shared`: shared DTOs and schemas

## Local setup

### Prerequisites
Linux/macOS, with:
- `git`
- `nvm`
- Docker + Docker Compose
- Python 3.12+ (for notebooks)
- `uv` (for notebook workflow)

### Steps
1. Select and install the repo Node version: `nvm install && nvm use`
2. Enable Corepack and install the pinned package manager: `corepack enable && corepack install`
3. Create env file: `cp .env.example .env`
4. Install dependencies: `pnpm install`
5. Start Postgres: `pnpm db:start`
6. Generate Prisma client: `pnpm db:generate`
7. Run migrations: `pnpm db:migrate`
8. Start the NER sidecar: `docker compose up -d ner`
9. Start everything in dev mode: `pnpm run dev`

Day-to-day, the only commands you need to run are:

```bash
docker compose up -d   # postgres + ner
pnpm run dev           # api + web + perspective sidecar (concurrent via turbo)
```

`pnpm run dev` starts api, web, and the perspective sidecar in
parallel — `apps/perspective` is registered as the `@news/perspective`
workspace member, so its `dev` script (`uv run python app.py`) runs
alongside the others. No second terminal needed for the sidecar.

`package.json` pins `pnpm@10.32.1`, so once Corepack is enabled it will provision the correct `pnpm` version for this repo. If `nvm` is not already installed on your machine, install it first and then run `nvm use`.

### Defaults & ports
- API: `http://localhost:4400`
- Frontend: `http://localhost:5317`
- Postgres: `localhost:55432`

### API keys you need

Stage 1 of the pipeline (Kagi ingest) needs no keys. Stages 2-5 do — without
at least one working LLM provider, the daily run produces no translations,
framing summaries, entities, or perspective metrics. Set these in `.env`:

| Variable | Required? | Where to get it | What it does |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | **Yes** | https://openrouter.ai/keys | Default LLM path. Drives stage 2 enrichment (translation, `framingSummary`, keywords, persons/orgs/places) by rotating through the free models in `OPENROUTER_MODEL`. |
| `OPENAI_API_KEY` | Recommended | https://platform.openai.com/api-keys | Fallback used only after every OpenRouter free model has failed for an article. Without it, enrichment can stall when the free pool is saturated. Also used as the **primary** path when `LLM_PRIMARY=openai`. |
| `LLM_PRIMARY` | Optional (`openrouter` \| `openai`, default `openrouter`) | — | Routing override for stage-2 article + keyword enrichment. Set to `openai` to call OpenAI first (model from `OPENAI_FALLBACK_MODEL`, default `gpt-5.4-nano`) and fall through to the OpenRouter rotation only on parse failure. The 2026-05-09 20×20 run cut stage 2 from 4h41m → 1h10m using this. |

Every other variable in `.env.example` ships with a working default — see the inline comments there for tuning notes (ingestion concurrency, sidecar URLs, caches, dedupe thresholds, model rotation order).

### Troubleshooting
- If `pnpm db:start` fails with a Docker container-name conflict, you already have an existing `news-in-perspective-postgres` container from another checkout. Reuse that container or stop/remove it before retrying.

## Ingestion

The current ingestion path is the cluster-based Kagi News pipeline
(`pnpm kagi:ingest` → `src/scripts/kagi-ingest.ts`). It pulls cluster
snapshots from Kagi News and extracts article bodies via a headless
browser. The original RSS-catalog ingestion has been retired from
`package.json`; see [LEGACY.md](./LEGACY.md) for historical context.

`pnpm kagi:ingest` runs only stage 1 of the daily flow. For a complete
daily run (ingest + LLM enrichment + entities + perspective +
calibration in one process), use `pnpm pipeline:run` — see the
[Daily pipeline](#daily-pipeline) section below.

For long-running Kagi ingests, prefer a persistent `tmux` session with a log file so progress survives terminal disconnects:

```bash
mkdir -p logs
tmux new-session -d -s kagi_ingest \
  "cd /home/coezbek/2026/NewsInPerspectiveCodex && pnpm kagi:ingest 2>&1 | tee logs/kagi-ingest-$(date -u +%Y%m%dT%H%M%SZ).log"

# Watch live:
tmux attach -t kagi_ingest          # detach with Ctrl+b d
tail -f logs/kagi-ingest-*.log

# Check whether it is still running:
tmux ls
```

Enrich publisher article text for notebook analysis:

```bash
pnpm enrich:text 2026-03-23 100
```

This fetches publisher pages for up to `100` articles on that date, extracts readable body text where possible, and stores it on the article record for export.

Inspect text-enrichment status:

```bash
pnpm enrich:status 2026-03-23
```

Run a small verification sample:

```bash
pnpm verify:text-enrichment 2026-03-23 3
```

Runtime logs are written to `logs/`, including:

- `logs/api.log`
- `logs/pipeline-*.log` (one per pipeline stage, see `pnpm pipeline:run`)

## Daily pipeline

Each daily run is a chain of seven stages, executed strictly serially:

| Stage | Critical? | Script | Produces |
| --- | --- | --- | --- |
| 1 `kagi-ingest` | yes | `src/scripts/kagi-ingest.ts` | `Article.fullText`, `StoryCluster`, `ClusterArticle`, plus a best-effort `ClusterPerspective` row per cluster |
| 2 `openrouter-backlog` | yes | `src/scripts/enrich-openrouter.ts` | `Article.translatedFullText`, `Article.language`, summary, cluster keywords (anchored on per-article keyword union) |
| 3 `entity-re-enrich` | no | `src/scripts/entity-re-enrich.ts` | `NamedEntity`, `EntityMention` (spaCy NER + LLM type override + within-article partial-name fold + Wikipedia link inline) |
| 4 `cluster-perspective-backfill` | yes | `src/scripts/cluster-perspective-backfill.ts` | Cluster perspective metrics (calls perspective sidecar) |
| 5 `perspective-calibrate` | no | `src/scripts/perspective-calibrate.ts` | Refreshed divergence-score quantiles |
| 6 `perspective-narrative` | no | `src/scripts/perspective-narrative.ts` | LLM-generated framing + per-country narratives per cluster |
| 7 `perspective-resolve-countries` | no | `src/scripts/perspective-resolve-countries.ts` | LLM-resolved country values for source profiles missing one |

**Stage criticality** (used by `scripts/run-pipeline.sh`): stages 1, 2, 4 are
**critical** — their output is required by later stages, so a non-zero exit
aborts the chain. Stages 3, 5, 6, 7 are **noncritical** — a transient failure
(e.g. a Wikipedia 429 storm in stage 3) logs a `WARNING:` and the chain
continues so today's data still gets perspective scores and narratives.

Stage 3 reads `translatedFullText` for non-English articles (falling back to
`fullText` if translation hasn't run), so stage 2 must complete before stage 3.
Wikipedia linking is **not** a separate stage; it runs inline per emitted
spaCy entity inside `enrichArticleWithEntities`.

Running `pnpm kagi:ingest` on its own only completes **stage 1**. It runs an
inline best-effort `computeClusterPerspective` per cluster, but leaves
keywords as `keywords_pending` and emits no translations, entities, or
narratives. Use `scripts/run-pipeline.sh` (below) for the full chain.

### Single-command pipeline run

`scripts/run-pipeline.sh` runs all seven stages serially, mirrors output
to `logs/pipeline-<DATE>-<HHMMSS>.log`, scales the article/cluster caps
with the run size, and applies the critical/noncritical exit semantics
described above.

```bash
# Default: today (UTC), 5 clusters x 5 articles per cluster.
scripts/run-pipeline.sh

# Explicit args: DATE CLUSTERS MAX_SOURCES_PER_CLUSTER
scripts/run-pipeline.sh 2026-05-09 20 20

# Use OpenAI as the primary stage-2 model for this run only:
LLM_PRIMARY=openai scripts/run-pipeline.sh 2026-05-09 20 20

# With paid OpenRouter fallback enabled (used only after the free pool fails):
OPENROUTER_PAID_FALLBACK_MODEL=deepseek/deepseek-chat \
  scripts/run-pipeline.sh
```

Article and cluster caps for stage 2 scale with the run size:
`ARTICLE_LIMIT = CLUSTERS × MAX_SOURCES`, `CLUSTER_LIMIT = CLUSTERS`. So a
20×20 run enriches up to 400 articles (vs the previous hard-coded 200).

You can monitor a running pipeline live at the `/pipeline` page in the
web UI — it polls `GET /api/pipeline/log-status` every 4 s, parses stage
banners out of the latest `logs/pipeline-*.log`, and renders a per-stage
status table with the running stage's stdout tail.

For long runs, wrap the command in `tmux` so it survives disconnects:

```bash
tmux new-session -d -s pipeline "scripts/run-pipeline.sh 2026-05-09 20 20"
tmux attach -t pipeline   # detach with Ctrl+b d
```

If a critical stage (1, 2, or 4) fails the runner aborts; re-run the same
command to resume — earlier stages are idempotent
(`KAGI_INGEST_SKIP_EXISTING=false` is set so a re-run refreshes article
bodies for the same date). Noncritical stages (3, 5, 6, 7) print a
`WARNING:` and let the chain continue.

There is also `pnpm pipeline:run` (`src/scripts/pipeline-run.ts`) for the
narrower five-stage TS-only chain; it predates `run-pipeline.sh` and
doesn't include narrative + country-resolve.

### Cluster selection knobs (kagi-ingest)

`pnpm --filter @news/api exec tsx src/scripts/kagi-ingest.ts <globalLimit> <perCategoryLimit>`

- `globalLimit` (argv[2]) — top-N clusters by source count picked from the
  whole snapshot.
- `perCategoryLimit` (argv[3]) — top-N **additional** clusters from each of
  the seven required categories (World, USA, Business, Technology, Sports,
  Science, Gaming). The two sets are unioned and deduplicated.

To select **exactly** N clusters, pass `<N> 0`. Example: `10 0` picks the
global top 10 and skips the per-category top-up.

- `KAGI_INGEST_MAX_SOURCES_PER_CLUSTER` — hard cap on sources extracted per
  cluster. Applied **before** browser extraction, so unused sources cost
  nothing.
- `KAGI_INGEST_SKIP_EXISTING` (default `true`) — set to `false` to re-extract
  clusters already imported for the same `storyDate`.

### Article enrichment & framing summary

`apps/api/src/services/openrouter-article-enrichment.ts` calls an OpenRouter
free-tier model per article and produces five text fields:

- `translatedTitle` / `translatedSummary` — short English versions for display.
- `translatedFullText` — the chrome-stripped, English-translated body. Used
  by the UI (article view, story-detail panel). Capped on input at 10K chars
  before the LLM call (`TRANSLATED_FULL_TEXT_MAX_CHARS`) and on output at
  8192 tokens (`ENRICHMENT_MAX_OUTPUT_TOKENS`); both are hardcoded constants
  in `openrouter-article-enrichment.ts`. Both truncations are flagged on the result.
- **`framingSummary`** — an abstractive 4-6 sentence summary written
  specifically to capture *what makes this source's framing distinctive*
  (stance, emphasis, attribution patterns). This is the field SBERT embeds
  for the cluster framing-divergence score; the full body is no longer the
  primary embedding input.
- `keywords` / `persons` / `organizations` / `places` — entity lists.

Why a separate `framingSummary` instead of just embedding `translatedFullText`:

- **Output-token caps no longer corrupt the divergence signal.** Free models
  often default to 1024-2048 output tokens — long enough to truncate
  `translatedFullText` mid-sentence on real articles. SBERT then embeds the
  truncated body, polluting the score. `framingSummary` is short by design.
- **Higher signal-to-noise.** Wire-service stories share verbatim quotes
  across many outlets; embedding those drags every source's vector toward
  the same centroid. The summary is asked to *exclude* shared content and
  keep what each outlet does differently.

The result also carries two truncation flags downstream consumers can use:

- `inputTruncated` — `true` when the original body exceeded
  `TRANSLATED_FULL_TEXT_MAX_CHARS` and we sliced before sending. Always known.
- `bodyAppearsTruncated` — the model's own assessment of whether the body
  it received looked cut off. `null` when the model omitted the field.

When SBERT input is selected (`cluster-perspective.ts:pickArticleText`),
preference order is: `framingSummary` → `translatedFullText` → raw English
`fullText`. Older articles without `framingSummary` still work via the
fallback; running `pnpm entity:re-enrich --force` repopulates them.

## Sidecar services

### Perspective sidecar

`apps/perspective/` is a FastAPI service that computes the cluster framing-divergence
score (SBERT `all-mpnet-base-v2`), per-source distinctive words (TF-IDF), and
per-country sentiment (`cardiffnlp/twitter-roberta-base-sentiment-latest`).
It is registered as the `@news/perspective` workspace member, so
`pnpm run dev` starts it concurrently with api + web — no separate
terminal. The script it runs is `uv run python app.py`, so `uv` must be
on `PATH` and `apps/perspective/.venv` must exist
(`cd apps/perspective && uv venv && uv pip install -e .` once on first
checkout).

It listens on `127.0.0.1:5710` by default (`PERSPECTIVE_HOST` / `PERSPECTIVE_PORT`
to override). First request cold-loads ~1 GB of models; `POST /warmup` preloads
them. Stage 4 of the pipeline (`cluster-perspective-backfill`) calls this service
— without it, divergence scores and distinctive words are not produced.

See `apps/perspective/README.md` for the full API and config surface.

### NER sidecar

`apps/ner/` is a FastAPI service running spaCy. Default model is
`en_core_web_trf` (transformer); set `NER_SPACY_MODEL=en_core_web_lg` to
fall back to the lighter model on memory-constrained hosts. Bring it up
alongside Postgres:

```bash
docker compose build ner    # one-time after switching to trf
docker compose up -d ner
curl http://127.0.0.1:5711/health
```

The container ships both `en_core_web_lg` (~570 MB) and `en_core_web_trf`
(~430 MB + torch CPU wheels) so the model is selectable at runtime. The
trf model adds ~1.5 GB of resident memory.

`apps/api/src/services/entity-recognition.ts` is a thin client that maps
spaCy labels to `EntityType` (`PERSON/ORG/GPE/EVENT`; `LOC→GPE`; `DATE`
dropped). Configure with `NER_SERVICE_URL` and `NER_SERVICE_TIMEOUT_MS`.

Stage 3 (entity-re-enrich) layers two corrections on top of spaCy's
output to clean up the residual mis-classifications:

- **LLM type override.** Stage 2 already classified each article's names
  into `persons[] / organizations[] / places[]`. When that disagrees
  with spaCy on the same surface form, the LLM type wins (e.g.
  `Stratford Butterfly Farm` → ORG, `Wikimedia` → ORG).
- **Within-article partial-name fold.** Bare surname / first-name
  mentions (`David` + `Attenborough`) collapse into the matching
  multi-token canonical (`David Attenborough`) iff the parent is
  unambiguous in the article. Highlight offsets stay anchored to the
  original token; only the entity row + Wikipedia lookup uses the
  canonical form.

Wikipedia entity-link cache keys are normalized (lowercase, leading
articles `the/a/an` + EN/FR/ES/DE equivalents stripped, trailing
possessive + punctuation removed) so trivial surface variants
(`Marshall Islands` / `the Marshall Islands` / `Netherlands'`) share a
disk-cache slot.

## API endpoints

Date and story browsing:

- `GET /api/dates`
- `GET /api/stories?date=2026-03-23`
- `GET /api/stories/:id`
- `GET /api/stories/:id/comparison`

Cluster/domain entity views — once stage 3 has populated
`EntityMention`, these surface the "framing differences across outlets"
data the notebook explored:

- `GET /api/clusters/:clusterId/entities` — top entities in a cluster.
- `GET /api/clusters/:clusterId/entities/by-domain` — same, grouped by
  source domain.
- `GET /api/domains/:domain/entities` — top entities for a single source
  across the corpus.

## Validation
- `pnpm lint`
- `pnpm test`
- `pnpm build`

## Notebook workflow

For team NLP analysis in Jupyter, use the shared notebook workspace under `notebooks/`.

1. Create the Python environment with `uv venv`
2. Activate it with `source .venv/bin/activate`
3. Install notebook tooling with `uv sync && uv pip install -r notebooks/requirements.txt`
4. Export a date slice from the running API:

```bash
pnpm export:notebook -- \
  --date 2026-03-23 \
  --api-base http://localhost:4400 \
  --output-dir notebooks/exports/2026-03-23
```

5. Convert the Jupytext template if needed: `source .venv/bin/activate && jupytext --to ipynb notebooks/templates/nlp_analysis.py`
6. Open the notebook and point `EXPORT_DIR` at the exported slice.

The exporter writes flat JSONL files that load directly into pandas dataframes and work well for shared notebook analysis.
Activate `.venv` before running notebook or Drive-sync commands, since `pnpm drive:push` rebuilds the shared `.ipynb`.
