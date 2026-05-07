import { env } from "../config/env.js";
import { orderOpenRouterModels, resolveOpenRouterModels } from "./openrouter-models.js";
import { callOpenAIFallback } from "./openai-fallback.js";
import { withLlmCache } from "./llm-cache.js";
import { logLlmRequest, logLlmResponse } from "../lib/llm-trace.js";
import { isProbablyEnglish } from "../lib/language-check.js";

interface OpenRouterArticleEnrichmentInput {
  title: string;
  summary: string | null;
  body: string | null;
  language: string | null;
  maxKeywords?: number;
  onAttemptLog?: (message: string) => void;
  /** Optional correlation id (article DB id) for the LLM trace log. */
  contextId?: string;
}

export interface OpenRouterArticleEnrichmentResult {
  keywords: string[];
  translatedTitle: string | null;
  translatedSummary: string | null;
  translatedFullText: string | null;
  /**
   * Abstractive 4-6 sentence summary written specifically to capture this
   * article's distinctive framing/stance. Used by SBERT for cluster
   * framing-divergence — short enough to never hit output-token caps, and
   * higher signal-to-noise than the full body (which often shares verbatim
   * wire-service quotes across sources). Falls back to translatedFullText
   * downstream when null.
   */
  framingSummary: string | null;
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
  /**
   * `true` when WE truncated the input body before sending to the model
   * (the original article exceeded `TRANSLATED_FULL_TEXT_MAX_CHARS`). We
   * always know this — it's set client-side regardless of model output.
   * Downstream consumers can use this to caveat the summary or prioritise
   * articles for re-extraction with longer source text.
   */
  inputTruncated: boolean;
  /**
   * The model's own assessment of whether the body it received looks
   * truncated (ends mid-sentence, mid-thought, etc.). Distinct from
   * `inputTruncated`: a model can correctly judge a complete-but-short
   * body as "not truncated" even when we never sliced. Conversely, when
   * we DID slice, the model usually agrees. `null` if the model omitted
   * the field (older cached responses or models that ignore the prompt).
   */
  bodyAppearsTruncated: boolean | null;
  model: string;
  error: string | null;
}

/**
 * Input body cap before sending to the LLM. Sized so that the cleaned
 * `translatedFullText` echoed back can plausibly fit inside
 * `ENRICHMENT_MAX_OUTPUT_TOKENS` alongside the framingSummary, JSON
 * structural overhead, keywords, entity arrays, and translated title/summary.
 * 10K chars input → ~3K-4K tokens output for English; CJK-to-English
 * translation can expand, but stays within budget for typical articles.
 *
 * Articles longer than this are sliced and `inputTruncated=true` is set on
 * the result so downstream consumers know the body was abridged. When that
 * happens we don't penalise body-shaped output truncation — the model is
 * only obligated to summarise what we sent it.
 */
const TRANSLATED_FULL_TEXT_MAX_CHARS = 10_000;

/**
 * Output token budget for the enrichment response. Calibrated to fit the
 * full JSON reply for a body up to TRANSLATED_FULL_TEXT_MAX_CHARS:
 *   - translatedFullText echoes the cleaned body (~3K-4K tokens)
 *   - framingSummary (~250 tokens at 1000 chars)
 *   - keywords / persons / organizations / places arrays (~200 tokens)
 *   - translatedTitle / translatedSummary (~150 tokens)
 *   - JSON structural overhead, escaping (~150 tokens)
 *
 * Reasoning models (DeepSeek V4 Flash, R1, etc.) emit hidden chain-of-thought
 * BEFORE the JSON content, and those tokens count against `max_tokens`. We
 * disable reasoning output via `reasoning: { exclude: true }` in the request
 * body so the budget is spent on the JSON we actually consume — but we still
 * keep a comfortable headroom in case a provider ignores the flag. 8K is
 * empirically enough for a clean reply on the longest articles we accept.
 *
 * Free-tier OpenRouter models default to surprisingly low limits (some land
 * at 1024 tokens), which truncates `translatedFullText` mid-sentence and
 * then the JSON parser drops the whole reply as malformed — but worse,
 * sometimes the reply parses with a truncated string and we silently
 * persist the partial body. Setting a generous explicit cap makes
 * truncation deterministic across the model rotation.
 */
const ENRICHMENT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Length floor / ceiling for `framingSummary` accepted from the model.
 * Below the floor, the field is a near-empty stub (e.g. "The article
 * reports.") that gives near-random SBERT embeddings — drop it and let
 * the consumer fall back to translatedFullText. Above the ceiling, the
 * model has gone runaway and is echoing the body — also drop and fall back.
 */
const FRAMING_SUMMARY_MIN_CHARS = 200;
const FRAMING_SUMMARY_MAX_CHARS = 4_000;

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

export function parseEnrichmentFromResponse(content: string): Omit<OpenRouterArticleEnrichmentResult, "model" | "error" | "inputTruncated"> | null {
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
      framingSummary?: unknown;
      persons?: unknown;
      organizations?: unknown;
      places?: unknown;
      language?: unknown;
      bodyAppearsTruncated?: unknown;
    };

    // Default to newsworthy when the field is missing — older cached
    // responses (from before this field was added) shouldn't all flip to
    // non-newsworthy. Only treat as not-newsworthy when the model
    // explicitly returns `false`.
    const isNewsworthy =
      typeof parsed.isNewsworthy === "boolean" ? parsed.isNewsworthy : true;

    const rawTranslatedTitle =
      typeof parsed.translatedTitle === "string" ? parsed.translatedTitle.trim() || null : null;
    const rawTranslatedSummary =
      typeof parsed.translatedSummary === "string" ? parsed.translatedSummary.trim() || null : null;
    const rawTranslatedFullText =
      typeof parsed.translatedFullText === "string" ? parsed.translatedFullText.trim() || null : null;
    const rawFramingSummary =
      typeof parsed.framingSummary === "string" ? parsed.framingSummary.trim() || null : null;

    // Validate framingSummary against length bounds. Sub-floor stubs give
    // SBERT near-random embeddings; over-ceiling outputs mean the model
    // ignored the brief and echoed the body. Either way, drop the value
    // and let downstream fall back to translatedFullText.
    const framingSummary =
      rawFramingSummary &&
      rawFramingSummary.length >= FRAMING_SUMMARY_MIN_CHARS &&
      rawFramingSummary.length <= FRAMING_SUMMARY_MAX_CHARS &&
      !looksTruncated(rawFramingSummary)
        ? rawFramingSummary
        : null;

    // Enforce the isNewsworthy=false invariant in the parser regardless of
    // what the model actually returned. A hallucinating model can still
    // emit a framing summary on boilerplate; we don't want that polluting
    // SBERT input or the display surface.
    const newsworthyOnly = <T,>(value: T): T | null => (isNewsworthy ? value : null);

    return {
      keywords: isNewsworthy ? uniqueStrings(parsed.keywords) : [],
      translatedTitle: newsworthyOnly(rawTranslatedTitle),
      translatedSummary: newsworthyOnly(rawTranslatedSummary),
      translatedFullText: newsworthyOnly(rawTranslatedFullText),
      framingSummary: newsworthyOnly(framingSummary),
      persons: uniqueStrings(parsed.persons),
      organizations: uniqueStrings(parsed.organizations),
      places: uniqueStrings(parsed.places),
      language: typeof parsed.language === "string" ? parsed.language.trim() || null : null,
      isNewsworthy,
      notNewsworthyReason:
        typeof parsed.notNewsworthyReason === "string"
          ? parsed.notNewsworthyReason.trim() || null
          : null,
      // null when the field is absent (older cached responses, models that
      // ignore the prompt) — preserves the "we don't know what the model
      // thinks" semantic distinct from "model said false".
      bodyAppearsTruncated:
        typeof parsed.bodyAppearsTruncated === "boolean" ? parsed.bodyAppearsTruncated : null,
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

  // Compute input-truncation status BEFORE the API-key short-circuit so
  // both branches can report it. We always know this — it's a property
  // of our request, not of any model response.
  const originalBodyLength = input.body?.length ?? 0;
  const inputTruncated = originalBodyLength > TRANSLATED_FULL_TEXT_MAX_CHARS;

  if (!env.OPENROUTER_API_KEY) {
    return {
      keywords: [],
      translatedTitle: null,
      translatedSummary: null,
      translatedFullText: null,
      framingSummary: null,
      persons: [],
      organizations: [],
      places: [],
      language: input.language,
      isNewsworthy: true,
      notNewsworthyReason: null,
      inputTruncated,
      bodyAppearsTruncated: null,
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

  // When we sliced the body, tell the model up-front so its summary doesn't
  // claim to cover content it never saw and so it sets bodyAppearsTruncated.
  const truncationNote = inputTruncated
    ? `Note: the Body below is the first ${TRANSLATED_FULL_TEXT_MAX_CHARS} characters of a longer article (original length: ${originalBodyLength} chars). The article continues beyond this excerpt — do not invent content that isn't present.`
    : null;

  const prompt = [
    "Analyze this news article and return strict JSON only.",
    "JSON shape:",
    "{\"isNewsworthy\":true,\"notNewsworthyReason\":\"...\",\"keywords\":[\"...\"],\"translatedTitle\":\"...\",\"translatedSummary\":\"...\",\"translatedFullText\":\"...\",\"framingSummary\":\"...\",\"persons\":[\"...\"],\"organizations\":[\"...\"],\"places\":[\"...\"],\"language\":\"...\",\"bodyAppearsTruncated\":true|false}",
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
    "- keywords must be concise English topical labels of 1 to 3 words",
    "- aim for a balanced mix across these slots when applicable: 1 location/region, 1-2 key people, 1 organization or named event, 1-2 broad topical themes",
    "- prefer reusable, high-value labels that group related stories: \"Ukraine conflict\", \"Trump\", \"UEFA Cup\", \"ceasefire\", \"AI regulation\"",
    "- do NOT combine a person/place with an action into one keyword — split them: use \"Kramatorsk\" + \"air strike\", not \"Kramatorsk air strike\"; use \"Zelenskyy\" + \"ceasefire proposal\", not \"Zelenskyy ceasefire proposal\"",
    "- avoid hyper-specific event compounds tied to a single article — prefer the underlying concept that other articles would also use",
    "- use specific topical concepts, not generic labels",
    "- do not output vague keywords such as: news, article, report, issue, attack, company milestone, analysis, story, update, release, event",
    "- preserve proper names exactly when possible",
    "- translatedTitle and translatedSummary must be close English translations, not rewrites",
    "- translatedSummary should be 1 sentence, faithful, and plain factual prose",
    "- persons, organizations, and places must be distinct arrays",
    "- language must be a lowercase ISO-639-1 code like en, fr, de, es, it, tr, el, zh, ja, ko, ru, ar",
    "- if uncertain, use null for strings and [] for arrays",
    "framingSummary rules (this field is critical — it is embedded for cross-source comparison):",
    "- write 4 to 6 sentences in plain English (~600 to 1000 characters total)",
    "- focus on what makes THIS source's framing distinctive: stance, emphasis, framing choices, quoted figures, geographic angle, attribution patterns",
    "- include concrete distinguishing details: who is described as the actor vs. the subject, which specific events or quotes are highlighted, what the source treats as the lede",
    "- exclude content that any wire-service version of the story would also carry (verbatim Reuters/AP boilerplate, generic background context shared across outlets) — those drag embeddings together",
    "- exclude direct quotes that span multiple sources unless paraphrased",
    "- factual and faithful — do not editorialize, do not invent claims the article didn't make",
    "- if the article is genuinely framing-neutral wire copy, say so concisely (1-2 sentences) — a short summary is better than padding with shared content",
    "- if isNewsworthy=false, set framingSummary=null",
    "Body-truncation rules:",
    "- set bodyAppearsTruncated=true if the Body ends mid-sentence, mid-thought, mid-paragraph, or otherwise looks cut off (no concluding period; ends with a comma, conjunction, or article like 'the' / 'and'; ends mid-quote)",
    "- set bodyAppearsTruncated=true if a 'truncation note' above explicitly tells you the Body was cut",
    "- otherwise set bodyAppearsTruncated=false",
    "- when bodyAppearsTruncated=true, keep translatedSummary factual and avoid claims about how the article concludes (do NOT invent an ending)",
    "Keyword guidance:",
    "- prefer terms like: \"Zoom security\", \"macOS malware\", \"privilege escalation\", \"Lazarus Group\"",
    "- avoid terms like: \"released\", \"new\", \"cyber attack\" unless the text is explicitly about an attack campaign and no more specific label exists",
    "Examples:",
    "Example 1 input title: The 'S' in Zoom, Stands for Security",
    "Example 1 output: {\"isNewsworthy\":true,\"notNewsworthyReason\":null,\"keywords\":[\"Zoom\",\"macOS\",\"privilege escalation\",\"webcam access\",\"cybersecurity\"],\"translatedTitle\":\"The 'S' in Zoom, Stands for Security\",\"translatedSummary\":\"The article describes two local security flaws in Zoom's macOS client, including privilege escalation and covert webcam and microphone access.\",\"translatedFullText\":\"<cleaned body>\",\"framingSummary\":\"The piece treats Zoom's macOS client as a recurring offender, framing the two new flaws as predictable rather than surprising. The author emphasises that both issues stem from the same architectural pattern — Zoom's reliance on auxiliary helper processes — and reads as a critique of Apple's review process for Mac App Store distribution. Quotes from the disclosing researcher dominate; Zoom's response is summarised in one line and characterised as 'minimal'. The framing centres on vendor accountability rather than user mitigation.\",\"persons\":[],\"organizations\":[\"Zoom\"],\"places\":[],\"language\":\"en\",\"bodyAppearsTruncated\":false}",
    "Example 2 (non-newsworthy): Body is 'JTBC Co., Ltd. CEO: Jeon Jin-bae, address: 38 Sangam-san-ro... business registration number: 104-86-33995... All Rights Reserved.'",
    "Example 2 output: {\"isNewsworthy\":false,\"notNewsworthyReason\":\"corporate boilerplate\",\"keywords\":[],\"translatedTitle\":null,\"translatedSummary\":null,\"translatedFullText\":null,\"framingSummary\":null,\"persons\":[],\"organizations\":[\"JTBC\"],\"places\":[],\"language\":\"en\",\"bodyAppearsTruncated\":false}",
    "",
    ...(truncationNote ? [truncationNote] : []),
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
        inputTruncated,
      ),
    {
      shouldCache: (result) => result.error === null,
      onAttemptLog: log,
    },
  );
}

/**
 * Cheap content-level truncation check for models that don't set
 * `finish_reason` correctly. The translated body should end with a
 * terminal punctuation mark (period / question mark / exclamation /
 * closing quote / closing paren). If it ends mid-word or with a comma,
 * conjunction, or article, the model ran out of output budget and we
 * should retry with the next model rather than persist a truncated
 * embedding source.
 */
export function looksTruncated(text: string): boolean {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length < 20) return false; // genuinely too short to judge
  const lastChar = trimmed.at(-1) ?? "";
  // Strong terminal indicators — any length, any context.
  if (/[.!?…”"')\]]/.test(lastChar)) return false;
  // Trailing connector punctuation: comma, semicolon, hyphen. Em/en dashes
  // are intentionally excluded — a sentence ending in "—" is a stylistic
  // pull-quote marker, not a truncation signal.
  if (/[,;:\-]$/.test(trimmed)) return true;
  // Dangling multi-letter function word at end. Single-letter words ("a",
  // "I") are excluded because they false-trip on standalone abbreviations
  // and headlines ending with a capital letter (e.g. "Plan A").
  // Lowercase-only — the model produces normalized prose, and matching
  // case-insensitively flagged legitimate trailing capitals like "USA".
  if (/\b(?:and|or|but|the|an|of|to|in|on|with|for|by|from|that|which|who|whose|whom)$/.test(trimmed)) {
    return true;
  }
  // Mid-word lowercase truncation is weaker — a 30-char snippet ending in a
  // legitimate lowercase noun ("...won the title") shouldn't trip. Require a
  // longer body before treating bare lowercase as truncation evidence.
  if (trimmed.length >= 50 && /[a-z]/.test(lastChar)) return true;
  return false;
}

function isResponseComplete(
  parsed: Omit<OpenRouterArticleEnrichmentResult, "model" | "error" | "inputTruncated">,
  bodyHasContent: boolean,
  inputTruncated: boolean,
): boolean {
  // Non-newsworthy responses are inherently terminal — accept them with
  // null fields. Some smaller free models otherwise refuse to populate
  // translatedFullText for boilerplate, which would loop forever.
  if (!parsed.isNewsworthy) return true;
  // For real articles we now require translatedFullText whenever the body
  // had substantive content (English or not). This guarantees the
  // chrome-stripped English version is always available downstream.
  if (bodyHasContent && !parsed.translatedFullText) return false;
  // Backstop for the protocol-layer finish_reason check: even a parsed,
  // non-empty translatedFullText is unusable if it ends mid-sentence — but
  // only when WE didn't slice the input. If `inputTruncated` is true the
  // body itself ended mid-stream, so a body-shaped truncation in the model
  // output is faithful, not a failure. Retrying every model in the rotation
  // for an article we ourselves cut off wastes the entire free pool.
  if (
    !inputTruncated &&
    parsed.translatedFullText &&
    looksTruncated(parsed.translatedFullText)
  ) {
    return false;
  }
  // Reject responses where the model echoed the source language back into
  // translatedFullText instead of translating it. franc-min on 30+ char input
  // is reliable enough to reject confident non-English without false-rejecting
  // English-with-loanwords. Short bodies are skipped (returns true).
  if (
    parsed.translatedFullText &&
    parsed.translatedFullText.length >= 200 &&
    !isProbablyEnglish(parsed.translatedFullText)
  ) {
    return false;
  }
  return true;
}

/**
 * Single OpenRouter chat-completions call. Returns the parsed enrichment on
 * success, or `{ error, retryable }` on failure. Used by both the free-pool
 * retry loop and the paid-fallback path so the request shape stays in sync.
 */
async function performOpenRouterRequest(params: {
  model: string;
  prompt: string;
  bodyHasContent: boolean;
  inputTruncated: boolean;
  timeoutMs: number;
  contextId?: string;
}): Promise<
  | {
      ok: true;
      parsed: Omit<OpenRouterArticleEnrichmentResult, "model" | "error" | "inputTruncated">;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      retryAfterMs: number | null;
      finishReasonLength: boolean;
    }
> {
  const { model, prompt, bodyHasContent, inputTruncated, timeoutMs, contextId } = params;
  const traceKind = "openrouter-article-enrichment";
  const trace = logLlmRequest({ kind: traceKind, model, contextId, prompt });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
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
        max_tokens: ENRICHMENT_MAX_OUTPUT_TOKENS,
        // Reasoning chain-of-thought is hidden from the consumer (we only
        // read `choices[0].message.content`) but its tokens count against
        // max_tokens and previously caused DeepSeek V4 Flash to hit
        // finish_reason=length before the JSON reply was complete.
        // OpenRouter normalises this flag across providers that support it.
        reasoning: { exclude: true },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const msg = `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`;
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId, startedAt: trace.startedAt,
      ok: false, error: msg,
    });
    return { ok: false, error: msg, retryable: true, retryAfterMs: null, finishReasonLength: false };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const retryable = isRetryableStatus(response.status);
    const msg = `OpenRouter error ${response.status}: ${details.slice(0, 240)}`;
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId, startedAt: trace.startedAt,
      ok: false, httpStatus: response.status, error: msg, content: details,
    });
    return {
      ok: false,
      error: msg,
      retryable,
      retryAfterMs: retryable ? parseRetryAfterMs(response.headers.get("retry-after")) : null,
      finishReasonLength: false,
    };
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const finishReason = payload.choices?.[0]?.finish_reason;
  // Per-call token-usage line. Recognisable prefix so a run can be summed
  // with `grep '\[tokens\]' run.log | awk '{...}'` without reaching into
  // module state. OpenRouter populates `usage` for both free and paid
  // models; missing fields are reported as 0 rather than dropped so the
  // line shape is stable.
  if (payload.usage) {
    const u = payload.usage;
    console.log(
      `[tokens] model=${model} prompt=${u.prompt_tokens ?? 0} completion=${u.completion_tokens ?? 0} total=${u.total_tokens ?? 0}`,
    );
  }
  // finish_reason="length" means the model hit its OWN output cap. When WE
  // sliced the input, body-shaped truncation is expected and we accept the
  // parsed reply rather than burning the rotation. When we didn't slice,
  // it's a genuine output overflow and we retry the next model.
  if (finishReason === "length" && !inputTruncated) {
    const msg = `Model ${model} hit output token cap (finish_reason=length)`;
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId, startedAt: trace.startedAt,
      ok: false, content, finishReason, usage: payload.usage ?? null, error: msg,
    });
    return {
      ok: false,
      error: msg,
      retryable: true,
      retryAfterMs: null,
      finishReasonLength: true,
    };
  }

  const parsed = parseEnrichmentFromResponse(content);
  if (!parsed) {
    const msg = "No parseable article enrichment JSON in model response";
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId, startedAt: trace.startedAt,
      ok: false, content, finishReason, usage: payload.usage ?? null, error: msg,
    });
    return {
      ok: false,
      error: msg,
      retryable: true,
      retryAfterMs: null,
      finishReasonLength: false,
    };
  }
  if (!isResponseComplete(parsed, bodyHasContent, inputTruncated)) {
    let reason = "Model returned incomplete enrichment (missing translatedFullText)";
    if (parsed.translatedFullText && looksTruncated(parsed.translatedFullText)) {
      reason = "Model returned truncated translatedFullText";
    } else if (
      parsed.translatedFullText &&
      parsed.translatedFullText.length >= 200 &&
      !isProbablyEnglish(parsed.translatedFullText)
    ) {
      reason = "Model echoed non-English source into translatedFullText instead of translating";
    }
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId, startedAt: trace.startedAt,
      ok: false, content, finishReason, usage: payload.usage ?? null, error: reason,
    });
    return {
      ok: false,
      error: reason,
      retryable: true,
      retryAfterMs: null,
      finishReasonLength: false,
    };
  }
  logLlmResponse({
    id: trace.id, kind: traceKind, model, contextId, startedAt: trace.startedAt,
    ok: true, content, finishReason, usage: payload.usage ?? null,
  });
  return { ok: true, parsed };
}

async function runArticleEnrichmentRequest(
  input: OpenRouterArticleEnrichmentInput,
  prompt: string,
  models: string[],
  primaryModel: string,
  log: ((message: string) => void) | undefined,
  bodyHasContent: boolean,
  inputTruncated: boolean,
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
      const result = await performOpenRouterRequest({
        model,
        prompt,
        bodyHasContent,
        inputTruncated,
        timeoutMs: openRouterTimeoutMs,
        contextId: input.contextId ?? input.title.slice(0, 80),
      });
      if (result.ok) {
        return { ...result.parsed, inputTruncated, model, error: null };
      }
      lastError = result.error;
      if (result.retryable) {
        sawRetryableError = true;
        if (result.retryAfterMs !== null) {
          maxRetryAfterMs =
            maxRetryAfterMs === null
              ? result.retryAfterMs
              : Math.max(maxRetryAfterMs, result.retryAfterMs);
        }
      }
      log?.(`round ${round + 1}/${maxRounds}: ${model} ${result.error}`);
    }

    if (!sawRetryableError || round >= openRouterBackoffScheduleMs.length) {
      break;
    }

    await sleep(computeBackoffMs(round, maxRetryAfterMs));
  }

  // Free pool exhausted — try the configured paid OpenRouter model once
  // before falling through to OpenAI. This keeps everything on a single
  // OpenRouter account / billing surface when possible.
  const paidModel = env.OPENROUTER_PAID_FALLBACK_MODEL?.trim();
  if (paidModel && env.OPENROUTER_API_KEY) {
    log?.(`openrouter-paid-fallback: -> model ${paidModel}`);
    const result = await performOpenRouterRequest({
      model: paidModel,
      prompt,
      bodyHasContent,
      inputTruncated,
      timeoutMs: openRouterTimeoutMs * 4,
      contextId: input.contextId ?? input.title.slice(0, 80),
    });
    if (result.ok) {
      log?.(`openrouter-paid-fallback: ${paidModel} success`);
      return { ...result.parsed, inputTruncated, model: paidModel, error: null };
    }
    log?.(`openrouter-paid-fallback: ${paidModel} ${result.error}`);
  }

  // OpenRouter exhausted — try OpenAI direct as the very last resort.
  const fallback = await callOpenAIFallback({
    prompt,
    onAttemptLog: log,
    kind: "article-enrichment",
    contextId: input.contextId ?? input.title.slice(0, 80),
  });
  if (fallback) {
    const parsed = parseEnrichmentFromResponse(fallback.content);
    if (parsed && isResponseComplete(parsed, bodyHasContent, inputTruncated)) {
      return {
        ...parsed,
        inputTruncated,
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
    framingSummary: null,
    persons: [],
    organizations: [],
    places: [],
    language: input.language,
    isNewsworthy: true,
    notNewsworthyReason: null,
    inputTruncated,
    bodyAppearsTruncated: null,
    model: primaryModel,
    error: lastError,
  };
}
