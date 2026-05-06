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
  /**
   * `false` when the input text isn't a real article — corporate footer,
   * registration/copyright boilerplate, paywall page, login wall, photo-only
   * captioned page, or under ~30 words of substantive prose. Downstream
   * consumers should treat non-newsworthy articles like empty articles
   * (skip clustering, skip perspective, skip entity linking).
   */
  isNewsworthy: boolean;
  notNewsworthyReason: string | null;
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
      isNewsworthy?: unknown;
      notNewsworthyReason?: unknown;
      keywords?: unknown;
      translatedTitle?: unknown;
      translatedSummary?: unknown;
      translatedFullText?: unknown;
      persons?: unknown;
      organizations?: unknown;
      places?: unknown;
      language?: unknown;
    };

    // Default to newsworthy when the field is missing — older cached
    // responses (from before this field was added) shouldn't all flip to
    // non-newsworthy. Only treat as not-newsworthy when the model
    // explicitly returns `false`.
    const isNewsworthy =
      typeof parsed.isNewsworthy === "boolean" ? parsed.isNewsworthy : true;

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
      isNewsworthy,
      notNewsworthyReason:
        typeof parsed.notNewsworthyReason === "string"
          ? parsed.notNewsworthyReason.trim() || null
          : null,
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
      isNewsworthy: true,
      notNewsworthyReason: null,
      model: primaryModel,
      error: "OPENROUTER_API_KEY missing",
    };
  }

  // We now ALWAYS request a populated translatedFullText whenever the body
  // has content — the model produces either the English translation
  // (non-English input) or the chrome-stripped English (English input).
  // The "non-newsworthy" early exit lets the model bail without translation
  // when the body is boilerplate.
  const bodyHasContent = Boolean(input.body && input.body.trim());
  const cappedBody = input.body ? input.body.slice(0, TRANSLATED_FULL_TEXT_MAX_CHARS) : "";

  const prompt = [
    "Analyze this news article and return strict JSON only.",
    "JSON shape:",
    "{\"isNewsworthy\":true,\"notNewsworthyReason\":\"...\",\"keywords\":[\"...\"],\"translatedTitle\":\"...\",\"translatedSummary\":\"...\",\"translatedFullText\":\"...\",\"persons\":[\"...\"],\"organizations\":[\"...\"],\"places\":[\"...\"],\"language\":\"...\"}",
    "isNewsworthy rules:",
    "- false if the Body is corporate footer / registration / copyright / address / phone / business-license boilerplate (e.g. starts with 'CEO:', contains 'business registration number', 'communication sales registration', 'All Rights Reserved' as the bulk of the text)",
    "- false if Body is a paywall / login / subscription wall (e.g. 'Become an Insider', 'Subscribe to read', 'Sign in to continue')",
    "- false if Body is purely image-caption / photo-credit text (e.g. mostly '<photographer>/<agency>', 'hide caption', 'toggle caption')",
    "- false if Body is < ~30 words of substantive prose after stripping chrome",
    "- otherwise true",
    "- when false, set notNewsworthyReason to a short phrase like 'corporate boilerplate', 'paywall', 'photo-credit page', 'too short'",
    "Body cleanup rules (apply to translatedFullText AND to the body you analyse for keywords/entities):",
    "- ALWAYS populate translatedFullText, even when the Body is already English — output the cleaned English body",
    "- strip image captions and photo credits: lines like 'A bulk cargo ship sits at anchor in the Strait of Hormuz off Bandar Abbas, Iran, Saturday, May 2, 2026.', 'Amirhosein Khorgooi/AP/ISNA', 'Getty Images', 'Reuters/<name>', 'AP Photo/<name>'",
    "- strip UI labels: 'hide caption', 'toggle caption', 'Read more', 'Read next', 'Share', 'Sign up', 'Subscribe'",
    "- strip newsletter / podcast / 'follow us' prompts and social-share lines",
    "- strip navigation / breadcrumb / category lines and 'related articles' teasers",
    "- preserve paragraph breaks of actual article content",
    "- if cleanup leaves < 30 words, set isNewsworthy=false and translatedFullText=null",
    "Keyword/entity rules:",
    `- return at most ${maxKeywords} keywords`,
    "- keywords must be concise English topical labels of 1 to 4 words",
    "- use specific topical concepts, not generic labels",
    "- do not output vague keywords such as: news, article, report, issue, attack, company milestone, analysis, story, update, release, event",
    "- preserve proper names exactly when possible",
    "- translatedTitle and translatedSummary must be close English translations, not rewrites",
    "- translatedSummary should be 1 sentence, faithful, and plain factual prose",
    "- persons, organizations, and places must be distinct arrays",
    "- language must be a lowercase ISO-639-1 code like en, fr, de, es, it, tr, el, zh, ja, ko, ru, ar",
    "- if uncertain, use null for strings and [] for arrays",
    "Keyword guidance:",
    "- prefer terms like: \"Zoom security\", \"macOS malware\", \"privilege escalation\", \"Lazarus Group\"",
    "- avoid terms like: \"released\", \"new\", \"cyber attack\" unless the text is explicitly about an attack campaign and no more specific label exists",
    "Examples:",
    "Example 1 input title: The 'S' in Zoom, Stands for Security",
    "Example 1 output: {\"isNewsworthy\":true,\"notNewsworthyReason\":null,\"keywords\":[\"Zoom security\",\"privilege escalation\",\"macOS vulnerability\",\"webcam access\",\"microphone access\"],\"translatedTitle\":\"The 'S' in Zoom, Stands for Security\",\"translatedSummary\":\"The article describes two local security flaws in Zoom's macOS client, including privilege escalation and covert webcam and microphone access.\",\"translatedFullText\":\"<cleaned body>\",\"persons\":[],\"organizations\":[\"Zoom\"],\"places\":[],\"language\":\"en\"}",
    "Example 2 (non-newsworthy): Body is 'JTBC Co., Ltd. CEO: Jeon Jin-bae, address: 38 Sangam-san-ro... business registration number: 104-86-33995... All Rights Reserved.'",
    "Example 2 output: {\"isNewsworthy\":false,\"notNewsworthyReason\":\"corporate boilerplate\",\"keywords\":[],\"translatedTitle\":null,\"translatedSummary\":null,\"translatedFullText\":null,\"persons\":[],\"organizations\":[\"JTBC\"],\"places\":[],\"language\":\"en\"}",
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
        bodyHasContent,
      ),
    {
      shouldCache: (result) => result.error === null,
      onAttemptLog: log,
    },
  );
}

function isResponseComplete(
  parsed: Omit<OpenRouterArticleEnrichmentResult, "model" | "error">,
  bodyHasContent: boolean,
): boolean {
  // Non-newsworthy responses are inherently terminal — accept them with
  // null fields. Some smaller free models otherwise refuse to populate
  // translatedFullText for boilerplate, which would loop forever.
  if (!parsed.isNewsworthy) return true;
  // For real articles we now require translatedFullText whenever the body
  // had substantive content (English or not). This guarantees the
  // chrome-stripped English version is always available downstream.
  if (bodyHasContent && !parsed.translatedFullText) return false;
  return true;
}

async function runArticleEnrichmentRequest(
  input: OpenRouterArticleEnrichmentInput,
  prompt: string,
  models: string[],
  primaryModel: string,
  log: ((message: string) => void) | undefined,
  bodyHasContent: boolean,
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

      if (parsed && isResponseComplete(parsed, bodyHasContent)) {
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
    if (parsed && isResponseComplete(parsed, bodyHasContent)) {
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
    isNewsworthy: true,
    notNewsworthyReason: null,
    model: primaryModel,
    error: lastError,
  };
}
