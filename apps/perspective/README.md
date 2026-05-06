# Perspective Sidecar

Python FastAPI service that computes Perspective Intelligence signals for a single news cluster:

- **Framing Divergence Score** — SBERT (`all-mpnet-base-v2`) per-article embeddings, mean-pooled per source, mean pairwise cosine distance across sources.
- **Distinctive Words** — TF-IDF per source within the cluster, with sklearn English stopwords + a domain-specific stoplist.
- **Sentiment by Country** — `cardiffnlp/twitter-roberta-base-sentiment-latest` per article, aggregated by country with standard error.

## Run

```bash
cd apps/perspective
uv venv
uv pip install -e .
uv run python app.py
```

Service listens on `127.0.0.1:5710`. Override with `PERSPECTIVE_HOST` / `PERSPECTIVE_PORT`.

First request triggers a cold load of SBERT (~420 MB) and the sentiment pipeline (~500 MB). Hit `POST /warmup` to preload.

## Endpoints

- `GET /health` — service status, model names, load state.
- `POST /warmup` — preload models.
- `POST /analyze-cluster` — body:

```json
{
  "cluster_id": "abc",
  "cluster_title": "...",
  "articles": [
    {"article_id": "a1", "source_name": "BBC", "country": "United Kingdom", "text": "..."}
  ],
  "tfidf_top_n": 7
}
```

Returns divergence score + label, pairwise distance matrix, per-source distinctive words, per-country sentiment, and per-article sentiment scores.

## Config (env)

- `PERSPECTIVE_SBERT_MODEL` (default `all-mpnet-base-v2`)
- `PERSPECTIVE_SENTIMENT_MODEL` (default `cardiffnlp/twitter-roberta-base-sentiment-latest`)
- `PERSPECTIVE_TFIDF_TOP_N` (default `7`)
- `PERSPECTIVE_TFIDF_MAX_DF` (default `0.8`)
- `PERSPECTIVE_TFIDF_MIN_CHARS` (default `3`)

## Notes

- Tweet-RoBERTa is trained on social media; news scores cluster near 0. Treat as directional.
- Articles with empty text are dropped before analysis; clusters with <2 distinct sources return `divergence_score: null`.
- No translation is done here — pass already-English text (or whatever the upstream pipeline produces).
