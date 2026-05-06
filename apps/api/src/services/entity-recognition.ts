/**
 * Entity Recognition Service (NER).
 *
 * Thin client over the spaCy sidecar at `apps/ner` (FastAPI + en_core_web_sm).
 * The sidecar URL is configured via NER_SERVICE_URL.
 *
 * Label mapping spaCy → EntityType:
 *   PERSON → PERSON
 *   ORG    → ORG
 *   GPE    → GPE
 *   LOC    → GPE   (collapsed; the EntityType enum has no LOC)
 *   EVENT  → EVENT
 * DATE is intentionally dropped — Wikipedia linking on bare dates isn't useful.
 */
import {
  EntityType,
  EntityMention,
  EntityRecognitionResult,
  NERConfig,
} from "../domain/entity-types.js";

const DEFAULT_CONFIDENCE = 0.9;
const DEFAULT_TIMEOUT_MS = 30_000;
const CONTEXT_MAX_CHARS = 320;

interface SidecarEntity {
  text: string;
  label: string;
  start: number;
  end: number;
}

interface SidecarResponse {
  entities: SidecarEntity[];
  truncated: boolean;
}

const SPACY_LABEL_MAP: Record<string, EntityType> = {
  PERSON: EntityType.PERSON,
  ORG: EntityType.ORG,
  GPE: EntityType.GPE,
  LOC: EntityType.GPE,
  EVENT: EntityType.EVENT,
};

function getServiceUrl(): string {
  const url = process.env.NER_SERVICE_URL;
  if (!url) {
    throw new Error(
      "NER_SERVICE_URL is not set. Start the spaCy sidecar (apps/ner) and set NER_SERVICE_URL.",
    );
  }
  return url.replace(/\/$/, "");
}

function getTimeoutMs(): number {
  const raw = process.env.NER_SERVICE_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

class EntityRecognitionService {
  private minConfidence: number = 0.6;

  async recognizeEntities(
    text: string,
    config?: NERConfig,
  ): Promise<EntityRecognitionResult> {
    const startTime = Date.now();
    const minConf = config?.minConfidence ?? this.minConfidence;
    const typeFilter = config?.entityTypes;

    if (!text || !text.trim()) {
      return emptyResult(Date.now() - startTime);
    }

    const sidecarEntities = await this.callSidecar(text);

    const seen = new Map<string, EntityMention>();
    for (const ent of sidecarEntities) {
      const mappedType = SPACY_LABEL_MAP[ent.label];
      if (!mappedType) continue;
      if (typeFilter && !typeFilter.includes(mappedType)) continue;
      const entityText = ent.text.trim();
      if (!entityText) continue;
      const confidence = DEFAULT_CONFIDENCE;
      if (confidence < minConf) continue;

      const key = `${entityText.toLowerCase()}::${mappedType}`;
      const existing = seen.get(key);
      if (existing && existing.confidence >= confidence) continue;

      seen.set(key, {
        entityText,
        entityType: mappedType,
        startOffset: ent.start,
        endOffset: ent.end,
        confidence,
        context: extractContext(text, ent.start, ent.end),
      });
    }

    const mentions = Array.from(seen.values());
    const stats = calculateStatistics(mentions);
    const max = config?.maxEntitiesPerArticle;
    const limited = max && mentions.length > max ? mentions.slice(0, max) : mentions;

    return {
      entities: limited,
      totalEntities: limited.length,
      processingTime: Date.now() - startTime,
      confidence: stats.confidence,
      byType: stats.byType,
    };
  }

  async recognizeEntitiesForArticles(
    articles: Array<{ id: string; text: string }>,
    config?: NERConfig,
  ): Promise<Map<string, EntityRecognitionResult>> {
    const out = new Map<string, EntityRecognitionResult>();
    await Promise.all(
      articles.map(async (article) => {
        try {
          out.set(article.id, await this.recognizeEntities(article.text, config));
        } catch (error) {
          console.error(`NER failed for article ${article.id}:`, error);
          out.set(article.id, emptyResult(0));
        }
      }),
    );
    return out;
  }

  setMinConfidence(threshold: number): void {
    if (threshold < 0 || threshold > 1) {
      throw new Error("Confidence threshold must be between 0 and 1");
    }
    this.minConfidence = threshold;
  }

  private async callSidecar(text: string): Promise<SidecarEntity[]> {
    const url = `${getServiceUrl()}/extract`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getTimeoutMs());
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`NER sidecar ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as SidecarResponse;
      return data.entities ?? [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract a sentence-aligned context snippet around an entity mention.
 *
 * Strategy:
 *   1. Walk backwards/forwards from [start, end] to find the nearest
 *      sentence boundaries (`.`, `!`, `?` followed by whitespace, or
 *      paragraph break / start/end of text).
 *   2. That gives the host sentence containing the mention.
 *   3. If we're still under CONTEXT_MAX_CHARS, greedily extend by one
 *      sentence on either side until the budget is hit.
 *   4. If even the host sentence exceeds the budget, fall back to a
 *      word-boundary-snapped fixed window so we don't cut mid-word.
 */
function extractContext(text: string, start: number, end: number): string {
  if (!text) return "";
  const sentenceBoundary = /[.!?](?:\s+|$)|\n\n+/g;

  let sentStart = 0;
  let sentEnd = text.length;
  let match: RegExpExecArray | null;
  while ((match = sentenceBoundary.exec(text)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    if (boundaryEnd <= start) {
      sentStart = boundaryEnd;
    } else if (match.index >= end) {
      sentEnd = boundaryEnd;
      break;
    }
  }

  let from = sentStart;
  let to = sentEnd;

  if (to - from > CONTEXT_MAX_CHARS) {
    // Host sentence alone is too long — snap to word boundaries inside it.
    const half = Math.floor(CONTEXT_MAX_CHARS / 2);
    let nearStart = Math.max(from, start - half);
    let nearEnd = Math.min(to, end + half);
    const lead = text.indexOf(" ", nearStart);
    if (lead !== -1 && lead < start) nearStart = lead + 1;
    const trail = text.lastIndexOf(" ", nearEnd);
    if (trail !== -1 && trail > end) nearEnd = trail;
    return text.slice(nearStart, nearEnd).trim();
  }

  // Greedy extend by neighbouring sentences while we still fit the budget.
  const grow = (direction: "before" | "after"): boolean => {
    if (direction === "before") {
      if (from === 0) return false;
      const prevSlice = text.slice(0, from);
      const re = /[.!?](?:\s+|$)|\n\n+/g;
      let lastBoundaryEnd = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(prevSlice)) !== null) {
        lastBoundaryEnd = m.index + m[0].length;
      }
      const prevSentenceStart = lastBoundaryEnd;
      const candidateLen = to - prevSentenceStart;
      if (candidateLen > CONTEXT_MAX_CHARS) return false;
      from = prevSentenceStart;
      return true;
    }
    if (to >= text.length) return false;
    const re = /[.!?](?:\s+|$)|\n\n+/g;
    re.lastIndex = to;
    const m = re.exec(text);
    const nextEnd = m ? m.index + m[0].length : text.length;
    const candidateLen = nextEnd - from;
    if (candidateLen > CONTEXT_MAX_CHARS) return false;
    to = nextEnd;
    return true;
  };

  let extended = true;
  while (extended) {
    extended = grow("after") || grow("before");
  }

  return text.slice(from, to).trim();
}

function calculateStatistics(mentions: EntityMention[]) {
  const byType: { [key in EntityType]?: number } = {};
  let sum = 0;
  let min = 1;
  let max = 0;
  for (const m of mentions) {
    byType[m.entityType] = (byType[m.entityType] ?? 0) + 1;
    sum += m.confidence;
    if (m.confidence < min) min = m.confidence;
    if (m.confidence > max) max = m.confidence;
  }
  return {
    byType,
    confidence: {
      min: mentions.length ? min : 0,
      max: mentions.length ? max : 0,
      average: mentions.length ? sum / mentions.length : 0,
    },
  };
}

function emptyResult(processingTime: number): EntityRecognitionResult {
  return {
    entities: [],
    totalEntities: 0,
    processingTime,
    confidence: { min: 0, max: 0, average: 0 },
    byType: {},
  };
}

export const entityRecognitionService = new EntityRecognitionService();
export { EntityRecognitionService };
