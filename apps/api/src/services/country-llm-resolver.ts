import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveCountryFromDomain } from "./country-from-domain.js";
import { withLlmCache } from "./llm-cache.js";
import { orderOpenRouterModels, resolveOpenRouterModels } from "./openrouter-models.js";
import { logLlmRequest, logLlmResponse } from "../lib/llm-trace.js";

const COUNTRY_TRACE_KIND = "country-llm-resolver";

const OPENROUTER_TIMEOUT_MS = 12_000;
const inFlight = new Map<string, Promise<string | null>>();

function buildPrompt(sourceName: string, domain: string): string {
  return [
    "You are a media expert.",
    `Given the news source name "${sourceName}" with domain "${domain}",`,
    "what country does it editorially represent?",
    "Reply with ONLY the country name in English (for example: 'United States', 'United Kingdom').",
    "If genuinely unknown or ambiguous, reply 'Unknown'.",
  ].join(" ");
}

async function callOpenRouterUncached(prompt: string, seed: string): Promise<string | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  const models = orderOpenRouterModels(resolveOpenRouterModels(env.OPENROUTER_MODEL), seed);

  for (const model of models) {
    const trace = logLlmRequest({ kind: COUNTRY_TRACE_KIND, model, contextId: seed, prompt });
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
          temperature: 0,
          max_tokens: 12,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const details = await res.text().catch(() => "");
        logLlmResponse({
          id: trace.id, kind: COUNTRY_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
          ok: false, httpStatus: res.status, content: details, error: `http ${res.status}`,
        });
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const finishReason = data.choices?.[0]?.finish_reason;
      const raw = content.trim().replace(/[."'`]/g, "");
      if (!raw) {
        logLlmResponse({
          id: trace.id, kind: COUNTRY_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
          ok: false, content, finishReason, usage: data.usage ?? null, error: "empty content",
        });
        continue;
      }
      if (/^unknown$/i.test(raw)) {
        logLlmResponse({
          id: trace.id, kind: COUNTRY_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
          ok: true, content, finishReason, usage: data.usage ?? null,
        });
        return null;
      }
      // Reject anything that looks like an entire sentence — country names are short.
      if (raw.length > 40 || raw.split(" ").length > 5) {
        logLlmResponse({
          id: trace.id, kind: COUNTRY_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
          ok: false, content, finishReason, usage: data.usage ?? null, error: "rejected (too long)",
        });
        continue;
      }
      logLlmResponse({
        id: trace.id, kind: COUNTRY_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
        ok: true, content, finishReason, usage: data.usage ?? null,
      });
      return raw;
    } catch (error) {
      logLlmResponse({
        id: trace.id, kind: COUNTRY_TRACE_KIND, model, contextId: seed, startedAt: trace.startedAt,
        ok: false, error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Three-tier country resolution with caching against `SourceProfile.country`.
 *
 * Tier 1+2 are synchronous (`resolveCountryFromDomain`); tier 3 calls OpenRouter
 * for `.com` and other ambiguous domains where TLD/source-name don't help.
 * Resolved values are persisted on the source profile so future lookups are free.
 */
export async function resolveCountryWithLlm(
  domain: string | null | undefined,
  sourceName: string | null | undefined,
): Promise<string | null> {
  const local = resolveCountryFromDomain(domain, sourceName);
  if (local) return local;
  if (!domain) return null;

  const profile = await prisma.sourceProfile.findUnique({
    where: { domain },
    select: { country: true, countryOfOrigin: true },
  });
  const cached = profile?.countryOfOrigin ?? profile?.country ?? null;
  if (cached) return cached;

  const cacheKey = `${domain}|${sourceName ?? ""}`;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey)!;

  const prompt = buildPrompt(sourceName ?? domain, domain);
  const promise = (async () => {
    const country = await withLlmCache<string | null>(
      { kind: "country-llm-resolver", prompt },
      () => callOpenRouterUncached(prompt, cacheKey),
      { shouldCache: (value) => value !== null },
    );
    if (country) {
      await prisma.sourceProfile.upsert({
        where: { domain },
        update: { country },
        create: { domain, sourceName: sourceName ?? domain, country },
      });
    }
    return country;
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}
