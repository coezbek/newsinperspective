# Legacy pipeline (RSS-based ingestion)

This document describes the **original** ingestion pipeline, which read Kagi's
public `kite_feeds.json` RSS catalog and normalized articles per feed. It has
been superseded by the cluster-based pipeline documented in the main
[README](./README.md) (`pnpm kagi:ingest` → `src/scripts/kagi-ingest.ts`),
which selects top Kagi News clusters, browser-extracts article bodies, and
runs dedupe + perspective in one pass.

The legacy code path is still present in the repo:

- Service: `apps/api/src/services/ingestion.ts` (`runIngestion`)
- CLI script: `apps/api/src/scripts/ingest.ts`
- HTTP route: `POST /internal/ingest/run`

It is **not** part of the daily pipeline and is kept only for reproducing
older runs or comparing against the RSS catalog. Prefer the cluster pipeline
for new work.

## Running the legacy RSS ingestion

Run a manual ingestion for a date over HTTP:

```bash
curl -X POST http://localhost:4400/internal/ingest/run \
  -H 'content-type: application/json' \
  -d '{"date":"2026-03-23"}'
```

Or run it directly via `tsx` (the `pnpm ingest` alias has been retired
from `package.json` to keep the surface limited to the Kagi-cluster
pipeline):

```bash
pnpm --filter @news/api exec tsx src/scripts/ingest.ts 2026-03-23
```

`INGEST_FEED_LIMIT` in `.env` caps how many feeds the legacy path pulls per
run (the default `.env.example` sets it to `50` for quick validation).

Logs are written to `logs/ingestion-YYYY-MM-DD.log`.
