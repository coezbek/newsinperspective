import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveCountryFromDomain } from "./country-from-domain.js";
import { orderOpenRouterModels, resolveOpenRouterModels } from "./openrouter-models.js";

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

async function callOpenRouter(prompt: string, seed: string): Promise<string | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  const models = orderOpenRouterModels(resolveOpenRouterModels(env.OPENROUTER_MODEL), seed);

  for (const model of models) {
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
      if (!res.ok) continue;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content?.trim().replace(/[."'`]/g, "");
      if (!raw) continue;
      if (/^unknown$/i.test(raw)) return null;
      // Reject anything that looks like an entire sentence — country names are short.
      if (raw.length > 40 || raw.split(" ").length > 5) continue;
      return raw;
    } catch {
      // try next model
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

  const promise = (async () => {
    const country = await callOpenRouter(buildPrompt(sourceName ?? domain, domain), cacheKey);
    if (country) {
      await prisma.sourceProfile
        .update({ where: { domain }, data: { country } })
        .catch(() => {
          // Profile may not exist yet (some Article domains have no SourceProfile row).
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
