import { env } from "../config/env.js";
import { orderOpenRouterModels, resolveOpenRouterModels } from "./openrouter-models.js";
import { callOpenAIFallback } from "./openai-fallback.js";
import { withLlmCache } from "./llm-cache.js";
import { logLlmRequest, logLlmResponse } from "../lib/llm-trace.js";

const KEYWORDS_TRACE_KIND = "openrouter-keywords";

interface OpenRouterKeywordInput {
  title: string;
  summary: string | null;
  body: string | null;
  language: string | null;
  maxKeywords?: number;
  /**
   * Optional candidate keywords gathered from per-article enrichment in the
   * same cluster. When supplied, the prompt asks the model to consolidate
   * the cluster keyword set against these as anchors — i.e. prefer reusing
   * the most-frequent variants and merging near-synonyms ("climate
   * activism" / "climate campaign" / "climate change advocacy" → one) —
   * rather than re-extracting from scratch and inventing fresh wording.
   */
  seedKeywords?: string[];
  onAttemptLog?: (message: string) => void;
}

interface OpenRouterKeywordResult {
  keywords: string[];
  model: string;
  error: string | null;
}

const openRouterTimeoutMs = 6_000;
const openRouterBackoffScheduleMs = [5_000, 15_000, 60_000];
const openRouterMaxBackoffMs = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;

  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric * 1000);
  }

  const timestamp = Date.parse(header);
  if (Number.isNaN(timestamp)) return null;

  const delta = timestamp - Date.now();
  return delta > 0 ? delta : 0;
}

function computeBackoffMs(round: number, retryAfterMs: number | null): number {
  const scheduled = openRouterBackoffScheduleMs[round] ?? openRouterBackoffScheduleMs.at(-1) ?? 5_000;
  const base = retryAfterMs !== null ? Math.max(scheduled, retryAfterMs) : scheduled;
  const jitter = Math.floor(Math.random() * 1_500);
  return Math.min(base + jitter, openRouterMaxBackoffMs);
}

function parseKeywordsFromResponse(content: string): string[] {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { keywords?: unknown };
    if (!Array.isArray(parsed.keywords)) return [];
    return parsed.keywords
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function extractKeywordsWithOpenRouter(
  input: OpenRouterKeywordInput,
): Promise<OpenRouterKeywordResult> {
  const log = input.onAttemptLog;
  const models = resolveOpenRouterModels(env.OPENROUTER_MODEL);
  const primaryModel = models[0]!;
  const maxKeywords = input.maxKeywords ?? 8;

  if (!env.OPENROUTER_API_KEY) {
    return {
      keywords: [],
      model: primaryModel,
      error: "OPENROUTER_API_KEY missing",
    };
  }

  // Frequency-rank seed keywords so the most-mentioned variants surface
  // first in the prompt. Lowercased to collapse trivial casing dupes.
  const seedFreq = new Map<string, { surface: string; count: number }>();
  for (const k of input.seedKeywords ?? []) {
    const trimmed = k.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    const prev = seedFreq.get(key);
    if (prev) prev.count += 1;
    else seedFreq.set(key, { surface: trimmed, count: 1 });
  }
  const seedRanked = [...seedFreq.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 40)
    .map((entry) => (entry.count > 1 ? `${entry.surface} (×${entry.count})` : entry.surface));

  const prompt = [
    "Extract the most informative topical keywords from this news text.",
    "Return strict JSON only with this shape: {\"keywords\": [\"...\", \"...\"]}.",
    "Rules:",
    "- keep proper names if relevant",
    "- exclude stop words and generic discourse words",
    "- translate keywords into concise English labels",
    "- use specific topical labels, not generic labels",
    "- avoid vague keywords such as: news, article, report, issue, attack, analysis, update, release, event, company milestone",
    `- return at most ${maxKeywords} keywords`,
    "- preserve proper names closely when translating",
    "- prefer 1 to 4 words per keyword",
    ...(seedRanked.length > 0
      ? [
          "- The candidate-keywords list below was extracted from each individual",
          "  article in this cluster. Use it as the primary anchor: prefer reusing",
          "  the most-frequent variants verbatim and merging near-synonyms in it",
          "  to one canonical phrase (e.g. 'climate activism' / 'climate campaign'",
          "  / 'climate change advocacy' → one). Only invent a fresh phrase when",
          "  none of the candidates expresses the concept well.",
        ]
      : []),
    "Examples:",
    "- good: [\"Zoom security\", \"privilege escalation\", \"macOS vulnerability\", \"webcam access\"]",
    "- good: [\"Lazarus Group\", \"macOS malware\", \"fileless payloads\", \"in-memory loading\"]",
    "- bad: [\"released\", \"new\", \"cyber attack\", \"story\"]",
    "",
    ...(seedRanked.length > 0 ? [`Candidate keywords (frequency across articles): ${seedRanked.join(", ")}`, ""] : []),
    `Title: ${input.title}`,
    `Summary: ${input.summary ?? ""}`,
    `Body: ${input.body ?? ""}`,
  ].join("\n");

  return withLlmCache(
    { kind: "openrouter-keywords", prompt },
    () => runKeywordRequest(input, prompt, models, primaryModel, maxKeywords, log),
    {
      shouldCache: (result) => result.error === null,
      onAttemptLog: log,
    },
  );
}

async function runKeywordRequest(
  input: OpenRouterKeywordInput,
  prompt: string,
  models: string[],
  primaryModel: string,
  maxKeywords: number,
  log: ((message: string) => void) | undefined,
): Promise<OpenRouterKeywordResult> {
  // LLM_PRIMARY=openai: try OpenAI first; on parse/network failure, fall
  // through to the OpenRouter chain below as a safety net.
  if (env.LLM_PRIMARY === "openai" && env.OPENAI_API_KEY) {
    const direct = await callOpenAIFallback({
      prompt,
      onAttemptLog: log,
      kind: "keywords",
      contextId: input.title.slice(0, 80),
    });
    if (direct) {
      const keywords = parseKeywordsFromResponse(direct.content).slice(0, maxKeywords);
      if (keywords.length > 0) {
        return { keywords, model: direct.model, error: null };
      }
      log?.(`openai-primary: ${direct.model} parse failure — falling through to OpenRouter`);
    }
  }

  let lastError = "OpenRouter request failed";
  const maxRounds = openRouterBackoffScheduleMs.length + 1;

  for (let round = 0; round < maxRounds; round += 1) {
    const orderedModels = orderOpenRouterModels(models, `${input.title}:${input.language ?? "unknown"}`, { round });
    let sawRetryableError = false;
    let maxRetryAfterMs: number | null = null;
    log?.(`round ${round + 1}/${maxRounds}: trying ${orderedModels.length} model(s)`);

    for (const model of orderedModels) {
      log?.(`round ${round + 1}/${maxRounds}: -> model ${model}`);
      const trace = logLlmRequest({
        kind: KEYWORDS_TRACE_KIND,
        model,
        contextId: input.title.slice(0, 80),
        prompt,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), openRouterTimeoutMs);
      let response: Response | null = null;
      try {
        response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        lastError = `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`;
        log?.(`round ${round + 1}/${maxRounds}: ${model} network error: ${lastError.slice(0, 140)}`);
        logLlmResponse({
          id: trace.id, kind: KEYWORDS_TRACE_KIND, model,
          contextId: input.title.slice(0, 80), startedAt: trace.startedAt,
          ok: false, error: lastError,
        });
        sawRetryableError = true;
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const details = await response.text();
        lastError = `OpenRouter error ${response.status}: ${details.slice(0, 240)}`;
        logLlmResponse({
          id: trace.id, kind: KEYWORDS_TRACE_KIND, model,
          contextId: input.title.slice(0, 80), startedAt: trace.startedAt,
          ok: false, httpStatus: response.status, content: details, error: lastError,
        });
        log?.(`round ${round + 1}/${maxRounds}: ${model} http ${response.status}`);
        if (isRetryableStatus(response.status)) {
          sawRetryableError = true;
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          if (retryAfterMs !== null) {
            maxRetryAfterMs =
              maxRetryAfterMs === null ? retryAfterMs : Math.max(maxRetryAfterMs, retryAfterMs);
            log?.(
              `round ${round + 1}/${maxRounds}: ${model} retry-after ${Math.ceil(
                retryAfterMs / 1000,
              )}s`,
            );
          }
        }
        continue;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = payload.choices?.[0]?.message?.content ?? "";
      const finishReason = payload.choices?.[0]?.finish_reason;
      const keywords = parseKeywordsFromResponse(content).slice(0, maxKeywords);

      if (keywords.length > 0) {
        log?.(`round ${round + 1}/${maxRounds}: ${model} success (${keywords.length} keywords)`);
        logLlmResponse({
          id: trace.id, kind: KEYWORDS_TRACE_KIND, model,
          contextId: input.title.slice(0, 80), startedAt: trace.startedAt,
          ok: true, content, finishReason, usage: payload.usage ?? null,
        });
        return {
          keywords,
          model,
          error: null,
        };
      }

      lastError = "No parseable keyword JSON in model response";
      log?.(`round ${round + 1}/${maxRounds}: ${model} parse failure`);
      logLlmResponse({
        id: trace.id, kind: KEYWORDS_TRACE_KIND, model,
        contextId: input.title.slice(0, 80), startedAt: trace.startedAt,
        ok: false, content, finishReason, usage: payload.usage ?? null, error: lastError,
      });
      sawRetryableError = true;
    }

    if (!sawRetryableError || round >= openRouterBackoffScheduleMs.length) {
      break;
    }

    const backoffMs = computeBackoffMs(round, maxRetryAfterMs);
    log?.(
      `round ${round + 1}/${maxRounds}: backing off for ${Math.ceil(backoffMs / 1000)}s before retry`,
    );
    await sleep(backoffMs);
  }

  // OpenRouter exhausted — fall back to OpenAI direct if configured.
  const fallback = await callOpenAIFallback({
    prompt,
    onAttemptLog: log,
    kind: "keywords",
    contextId: input.title.slice(0, 80),
  });
  if (fallback) {
    const keywords = parseKeywordsFromResponse(fallback.content).slice(0, maxKeywords);
    if (keywords.length > 0) {
      return {
        keywords,
        model: fallback.model,
        error: null,
      };
    }
    log?.(`openai-fallback: ${fallback.model} parse failure`);
  }

  return {
    keywords: [],
    model: primaryModel,
    error: lastError,
  };
}
