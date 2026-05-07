# NER sidecar

FastAPI service that runs spaCy `en_core_web_lg` and exposes a small JSON
API used by `apps/api` for entity recognition. Kept as a separate process
so we don't drag a Python runtime into the Node app.

The default model was upgraded from `en_core_web_sm` (~50 MB) to
`en_core_web_lg` (~600 MB) to fix recall on camelCase brand names that the
small model misses (`GameStop`, `PayPal`, `eBay` is borderline). If disk
space is tight, pin `NER_SPACY_MODEL=en_core_web_sm` and download the
small model instead — accept the recall hit.

## Run with docker compose

```bash
docker compose up ner
curl http://localhost:8000/health
```

## Run locally without Docker

```bash
cd apps/ner
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m spacy download en_core_web_lg
uvicorn main:app --reload
```

## Endpoints

- `GET /health` – readiness probe.
- `POST /extract` – `{ "text": "..." }` → `{ entities: [{text,label,start,end}], truncated }`.
- `POST /extract_batch` – `{ "texts": [...] }` → `{ results: [...] }`.

Returned labels are filtered to `PERSON`, `ORG`, `GPE`, `LOC`, `EVENT`.
The Node side maps `LOC → GPE` and drops `DATE` (not emitted here).

## Configuration

| Env var          | Default            | Purpose                                  |
| ---------------- | ------------------ | ---------------------------------------- |
| `NER_SPACY_MODEL`| `en_core_web_lg`   | spaCy model name loaded at startup.      |
| `NER_MAX_CHARS`  | `50000`            | Per-document truncation before parsing.  |
