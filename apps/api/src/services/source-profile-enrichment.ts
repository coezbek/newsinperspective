import { env } from "../config/env.js";

export interface SourceProfileEnrichmentResult {
  description: string | null;
  country: string | null;
  countryOfOrigin: string | null;
  headquarters: string | null;
  mediaOwner: string | null;
  ownershipType: string | null;
  employeeCount: number | null;
  wikipediaUrl: string | null;
  associatedEntities: string[];
  model: string | null;
  error: string | null;
}

const defaultFreeModels = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "qwen/qwen3-coder:free",
];

function uniqueStrings(values: unknown, limit = 8): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, limit);
}

function parseSourceProfileFromResponse(content: string): Omit<SourceProfileEnrichmentResult, "model" | "error"> | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      description?: unknown;
      country?: unknown;
      countryOfOrigin?: unknown;
      headquarters?: unknown;
      mediaOwner?: unknown;
      ownershipType?: unknown;
      employeeCount?: unknown;
      wikipediaUrl?: unknown;
      associatedEntities?: unknown;
    };

    return {
      description: typeof parsed.description === "string" ? parsed.description.trim() || null : null,
      country: typeof parsed.country === "string" ? parsed.country.trim() || null : null,
      countryOfOrigin: typeof parsed.countryOfOrigin === "string" ? parsed.countryOfOrigin.trim() || null : null,
      headquarters: typeof parsed.headquarters === "string" ? parsed.headquarters.trim() || null : null,
      mediaOwner: typeof parsed.mediaOwner === "string" ? parsed.mediaOwner.trim() || null : null,
      ownershipType: typeof parsed.ownershipType === "string" ? parsed.ownershipType.trim() || null : null,
      employeeCount:
        typeof parsed.employeeCount === "number" && Number.isFinite(parsed.employeeCount)
          ? Math.max(0, Math.round(parsed.employeeCount))
          : null,
      wikipediaUrl: typeof parsed.wikipediaUrl === "string" ? parsed.wikipediaUrl.trim() || null : null,
      associatedEntities: uniqueStrings(parsed.associatedEntities),
    };
  } catch {
    return null;
  }
}

export async function enrichSourceProfileWithOpenRouter(input: {
  domain: string;
  sourceName: string;
}): Promise<SourceProfileEnrichmentResult> {
  const model = env.OPENROUTER_MODEL?.split(",").map((value) => value.trim()).filter(Boolean)[0] ?? defaultFreeModels[0]!;

  if (!env.OPENROUTER_API_KEY) {
    return {
      description: null,
      country: null,
      countryOfOrigin: null,
      headquarters: null,
      mediaOwner: null,
      ownershipType: null,
      employeeCount: null,
      wikipediaUrl: null,
      associatedEntities: [],
      model,
      error: "OPENROUTER_API_KEY missing",
    };
  }

  const prompt = [
    "Return strict JSON only for this news organization profile.",
    "If a field is unknown or uncertain, use null.",
    "JSON shape:",
    "{\"description\":\"...\",\"country\":\"...\",\"countryOfOrigin\":\"...\",\"headquarters\":\"...\",\"mediaOwner\":\"...\",\"ownershipType\":\"...\",\"employeeCount\":123,\"wikipediaUrl\":\"https://...\",\"associatedEntities\":[\"...\"]}",
    "associatedEntities should list notable parent companies, affiliated groups, governments, or controlling entities when relevant.",
    `Domain: ${input.domain}`,
    `Source name: ${input.sourceName}`,
  ].join("\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
    });

    if (!response.ok) {
      const details = await response.text();
      return {
        description: null,
        country: null,
        countryOfOrigin: null,
        headquarters: null,
        mediaOwner: null,
        ownershipType: null,
        employeeCount: null,
        wikipediaUrl: null,
        associatedEntities: [],
        model,
        error: `OpenRouter error ${response.status}: ${details.slice(0, 240)}`,
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = parseSourceProfileFromResponse(content);
    if (!parsed) {
      return {
        description: null,
        country: null,
        countryOfOrigin: null,
        headquarters: null,
        mediaOwner: null,
        ownershipType: null,
        employeeCount: null,
        wikipediaUrl: null,
        associatedEntities: [],
        model,
        error: "No parseable source profile JSON in model response",
      };
    }

    return {
      ...parsed,
      model,
      error: null,
    };
  } catch (error) {
    return {
      description: null,
      country: null,
      countryOfOrigin: null,
      headquarters: null,
      mediaOwner: null,
      ownershipType: null,
      employeeCount: null,
      wikipediaUrl: null,
      associatedEntities: [],
      model,
      error: `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
