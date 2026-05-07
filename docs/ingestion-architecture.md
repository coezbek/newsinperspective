# Ingestion Pipeline — System Architecture

## Overview

The ingestion pipeline turns raw RSS feeds into clustered, entity-annotated, perspective-scored stories served to the Svelte web frontend. It is orchestrated by a daily scheduler that enqueues a chained, multi-stage job through `pipeline-runner.ts`.

## High-Level Diagram

```mermaid
flowchart TB
    subgraph Triggers["Triggers"]
        SCH["Scheduler<br/>(cron @ AUTO_INGEST_TIME_UTC)<br/>apps/api/src/workers/scheduler.ts"]
        API_TRIG["POST /internal/ingest/run<br/>(manual)"]
    end

    PR["Pipeline Runner<br/>apps/api/src/services/pipeline-runner.ts<br/>(chains 5 sequential stages)"]

    subgraph Stages["Processing Stages"]
        S1["Stage 1 — Ingest<br/>ingestion.ts<br/>RSS parse, canonicalize URL,<br/>fingerprint dedupe"]
        S2["Stage 2 — Text Extraction<br/>article-text.ts<br/>Playwright + Readability<br/>(7-day disk cache)"]
        S3["Stage 3 — Enrichment<br/>openrouter-article-enrichment.ts<br/>translate, keywords,<br/>newsworthiness"]
        S4a["Stage 4a — NER<br/>entity-recognition.ts<br/>PERSON/ORG/GPE/EVENT"]
        S4b["Stage 4b — Entity Linking<br/>entity-linker.ts<br/>Wikipedia disambiguation"]
        S5["Stage 5 — Clustering<br/>clustering.ts<br/>Jaccard ≥ 0.35 on titles"]
        S6["Stage 6 — Perspective<br/>cluster-perspective.ts<br/>divergence, distinctive terms,<br/>country sentiment"]
    end

    subgraph External["External Services"]
        KAGI["Kagi Kite<br/>RSS feed catalog"]
        SITES["Publisher Sites<br/>(headless Chrome fetch)"]
        OR["OpenRouter API<br/>(LLM, OpenAI fallback)"]
        WIKI["Wikipedia API<br/>(rate-limited 200ms)"]
        NER_SVC["NER Sidecar<br/>apps/ner (FastAPI)<br/>spaCy en_core_web_lg"]
        PERS_SVC["Perspective Sidecar<br/>apps/perspective (FastAPI)<br/>SBERT + TF-IDF + RoBERTa"]
    end

    subgraph Store["PostgreSQL (Prisma)"]
        DB[("FeedSource, IngestionRun,<br/>Article, StoryCluster,<br/>ClusterArticle, EntityMention,<br/>NamedEntity, NlpFeature,<br/>ClusterPerspective")]
    end

    subgraph Frontend["Consumption"]
        REST["REST API<br/>apps/api/src/routes/api.ts"]
        WEB["Svelte SPA<br/>apps/web"]
    end

    SCH --> PR
    API_TRIG --> PR
    PR --> S1 --> S2 --> S3 --> S4a --> S4b --> S5 --> S6

    KAGI -. feeds .-> S1
    SITES -. HTML .-> S2
    S3 <--> OR
    S4a <--> NER_SVC
    S4b <--> WIKI
    S6 <--> PERS_SVC

    S1 --> DB
    S2 --> DB
    S3 --> DB
    S4a --> DB
    S4b --> DB
    S5 --> DB
    S6 --> DB

    DB --> REST --> WEB
```

## Component Responsibilities

### Triggers
- **Scheduler** (`apps/api/src/workers/scheduler.ts`) — fires once per day at `AUTO_INGEST_TIME_UTC`.
- **Internal API** (`POST /internal/ingest/run`) — manual on-demand trigger.

### Orchestration
- **Pipeline Runner** (`apps/api/src/services/pipeline-runner.ts`) — enqueues and chains the stages: `kagi-ingest → openrouter-backlog → entity-re-enrich → cluster-perspective-backfill → perspective-calibrate`. Each stage records progress on the `IngestionRun` row.

### Stage 1 — Ingest (`ingestion.ts` + `rss-ingest.ts`)
Fetches the Kagi Kite feed catalog, parses RSS/Atom, canonicalizes URLs, deduplicates against existing articles using a text fingerprint, and upserts new `Article` rows with `FeedSource` linkage.

### Stage 2 — Text Extraction (`article-text.ts`)
Uses Playwright (headless Chromium) to fetch each article, runs Mozilla Readability for body extraction, falls back to meta-tag heuristics, and assesses extraction quality. Results are cached on disk for 7 days.

### Stage 3 — LLM Enrichment (`openrouter-article-enrichment.ts`)
Single OpenRouter call per article for: newsworthiness gate, translation (non-English → English), keyword extraction. 8 s timeout with 5 s/15 s/60 s retry backoff and OpenAI fallback. Writes to `Article.translatedFullText` and `NlpFeature`.

### Stage 4a — NER (`entity-recognition.ts` ↔ `apps/ner/main.py`)
HTTP POST to a Python FastAPI sidecar running spaCy `en_core_web_lg`. Returns PERSON/ORG/GPE/EVENT mentions which are canonicalized and noise-filtered into `EntityMention`.

### Stage 4b — Entity Linking (`entity-linker.ts`)
For each canonical entity: Wikipedia search → disambiguation → page summary + thumbnail. Cached 7 days for hits, 100 days for misses, rate-limited to 200 ms between requests with up to 3 retries. Persists to `NamedEntity`.

### Stage 5 — Clustering (`clustering.ts`)
Groups articles into `StoryCluster`s using title-token Jaccard similarity (threshold 0.35), preserves per-article rank and similarity in `ClusterArticle`.

### Stage 6 — Perspective Analysis (`cluster-perspective.ts` ↔ `apps/perspective/app.py`)
HTTP POST to perspective sidecar (SBERT embeddings + TF-IDF + RoBERTa sentiment). Produces a divergence score, per-source distinctive terms, and country-level sentiment, stored in `ClusterPerspective`.

## Storage (`packages/db/prisma/schema.prisma`)

| Table | Purpose |
|---|---|
| `FeedSource` | RSS catalog metadata |
| `IngestionRun` | Per-day run status & metrics |
| `Article` | Canonical article + extracted/translated text |
| `StoryCluster` | Topic groupings per day/category |
| `ClusterArticle` | Article ↔ cluster with rank/similarity |
| `EntityMention` | Per-article entity occurrences |
| `NamedEntity` | Deduped entity with Wikipedia link |
| `NlpFeature` | Keywords, sentiment, bias, enrichment state |
| `ClusterPerspective` | Divergence, distinctive words, country sentiment |

## Frontend Path
The Svelte SPA in `apps/web` consumes REST endpoints in `apps/api/src/routes/api.ts`:
`GET /api/dates`, `/api/stories`, `/api/stories/:id`, `/api/clusters/:id/perspective`, `/api/articles/:id`, `/api/sources/:domain`, `/api/tags/:keyword`.

## External Dependencies Summary

| Service | Used by | Protocol |
|---|---|---|
| Kagi Kite | Stage 1 | HTTPS (RSS) |
| Publisher sites | Stage 2 | Headless Chromium |
| OpenRouter (+ OpenAI fallback) | Stage 3 | HTTPS JSON |
| spaCy NER sidecar | Stage 4a | HTTP (intra-host) |
| Wikipedia REST | Stage 4b | HTTPS JSON |
| Perspective sidecar | Stage 6 | HTTP (intra-host) |
| PostgreSQL | All stages + API | Prisma |
