# News In Perspective

Monorepo for a news-comparison project that ingests RSS feeds from Kagi's public `kite_feeds.json` catalog, stores normalized article data in Postgres, clusters same-day coverage, and exposes lightweight NLP comparison signals to a Svelte frontend.

## Workspace
- `apps/api`: Fastify API plus ingestion jobs
- `apps/web`: Svelte + Vite frontend
- `packages/db`: Prisma schema and generated client
- `packages/shared`: shared DTOs and schemas

## Local setup
Prerequisites (Linux/macOS):
- `git`
- `nvm`
- Docker + Docker Compose
- Python 3.12+ (for notebooks)
- `uv` (for notebook workflow)

1. Select and install the repo Node version: `nvm install && nvm use`
2. Enable Corepack and install the pinned package manager: `corepack enable && corepack install`
3. Create env file: `cp .env.example .env`
4. Install dependencies: `pnpm install`
5. Start Postgres: `pnpm db:start`
6. Generate Prisma client: `pnpm db:generate`
7. Run migrations: `pnpm db:migrate`
8. Start the backend in dev mode (terminal 1): `pnpm --filter @news/api dev`
9. Start the frontend (terminal 2): `pnpm web:start`

`package.json` pins `pnpm@10.32.1`, so once Corepack is enabled it will provision the correct `pnpm` version for this repo. If `nvm` is not already installed on your machine, install it first and then run `nvm use`.

API defaults to `http://localhost:4400`, the frontend defaults to `http://localhost:5317`, and Postgres is exposed on `localhost:55432`.
Logical run dates default to `UTC` via `APP_DATE_TIMEZONE`, while stored timestamps remain UTC instants in Postgres.

If `pnpm db:start` fails with a Docker container-name conflict, you already have an existing
`news-in-perspective-postgres` container from another checkout. Reuse that container or stop/remove it before retrying.

For the first few runs, the default `.env` sets `INGEST_FEED_LIMIT=50` so ingestion completes quickly while you validate the pipeline. Remove or increase that limit once you are ready for broader collection.
If OpenRouter free models are hot, adjust `OPENROUTER_MODEL_OFFSET` or provide a broader comma-separated `OPENROUTER_MODEL` list.

## Ingestion
Run a manual ingestion for a date:

```bash
curl -X POST http://localhost:4400/internal/ingest/run \
  -H 'content-type: application/json' \
  -d '{"date":"2026-03-23"}'
```

Or run ingestion directly from the CLI:

```bash
pnpm ingest 2026-03-23
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

Inspect dataset status:

```bash
pnpm data:status
```

Runtime logs are written to `logs/`, including:

- `logs/api.log`
- `logs/ingestion-YYYY-MM-DD.log`

Then inspect:

- `GET /api/dates`
- `GET /api/stories?date=2026-03-23`
- `GET /api/stories/:id`
- `GET /api/stories/:id/comparison`

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
