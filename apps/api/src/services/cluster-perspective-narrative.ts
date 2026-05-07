import { ScopeType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { withLlmCache } from "./llm-cache.js";
import { orderOpenRouterModels, resolveOpenRouterModels } from "./openrouter-models.js";
import type { SidecarAnalyzeResponse } from "./cluster-perspective.js";
import { logLlmRequest, logLlmResponse } from "../lib/llm-trace.js";

const NARRATIVE_TRACE_KIND = "cluster-perspective-narrative";

type CallResult = { content: string; model: string } | { error: string };

const OPENROUTER_TIMEOUT_MS = 30_000;
const NARRATIVE_FEATURE_KIND = "perspective_v1";

export interface ClusterNarrative {
  framingAngles: string | null;
  countryNarrative: string | null;
  model: string | null;
  generatedAt: string;
  error: string | null;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function buildFramingPrompt(title: string, p: SidecarAnalyzeResponse): string {
  const lines = p.distinctive_words
    .filter((d) => d.words.length > 0)
    .map((d) => `- Source: ${d.source_name} | Distinctive words: ${d.words.join(", ")}`);
  if (lines.length === 0) return "";

  return [
    "You are an expert Media Analyst and Political Scientist.",
    "",
    `Story: "${title}"`,
    "",
    "Below are the most distinctive vocabulary terms each source uses, computed via TF-IDF",
    "across all sources covering this story (event-describing words have already been removed):",
    "",
    ...lines,
    "",
    "Identify the 3–4 most analytically interesting editorial angles. For each angle:",
    "- Name the angle and the source(s) taking it",
    "- Cite 2–3 specific words as evidence",
    "- Explain in 1–2 sentences what this reveals about editorial position",
    "Focus on political/geopolitical framing, not stylistic differences. Be precise, not speculative.",
    "",
    'Format each angle as: **The [Theme] Angle ([Source]):** Words: "w1", "w2". [analysis]',
    "",
    "Output only the formatted angles. No preamble, no commentary outside the bullets.",
  ].join("\n");
}

function buildCountryNarrativePrompt(title: string, p: SidecarAnalyzeResponse): string {
  if (p.country_sentiment.length < 2) return "";

  const rows = p.country_sentiment
    .map((c) => {
      const kw = c.top_keywords && c.top_keywords.length > 0 ? c.top_keywords.join(", ") : "—";
      return `${c.country.padEnd(20)} n=${c.n_articles}  avg_sentiment=${c.avg_sentiment.toFixed(3)} (${c.sentiment_label})  framing_keywords=${kw}`;
    })
    .join("\n");

  return [
    "You are a Political Scientist and International Media Analyst.",
    "",
    `Story: "${title}"`,
    "",
    "Below is country-aggregated coverage data — average sentiment score (−1 negative, 0 neutral,",
    "+1 positive) and the most frequent framing keywords used by each country's media.",
    "Sentiment scores cluster near 0 because the model was trained on social media; treat them",
    "as directional, not absolute. The framing keywords carry most of the signal.",
    "",
    rows,
    "",
    "Identify 3 distinct national narrative positions. For each:",
    "- Cite the country/group, the sentiment score, and 2–3 specific framing keywords as evidence",
    "- Explain what geopolitical, cultural, or historical context drives the position",
    "- Note any surprising alignments or divergences",
    "Each point: 2–3 sentences. Format as a numbered list.",
    "",
    "Output only the numbered list. No preamble, no commentary outside the items.",
  ].join("\n");
}

/**
 * Some reasoning-style models (Nemotron, DeepSeek-R1, Qwen3 reasoning variants…)
 * emit their chain of thought in tags like `<think>…</think>` before the
 * final answer. Strip those, plus any orphan opening/closing tags that come
 * through truncated, before persisting or rendering.
 */
function stripModelReasoning(raw: string): string {
  if (!raw) return "";
  let out = raw;
  // Paired blocks: <think>…</think>, <thinking>…</thinking>, <reasoning>…</reasoning>
  out = out.replace(/<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  // Orphan closing tags (the prefix may have been cut off by max_tokens or the model misformatted)
  out = out.replace(/<\s*\/\s*(think|thinking|reasoning)\s*>/gi, "");
  // Orphan opening tags + everything that follows up to a clear bullet / heading start.
  out = out.replace(/<\s*(think|thinking|reasoning)\s*>[\s\S]*?(?=\n\s*(?:\*\*|\d+\.\s|##|\*|-))/gi, "");
  // Also clean the bracket-style some models use.
  out = out.replace(/\[\s*\/?\s*(REASONING|THINKING)\s*\][\s\S]*?\[\s*\/\s*\1\s*\]/gi, "");
  return out.trim();
}

async function callOpenRouter(prompt: string, seed: string, kind: string): Promise<CallResult> {
  return withLlmCache<CallResult>(
    { kind, prompt },
    () => callOpenRouterUncached(prompt, seed),
    { shouldCache: (value) => "content" in value },
  );
}

async function callOpenRouterUncached(prompt: string, seed: string): Promise<CallResult> {
  if (!env.OPENROUTER_API_KEY) {
    return { error: "OPENROUTER_API_KEY not configured" };
  }
  const models = orderOpenRouterModels(resolveOpenRouterModels(env.OPENROUTER_MODEL), seed);

  let lastError = "OpenRouter request failed";
  for (const model of models) {
    const trace = logLlmRequest({ kind: NARRATIVE_TRACE_KIND, model, contextId: seed, prompt });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          // Ask OpenRouter to strip reasoning tokens server-side. Reasoning-style
          // models (Nemotron, DeepSeek-R1, Qwen3 reasoning…) otherwise emit
          // `<think>…</think>` blocks inline in `content`. `exclude: true` lets
          // them think but withholds the trace from the response. Models that
          // don't support reasoning ignore the field. See:
          // https://openrouter.ai/docs/use-cases/reasoning-tokens
          reasoning: { exclude: true },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const details = await res.text().catch(() => "");
        lastError = `OpenRouter ${model}: HTTP ${res.status}`;
        logLlmResponse({
          id: trace.id, kind: NARRATIVE_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
          ok: false, httpStatus: res.status, content: details, error: lastError,
        });
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const rawContent = data.choices?.[0]?.message?.content ?? "";
      const finishReason = data.choices?.[0]?.finish_reason;
      const content = stripModelReasoning(rawContent);
      if (content.length > 0) {
        logLlmResponse({
          id: trace.id, kind: NARRATIVE_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
          ok: true, content: rawContent, finishReason, usage: data.usage ?? null,
        });
        return { content, model };
      }
      lastError = `OpenRouter ${model}: empty response`;
      logLlmResponse({
        id: trace.id, kind: NARRATIVE_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
        ok: false, content: rawContent, finishReason, usage: data.usage ?? null, error: lastError,
      });
    } catch (err) {
      lastError = `OpenRouter ${model}: ${err instanceof Error ? err.message : String(err)}`;
      logLlmResponse({
        id: trace.id, kind: NARRATIVE_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
        ok: false, error: lastError,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: lastError };
}

export async function generateClusterNarrative(
  clusterId: string,
  title: string,
  perspective: SidecarAnalyzeResponse,
): Promise<ClusterNarrative> {
  const framingPrompt = buildFramingPrompt(title, perspective);
  const countryPrompt = buildCountryNarrativePrompt(title, perspective);

  const seed = `${clusterId}:${perspective.n_sources}:${perspective.n_countries}`;

  const [framing, country] = await Promise.all([
    framingPrompt ? callOpenRouter(framingPrompt, `framing:${seed}`, "perspective-narrative-framing") : Promise.resolve(null),
    countryPrompt ? callOpenRouter(countryPrompt, `country:${seed}`, "perspective-narrative-country") : Promise.resolve(null),
  ]);

  let model: string | null = null;
  let error: string | null = null;
  let framingAngles: string | null = null;
  let countryNarrative: string | null = null;

  if (framing) {
    if ("content" in framing) {
      framingAngles = framing.content;
      model = framing.model;
    } else {
      error = framing.error;
    }
  }
  if (country) {
    if ("content" in country) {
      countryNarrative = country.content;
      model = country.model;
    } else if (!error) {
      error = country.error;
    }
  }

  const narrative: ClusterNarrative = {
    framingAngles,
    countryNarrative,
    model,
    generatedAt: new Date().toISOString(),
    error,
  };

  await persistNarrative(clusterId, narrative);
  return narrative;
}

async function persistNarrative(clusterId: string, narrative: ClusterNarrative): Promise<void> {
  const existing = await prisma.nlpFeature.findFirst({
    where: {
      clusterId,
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: NARRATIVE_FEATURE_KIND },
    },
    select: { id: true, featureSet: true },
  });
  if (!existing) return; // narrative is only attached on top of an existing perspective row

  const current = (existing.featureSet as Record<string, unknown>) ?? {};
  const merged = toInputJson({ ...current, narrative });
  await prisma.nlpFeature.update({ where: { id: existing.id }, data: { featureSet: merged } });
}

export async function getStoredNarrative(clusterId: string): Promise<ClusterNarrative | null> {
  const row = await prisma.nlpFeature.findFirst({
    where: {
      clusterId,
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: NARRATIVE_FEATURE_KIND },
    },
    select: { featureSet: true },
  });
  if (!row) return null;
  const f = row.featureSet as { narrative?: ClusterNarrative };
  return f.narrative ?? null;
}
