"""spaCy-backed NER sidecar for the News In Perspective API.

Exposes a small HTTP surface so the Node API can call into spaCy without
embedding a Python runtime. The model is loaded once at startup and reused
for every request.
"""

from __future__ import annotations

import os
from typing import List

import spacy
from fastapi import FastAPI
from pydantic import BaseModel, Field

MODEL_NAME = os.environ.get("NER_SPACY_MODEL", "en_core_web_sm")
MAX_CHARS = int(os.environ.get("NER_MAX_CHARS", "50000"))
KEEP_LABELS = {"PERSON", "ORG", "GPE", "LOC", "EVENT"}

app = FastAPI(title="news-in-perspective NER", version="0.1.0")
nlp = spacy.load(MODEL_NAME)


class ExtractRequest(BaseModel):
    text: str
    max_chars: int | None = Field(default=None, ge=1)


class ExtractBatchRequest(BaseModel):
    texts: List[str]
    max_chars: int | None = Field(default=None, ge=1)


class Entity(BaseModel):
    text: str
    label: str
    start: int
    end: int


class ExtractResponse(BaseModel):
    entities: List[Entity]
    truncated: bool


class ExtractBatchResponse(BaseModel):
    results: List[ExtractResponse]


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME}


def _extract_one(text: str, max_chars: int) -> ExtractResponse:
    truncated = False
    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True
    doc = nlp(text)
    entities = [
        Entity(text=ent.text.strip(), label=ent.label_, start=ent.start_char, end=ent.end_char)
        for ent in doc.ents
        if ent.label_ in KEEP_LABELS and ent.text.strip()
    ]
    return ExtractResponse(entities=entities, truncated=truncated)


@app.post("/extract", response_model=ExtractResponse)
def extract(req: ExtractRequest) -> ExtractResponse:
    return _extract_one(req.text or "", req.max_chars or MAX_CHARS)


@app.post("/extract_batch", response_model=ExtractBatchResponse)
def extract_batch(req: ExtractBatchRequest) -> ExtractBatchResponse:
    cap = req.max_chars or MAX_CHARS
    prepared: list[tuple[str, bool]] = []
    for raw in req.texts:
        text = raw or ""
        if len(text) > cap:
            prepared.append((text[:cap], True))
        else:
            prepared.append((text, False))

    results: list[ExtractResponse] = []
    for doc, (_, truncated) in zip(nlp.pipe([t for t, _ in prepared]), prepared):
        entities = [
            Entity(text=ent.text.strip(), label=ent.label_, start=ent.start_char, end=ent.end_char)
            for ent in doc.ents
            if ent.label_ in KEEP_LABELS and ent.text.strip()
        ]
        results.append(ExtractResponse(entities=entities, truncated=truncated))
    return ExtractBatchResponse(results=results)
