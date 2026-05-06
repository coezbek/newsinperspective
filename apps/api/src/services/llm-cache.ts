import { DiskCache } from "./disk-cache.js";

/**
 * Disk-backed cache for LLM responses keyed by prompt hash.
 *
 * Goal: avoid re-running an identical LLM call. If the prompt (plus an
 * optional `kind` namespace) hasn't changed, return the previously parsed
 * result without hitting OpenRouter or OpenAI.
 *
 * Disable in a single run with `LLM_CACHE_DISABLE=true`.
 * Override the location with `LLM_CACHE_DIR=/some/path`.
 * To force a fresh fetch, delete the directory (or specific `.json` files).
 */
const llmCache = new DiskCache<unknown>({
  namespace: "llm",
  // Prompt → completion is deterministic at temperature=0; cache forever.
  ttlMs: null,
  disableEnvVar: "LLM_CACHE_DISABLE",
  dirEnvVar: "LLM_CACHE_DIR",
});

export interface LlmCacheKeyParts {
  /** Logical caller, e.g. "openrouter-keywords" — namespaces the cache. */
  kind: string;
  /** The user-message prompt sent to the model. */
  prompt: string;
  /** Anything else that should invalidate the cache when changed (rarely needed). */
  extra?: Record<string, unknown>;
}

export interface WithLlmCacheOptions<T> {
  /**
   * Predicate that decides whether the freshly computed result should be
   * persisted. Defaults to caching everything. Use it to skip caching errors.
   */
  shouldCache?: (result: T) => boolean;
  /** Optional logger that receives `cache hit ...` / `cache miss ...` lines. */
  onAttemptLog?: (message: string) => void;
}

export async function withLlmCache<T>(
  parts: LlmCacheKeyParts,
  compute: () => Promise<T>,
  options: WithLlmCacheOptions<T> = {},
): Promise<T> {
  const value = await (llmCache as DiskCache<T>).with(
    {
      kind: parts.kind,
      prompt: parts.prompt,
      extra: parts.extra ?? null,
    },
    compute,
    options,
  );
  return value;
}
