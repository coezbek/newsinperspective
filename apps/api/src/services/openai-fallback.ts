import { env } from "../config/env.js";
import { logLlmRequest, logLlmResponse } from "../lib/llm-trace.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_TIMEOUT_MS = 30_000;

export interface OpenAIFallbackOptions {
  prompt: string;
  onAttemptLog?: (message: string) => void;
  /** Caller name for the LLM trace log (e.g. "article-enrichment"). */
  kind?: string;
  /** Optional correlation id for the LLM trace log. */
  contextId?: string;
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
  const traceKind = `openai-fallback:${options.kind ?? "unknown"}`;
  const trace = logLlmRequest({
    kind: traceKind,
    model,
    contextId: options.contextId,
    prompt: options.prompt,
  });
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
      logLlmResponse({
        id: trace.id, kind: traceKind, model, contextId: options.contextId, startedAt: trace.startedAt,
        ok: false, httpStatus: response.status, content: details,
        error: `http ${response.status}`,
      });
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (!content) {
      options.onAttemptLog?.(`openai-fallback: ${model} empty response`);
      logLlmResponse({
        id: trace.id, kind: traceKind, model, contextId: options.contextId, startedAt: trace.startedAt,
        ok: false, content: "", finishReason, usage: payload.usage ?? null, error: "empty response",
      });
      return null;
    }

    options.onAttemptLog?.(`openai-fallback: ${model} success`);
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId: options.contextId, startedAt: trace.startedAt,
      ok: true, content, finishReason, usage: payload.usage ?? null,
    });
    return { content, model };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    options.onAttemptLog?.(`openai-fallback: ${model} network error: ${msg}`);
    logLlmResponse({
      id: trace.id, kind: traceKind, model, contextId: options.contextId, startedAt: trace.startedAt,
      ok: false, error: `network: ${msg}`,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
