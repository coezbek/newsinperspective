import { env } from "../config/env.js";
import { orderOpenRouterModels, resolveOpenRouterModels } from "./openrouter-models.js";
import { callOpenAIFallback } from "./openai-fallback.js";
import { withLlmCache } from "./llm-cache.js";

interface OpenRouterArticleEnrichmentInput {
  title: string;
  summary: string | null;
  body: string | null;
  language: string | null;
  maxKeywords?: number;
  onAttemptLog?: (message: string) => void;
}

export interface OpenRouterArticleEnrichmentResult {
  keywords: string[];
  translatedTitle: string | null;
  translatedSummary: string | null;
  translatedFullText: string | null;
  persons: string[];
  organizations: string[];
  places: string[];
  language: string | null;
  model: string;
  error: string | null;
}

const TRANSLATED_FULL_TEXT_MAX_CHARS = 6000;

const openRouterTimeoutMs = 8_000;
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

function uniqueStrings(values: unknown, limit = 8): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, limit);
}

function parseEnrichmentFromResponse(content: string): Omit<OpenRouterArticleEnrichmentResult, "model" | "error"> | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      keywords?: unknown;
      translatedTitle?: unknown;
      translatedSummary?: unknown;
      translatedFullText?: unknown;
      persons?: unknown;
      organizations?: unknown;
      places?: unknown;
      language?: unknown;
    };

    return {
      keywords: uniqueStrings(parsed.keywords),
      translatedTitle: typeof parsed.translatedTitle === "string" ? parsed.translatedTitle.trim() || null : null,
      translatedSummary:
        typeof parsed.translatedSummary === "string" ? parsed.translatedSummary.trim() || null : null,
      translatedFullText:
        typeof parsed.translatedFullText === "string" ? parsed.translatedFullText.trim() || null : null,
      persons: uniqueStrings(parsed.persons),
      organizations: uniqueStrings(parsed.organizations),
      places: uniqueStrings(parsed.places),
      language: typeof parsed.language === "string" ? parsed.language.trim() || null : null,
    };
  } catch {
    return null;
  }
}

export async function extractArticleEnrichmentWithOpenRouter(
  input: OpenRouterArticleEnrichmentInput,
): Promise<OpenRouterArticleEnrichmentResult> {
  const log = input.onAttemptLog;
  const models = resolveOpenRouterModels(env.OPENROUTER_MODEL);
  const primaryModel = models[0]!;
  const maxKeywords = input.maxKeywords ?? 8;

  if (!env.OPENROUTER_API_KEY) {
    return {
      keywords: [],
      translatedTitle: null,
      translatedSummary: null,
      translatedFullText: null,
      persons: [],
      organizations: [],
      places: [],
      language: input.language,
      model: primaryModel,
      error: "OPENROUTER_API_KEY missing",
    };
  }

  // Treat "unknown language" the same as "non-English": we'd rather pay for a
  // translation that might come back null than miss one because the heuristic
  // language detector hadn't fired yet.
  const isDefinitelyEnglish =
    typeof input.language === "string" && input.language.toLowerCase().slice(0, 2) === "en";
  const requestFullTextTranslation = !isDefinitelyEnglish && Boolean(input.body && input.body.trim());
  const cappedBody = input.body ? input.body.slice(0, TRANSLATED_FULL_TEXT_MAX_CHARS) : "";

  const prompt = [
    "Analyze this news article and return strict JSON only.",
    "JSON shape:",
    "{\"keywords\":[\"...\"],\"translatedTitle\":\"...\",\"translatedSummary\":\"...\",\"translatedFullText\":\"...\",\"persons\":[\"...\"],\"organizations\":[\"...\"],\"places\":[\"...\"],\"language\":\"...\"}",
    "Output rules:",
    `- return at most ${maxKeywords} keywords`,
    "- keywords must be concise English topical labels of 1 to 4 words",
    "- use specific topical concepts, not generic labels",
    "- do not output vague keywords such as: news, article, report, issue, attack, company milestone, analysis, story, update, release, event",
    "- preserve proper names exactly when possible",
    "- translatedTitle and translatedSummary must be close English translations, not rewrites",
    "- translatedSummary should be 1 sentence, faithful, and plain factual prose",
    requestFullTextTranslation
      ? "- translatedFullText must be a faithful English translation of the Body, preserving paragraph breaks; do not summarise; if the Body is already English, return null"
      : "- translatedFullText must be null (the article is already English or has no body)",
    "- persons, organizations, and places must be distinct arrays",
    "- language must be a lowercase ISO-639-1 code like en, fr, de, es, it, tr, el, zh, ja, ko, ru, ar",
    "- if uncertain, use null for strings and [] for arrays",
    "Keyword guidance:",
    "- prefer terms like: \"Zoom security\", \"macOS malware\", \"privilege escalation\", \"Lazarus Group\"",
    "- avoid terms like: \"released\", \"new\", \"cyber attack\" unless the text is explicitly about an attack campaign and no more specific label exists",
    "Examples:",
    "Example 1 input title: The 'S' in Zoom, Stands for Security",
    "Example 1 output: {\"keywords\":[\"Zoom security\",\"privilege escalation\",\"macOS vulnerability\",\"webcam access\",\"microphone access\"],\"translatedTitle\":\"The 'S' in Zoom, Stands for Security\",\"translatedSummary\":\"The article describes two local security flaws in Zoom's macOS client, including privilege escalation and covert webcam and microphone access.\",\"persons\":[],\"organizations\":[\"Zoom\"],\"places\":[],\"language\":\"en\"}",
    "Example 2 input title: From Italy With Love?",
    "Example 2 output: {\"keywords\":[\"HackingTeam\",\"reverse engineering\",\"Russian implant\",\"cyber espionage\",\"surveillance malware\"],\"translatedTitle\":\"From Italy With Love?\",\"translatedSummary\":\"The article says reverse engineering of a supposed Russian implant revealed code associated with HackingTeam.\",\"persons\":[],\"organizations\":[\"HackingTeam\"],\"places\":[\"Italy\",\"Russia\"],\"language\":\"en\"}",
    "",
    `Title: ${input.title}`,
    `Summary: ${input.summary ?? ""}`,
    `Body: ${cappedBody}`,
  ].join("\n");

  return withLlmCache(
    { kind: "openrouter-article-enrichment", prompt },
    () =>
      runArticleEnrichmentRequest(
        input,
        prompt,
        models,
        primaryModel,
        log,
        requestFullTextTranslation,
      ),
    {
      shouldCache: (result) => result.error === null,
      onAttemptLog: log,
    },
  );
}

function isResponseComplete(
  parsed: Omit<OpenRouterArticleEnrichmentResult, "model" | "error">,
  requestFullTextTranslation: boolean,
): boolean {
  // If we asked for a translation but the model returned nothing, the
  // response is incomplete — some smaller free models silently skip the
  // translatedFullText field. Reject so the loop tries another model.
  if (requestFullTextTranslation && !parsed.translatedFullText) return false;
  return true;
}

async function runArticleEnrichmentRequest(
  input: OpenRouterArticleEnrichmentInput,
  prompt: string,
  models: string[],
  primaryModel: string,
  log: ((message: string) => void) | undefined,
  requestFullTextTranslation: boolean,
): Promise<OpenRouterArticleEnrichmentResult> {
  let lastError = "OpenRouter request failed";
  const maxRounds = openRouterBackoffScheduleMs.length + 1;

  for (let round = 0; round < maxRounds; round += 1) {
    const orderedModels = orderOpenRouterModels(models, `${input.title}:${input.language ?? "unknown"}`, { round });
    let sawRetryableError = false;
    let maxRetryAfterMs: number | null = null;
    log?.(`round ${round + 1}/${maxRounds}: trying ${orderedModels.length} model(s)`);

    for (const model of orderedModels) {
      log?.(`round ${round + 1}/${maxRounds}: -> model ${model}`);
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
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        lastError = `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`;
        sawRetryableError = true;
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const details = await response.text();
        lastError = `OpenRouter error ${response.status}: ${details.slice(0, 240)}`;
        if (isRetryableStatus(response.status)) {
          sawRetryableError = true;
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          if (retryAfterMs !== null) {
            maxRetryAfterMs = maxRetryAfterMs === null ? retryAfterMs : Math.max(maxRetryAfterMs, retryAfterMs);
          }
        }
        continue;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content ?? "";
      const parsed = parseEnrichmentFromResponse(content);

      if (parsed && isResponseComplete(parsed, requestFullTextTranslation)) {
        return {
          ...parsed,
          model,
          error: null,
        };
      }

      lastError = parsed
        ? "Model returned incomplete enrichment (missing translatedFullText)"
        : "No parseable article enrichment JSON in model response";
      log?.(`round ${round + 1}/${maxRounds}: ${model} ${parsed ? "incomplete" : "parse failure"}`);
      sawRetryableError = true;
    }

    if (!sawRetryableError || round >= openRouterBackoffScheduleMs.length) {
      break;
    }

    await sleep(computeBackoffMs(round, maxRetryAfterMs));
  }

  // OpenRouter exhausted — try OpenAI direct as last resort.
  const fallback = await callOpenAIFallback({ prompt, onAttemptLog: log });
  if (fallback) {
    const parsed = parseEnrichmentFromResponse(fallback.content);
    if (parsed && isResponseComplete(parsed, requestFullTextTranslation)) {
      return {
        ...parsed,
        model: fallback.model,
        error: null,
      };
    }
    log?.(`openai-fallback: ${fallback.model} parse failure`);
  }

  return {
    keywords: [],
    translatedTitle: null,
    translatedSummary: null,
    translatedFullText: null,
    persons: [],
    organizations: [],
    places: [],
    language: input.language,
    model: primaryModel,
    error: lastError,
  };
}
