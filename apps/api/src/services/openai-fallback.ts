import { env } from "../config/env.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_TIMEOUT_MS = 30_000;

export interface OpenAIFallbackOptions {
  prompt: string;
  onAttemptLog?: (message: string) => void;
}

export interface OpenAIFallbackResult {
  content: string;
  model: string;
}

/**
 * Last-resort fallback for when every free OpenRouter model has failed.
 * Calls OpenAI's chat completions API directly with `OPENAI_FALLBACK_MODEL`
 * (default `gpt-5.4-nano`). Returns null if `OPENAI_API_KEY` is missing or the
 * call fails.
 */
export async function callOpenAIFallback(
  options: OpenAIFallbackOptions,
): Promise<OpenAIFallbackResult | null> {
  if (!env.OPENAI_API_KEY) {
    options.onAttemptLog?.("openai-fallback: skipped (OPENAI_API_KEY missing)");
    return null;
  }

  const model = env.OPENAI_FALLBACK_MODEL;
  options.onAttemptLog?.(`openai-fallback: -> model ${model}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: options.prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await response.text();
      options.onAttemptLog?.(
        `openai-fallback: ${model} http ${response.status}: ${details.slice(0, 200)}`,
      );
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    if (!content) {
      options.onAttemptLog?.(`openai-fallback: ${model} empty response`);
      return null;
    }

    options.onAttemptLog?.(`openai-fallback: ${model} success`);
    return { content, model };
  } catch (error) {
    options.onAttemptLog?.(
      `openai-fallback: ${model} network error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
