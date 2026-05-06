"""
Perspective Intelligence sidecar.

Wraps the three NLP components from the v3 notebook:
  - SBERT framing-divergence score (mean pairwise cosine distance across sources)
  - tweet-RoBERTa sentiment per article, aggregated by country
  - TF-IDF distinctive words per source within the cluster

Single endpoint: POST /analyze-cluster
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_distances
from transformers import pipeline as hf_pipeline

SBERT_MODEL = os.environ.get("PERSPECTIVE_SBERT_MODEL", "all-mpnet-base-v2")
SENTIMENT_MODEL = os.environ.get(
    "PERSPECTIVE_SENTIMENT_MODEL",
    "cardiffnlp/twitter-roberta-base-sentiment-latest",
)
TFIDF_TOP_N = int(os.environ.get("PERSPECTIVE_TFIDF_TOP_N", "7"))
TFIDF_MAX_DF = float(os.environ.get("PERSPECTIVE_TFIDF_MAX_DF", "0.8"))
TFIDF_MIN_CHARS = int(os.environ.get("PERSPECTIVE_TFIDF_MIN_CHARS", "3"))
# Path to a JSON file produced by `build-corpus-stopwords.ts`. When present,
# its `terms` are merged into NEWS_STOPWORDS — i.e. the stop-word list is
# data-driven from corpus-wide document frequency rather than hand-curated.
CORPUS_STOPWORDS_PATH = os.environ.get(
    "PERSPECTIVE_CORPUS_STOPWORDS_PATH",
    str(Path(__file__).parent / "data" / "corpus-stopwords.json"),
)


def _load_corpus_stopwords(path: str) -> frozenset[str]:
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return frozenset()
    except Exception as exc:
        print(f"[perspective] corpus stop words at {path} unreadable: {exc}")
        return frozenset()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"[perspective] corpus stop words at {path} not valid JSON: {exc}")
        return frozenset()
    terms = data.get("terms")
    if not isinstance(terms, list):
        return frozenset()
    cleaned = {str(t).lower() for t in terms if isinstance(t, str) and t.strip()}
    print(
        f"[perspective] loaded {len(cleaned)} corpus stop words from {path}"
        f" (built from {data.get('articleCount', '?')} articles)",
    )
    return frozenset(cleaned)


CORPUS_STOPWORDS = _load_corpus_stopwords(CORPUS_STOPWORDS_PATH)

NEWS_STOPWORDS = frozenset(
    [
        # Web / scraping artifacts
        "paywall", "subscribe", "subscription", "newsletter", "cookie",
        "javascript", "browser", "https", "http", "www", "com", "html",
        "org", "net", "url", "link", "read", "more", "click", "here",
        "transcript", "transcripts", "machine", "lightly", "edited",
        # Reporting verbs / attribution
        "said", "says", "told", "according", "report", "reported",
        "reuters", "afp", "ap", "associated", "press", "agency",
        "correspondent", "editor", "journalist", "reporter", "anchor",
        "speaks", "spoke", "spoken", "interview", "speaking",
        # Calendar / units (absolute time mentions are rarely framing)
        "monday", "tuesday", "wednesday", "thursday", "friday",
        "saturday", "sunday", "january", "february", "march",
        "april", "june", "july", "august", "september",
        "october", "november", "december", "year", "years",
        "today", "yesterday", "tomorrow", "tonight", "morning", "evening",
        "afternoon", "week", "month", "now", "currently", "recent", "recently",
        "percent", "million", "billion", "thousand", "number",
        # Generic discourse / filler that surfaces in transcripts
        "going", "got", "get", "getting", "thing", "things", "way", "really",
        "actually", "well", "right", "lot", "sort", "kind", "yeah", "yes", "no",
        "okay", "ok", "let", "lets", "going", "make", "made", "people",
    ]
)

SENTIMENT_DIRECTION = {"positive": 1.0, "neutral": 0.0, "negative": -1.0}
SENTIMENT_LABEL_FALLBACK = {"label_0": "negative", "label_1": "neutral", "label_2": "positive"}


SENTIMENT_TRUNCATION_CHARS = 1024

_URL_RE = re.compile(r"https?://\S+")
_SHORT_TOKEN_RE = re.compile(r"\b\w{1,2}\b")
_WHITESPACE_RE = re.compile(r"\s+")


def clean_text(text: str) -> str:
    """Remove URLs, 1–2 char tokens, and collapse whitespace.

    Mirrors the v3 notebook's clean_text. Used to sanitise inputs before TF-IDF;
    sentiment and SBERT take the raw text so they can use full context.
    """
    if not isinstance(text, str):
        return ""
    out = _URL_RE.sub("", text)
    out = _SHORT_TOKEN_RE.sub("", out)
    out = _WHITESPACE_RE.sub(" ", out).strip()
    return out


class ArticleIn(BaseModel):
    article_id: str
    source_name: str
    country: Optional[str] = None
    text: str
    keywords: Optional[list[str]] = None  # Pre-extracted English keywords for per-country aggregation
    embedding: Optional[list[float]] = None  # Optional precomputed SBERT vector


class AnalyzeRequest(BaseModel):
    cluster_id: str
    cluster_title: Optional[str] = None
    articles: list[ArticleIn]
    tfidf_top_n: int = Field(default=TFIDF_TOP_N, ge=1, le=30)


class SourceDistinctiveWords(BaseModel):
    source_name: str
    words: list[str]
    scores: list[float]


class CountrySentiment(BaseModel):
    country: str
    n_articles: int
    avg_sentiment: float
    sentiment_se: float
    sentiment_label: str
    top_keywords: list[str] = []


class DataQuality(BaseModel):
    n_articles_truncated_for_sentiment: int
    sentiment_truncation_chars: int
    n_articles_with_text: int


class AnalyzeResponse(BaseModel):
    cluster_id: str
    n_articles: int
    n_sources: int
    n_countries: int
    divergence_score: Optional[float]
    divergence_label: Optional[str]
    pairwise_distance: dict[str, dict[str, float]]
    distinctive_words: list[SourceDistinctiveWords]
    country_sentiment: list[CountrySentiment]
    article_sentiment: dict[str, float]
    article_embeddings: dict[str, list[float]]
    data_quality: DataQuality
    sbert_model: str
    sentiment_model: str


app = FastAPI(title="NiP Perspective Sidecar")
_sbert: SentenceTransformer | None = None
_sentiment = None


def get_sbert() -> SentenceTransformer:
    global _sbert
    if _sbert is None:
        _sbert = SentenceTransformer(SBERT_MODEL)
    return _sbert


def get_sentiment():
    global _sentiment
    if _sentiment is None:
        # top_k=None returns all class probabilities so we can compute a
        # signed continuous score instead of label×confidence (which collapses
        # every "neutral" prediction to exactly 0.0).
        _sentiment = hf_pipeline(
            "sentiment-analysis",
            model=SENTIMENT_MODEL,
            truncation=True,
            max_length=512,
            top_k=None,
        )
    return _sentiment


def interpret(score: float | None) -> str | None:
    if score is None:
        return None
    if score < 0.08:
        return "low"
    if score < 0.15:
        return "moderate"
    if score < 0.25:
        return "high"
    return "very_high"


def label_sentiment(avg: float) -> str:
    if avg > 0.05:
        return "positive"
    if avg < -0.05:
        return "negative"
    return "neutral"


def score_articles(texts: list[str]) -> tuple[list[float], int]:
    """Returns (per-article sentiment scores, count truncated for sentiment)."""
    pipe = get_sentiment()
    inputs: list[str] = []
    truncated = 0
    for t in texts:
        if isinstance(t, str) and t.strip():
            if len(t) > SENTIMENT_TRUNCATION_CHARS:
                truncated += 1
            inputs.append(t[:SENTIMENT_TRUNCATION_CHARS])
        else:
            inputs.append("")
    valid_idx = [i for i, t in enumerate(inputs) if t]
    if not valid_idx:
        return [0.0] * len(texts), truncated
    results = pipe([inputs[i] for i in valid_idx], batch_size=16)
    scored = [0.0] * len(texts)
    # With top_k=None, each result is a list of {label, score} for every class.
    # Score is computed as P(positive) − P(negative) so neutral-leaning articles
    # still produce a continuous signed value instead of collapsing to 0.0.
    for i, r in zip(valid_idx, results):
        if isinstance(r, dict):
            r = [r]
        probs = {SENTIMENT_LABEL_FALLBACK.get(item["label"].lower(), item["label"].lower()): float(item["score"]) for item in r}
        score = probs.get("positive", 0.0) - probs.get("negative", 0.0)
        scored[i] = round(score, 4)
    return scored, truncated


def compute_distinctive(
    articles: list[ArticleIn], top_n: int
) -> list[SourceDistinctiveWords]:
    by_source: dict[str, list[str]] = {}
    for a in articles:
        cleaned = clean_text(a.text)
        if cleaned:
            by_source.setdefault(a.source_name, []).append(cleaned)
    if len(by_source) < 2:
        return []

    sources = list(by_source.keys())
    docs = [" ".join(by_source[s]) for s in sources]

    token_pat = rf"[a-zA-Z]{{{TFIDF_MIN_CHARS},}}"
    try:
        sklearn_stopwords = TfidfVectorizer(stop_words="english").get_stop_words()
    except Exception:
        sklearn_stopwords = set()
    combined_stopwords = list(set(sklearn_stopwords) | NEWS_STOPWORDS | CORPUS_STOPWORDS)

    # Include bigrams so distinctive phrases like "amna nawaz", "david wessel",
    # or "federal reserve" stay together instead of fragmenting into surnames
    # and first names that look more "distinctive" than the full phrase.
    vec = TfidfVectorizer(
        stop_words=combined_stopwords,
        max_df=TFIDF_MAX_DF,
        min_df=1,
        token_pattern=token_pat,
        ngram_range=(1, 2),
    )
    try:
        matrix = vec.fit_transform(docs)
    except ValueError:
        return []

    features = vec.get_feature_names_out()
    out: list[SourceDistinctiveWords] = []
    # Pull a wider top-K, then prefer bigrams: drop a unigram if a higher-scoring
    # bigram already contains it (so "david" is hidden when "david wessel" wins).
    fetch_n = top_n * 3
    for i, source in enumerate(sources):
        row = matrix[i].toarray().flatten()
        candidate_idx = row.argsort()[-fetch_n:][::-1]
        kept_words: list[str] = []
        kept_scores: list[float] = []
        seen_bigram_tokens: set[str] = set()
        for j in candidate_idx:
            if row[j] <= 0:
                continue
            term = features[j]
            tokens = term.split()
            if len(tokens) == 1:
                if term in seen_bigram_tokens:
                    continue
            else:
                seen_bigram_tokens.update(tokens)
            kept_words.append(term)
            kept_scores.append(round(float(row[j]), 4))
            if len(kept_words) >= top_n:
                break
        out.append(SourceDistinctiveWords(source_name=source, words=kept_words, scores=kept_scores))
    return out


def compute_divergence(
    articles: list[ArticleIn],
) -> tuple[float | None, dict[str, dict[str, float]], dict[str, list[float]]]:
    """
    Returns (score, pairwise_distance, article_embeddings).

    Embeds only articles that don't already carry an `embedding` payload.
    Returned embeddings cover every article so the caller can persist them.
    """
    valid = [a for a in articles if a.text.strip()]
    if not valid:
        return None, {}, {}

    needs_encode = [a for a in valid if a.embedding is None]
    new_vectors: dict[str, np.ndarray] = {}
    if needs_encode:
        model = get_sbert()
        encoded = model.encode(
            [a.text for a in needs_encode],
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        for a, vec in zip(needs_encode, encoded):
            new_vectors[a.article_id] = vec.astype(np.float32)

    article_embeddings: dict[str, list[float]] = {}
    by_source: dict[str, list[np.ndarray]] = {}
    for a in valid:
        vec = (
            new_vectors[a.article_id]
            if a.article_id in new_vectors
            else np.asarray(a.embedding, dtype=np.float32)
        )
        article_embeddings[a.article_id] = vec.tolist()
        by_source.setdefault(a.source_name, []).append(vec)

    if len(by_source) < 2:
        return None, {}, article_embeddings

    names = list(by_source.keys())
    mat = np.vstack([np.mean(np.vstack(by_source[s]), axis=0) for s in names])
    dist = cosine_distances(mat)

    iu = np.triu_indices_from(dist, k=1)
    score = float(dist[iu].mean()) if iu[0].size else None

    pairwise = {
        a: {b: round(float(dist[i, j]), 4) for j, b in enumerate(names)}
        for i, a in enumerate(names)
    }
    return score, pairwise, article_embeddings


def aggregate_country_sentiment(
    articles: list[ArticleIn],
    article_scores: list[float],
    top_keywords_n: int = 5,
) -> list[CountrySentiment]:
    by_country_scores: dict[str, list[float]] = {}
    by_country_keywords: dict[str, Counter[str]] = {}
    for a, s in zip(articles, article_scores):
        if not a.country or a.country == "Unknown":
            continue
        by_country_scores.setdefault(a.country, []).append(s)
        if a.keywords:
            counter = by_country_keywords.setdefault(a.country, Counter())
            for kw in a.keywords:
                if isinstance(kw, str):
                    norm = kw.strip()
                    if norm:
                        counter[norm] += 1

    out: list[CountrySentiment] = []
    for country, scores in by_country_scores.items():
        n = len(scores)
        arr = np.asarray(scores, dtype=float)
        avg = float(arr.mean())
        std = float(arr.std(ddof=1)) if n > 1 else 0.0
        se = std / np.sqrt(n) if n > 1 else 0.0
        kw_counter = by_country_keywords.get(country)
        top_keywords = (
            [kw for kw, _ in kw_counter.most_common(top_keywords_n)]
            if kw_counter
            else []
        )
        out.append(
            CountrySentiment(
                country=country,
                n_articles=n,
                avg_sentiment=round(avg, 4),
                sentiment_se=round(se, 4),
                sentiment_label=label_sentiment(avg),
                top_keywords=top_keywords,
            )
        )
    out.sort(key=lambda x: x.n_articles, reverse=True)
    return out


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "sbert_model": SBERT_MODEL,
        "sentiment_model": SENTIMENT_MODEL,
        "sbert_loaded": _sbert is not None,
        "sentiment_loaded": _sentiment is not None,
    }


@app.post("/warmup")
def warmup() -> dict:
    get_sbert()
    get_sentiment()
    return {"ok": True}


@app.post("/analyze-cluster", response_model=AnalyzeResponse)
def analyze_cluster(req: AnalyzeRequest) -> AnalyzeResponse:
    articles = [a for a in req.articles if isinstance(a.text, str) and a.text.strip()]
    n_sources = len({a.source_name for a in articles})
    countries = {a.country for a in articles if a.country and a.country != "Unknown"}

    article_scores, n_truncated = score_articles([a.text for a in articles])
    article_sentiment = {a.article_id: s for a, s in zip(articles, article_scores)}

    score, pairwise, article_embeddings = compute_divergence(articles)
    distinctive = compute_distinctive(articles, top_n=req.tfidf_top_n)
    country_sentiment = aggregate_country_sentiment(articles, article_scores)

    return AnalyzeResponse(
        cluster_id=req.cluster_id,
        n_articles=len(articles),
        n_sources=n_sources,
        n_countries=len(countries),
        divergence_score=round(score, 4) if score is not None else None,
        divergence_label=interpret(score),
        pairwise_distance=pairwise,
        distinctive_words=distinctive,
        country_sentiment=country_sentiment,
        article_sentiment=article_sentiment,
        article_embeddings=article_embeddings,
        data_quality=DataQuality(
            n_articles_truncated_for_sentiment=n_truncated,
            sentiment_truncation_chars=SENTIMENT_TRUNCATION_CHARS,
            n_articles_with_text=len(articles),
        ),
        sbert_model=SBERT_MODEL,
        sentiment_model=SENTIMENT_MODEL,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.environ.get("PERSPECTIVE_HOST", "127.0.0.1"),
        port=int(os.environ.get("PERSPECTIVE_PORT", "5710")),
        reload=False,
    )
