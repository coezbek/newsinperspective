// Default free-model rotation, refreshed against
// https://openrouter.ai/collections/free-models. Ordered roughly by reliability
// for our JSON-output workload: structured-output / function-calling models
// first, then strong general models, then long-context fallbacks.
const defaultFreeModels = [
  // Best JSON / structured-output support
  "openai/gpt-oss-120b:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "openai/gpt-oss-20b:free",
  // Strong general models with tool use / reasoning
  "tencent/hy3-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-2.6-1t:free",
  "z-ai/glm-4.5-air:free",
  "minimax/minimax-m2.5:free",
  // Long context fallbacks and smaller models
  "openrouter/owl-alpha",
  // nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free removed 2026-05-09:
  // observed returning unparseable JSON on every article in the 2026-05-08
  // 20×20 run, burning a full prompt round before failing over.
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "poolside/laguna-m.1:free",
  "poolside/laguna-xs.2:free",
];

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function parseModelOffset(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function hashSeed(seed: string): number {
  return [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export function getDefaultOpenRouterModels(): string[] {
  return [...defaultFreeModels];
}

export function resolveOpenRouterModels(modelConfig: string | undefined): string[] {
  const configured = modelConfig
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return configured && configured.length > 0 ? configured : getDefaultOpenRouterModels();
}

export function orderOpenRouterModels(
  models: string[],
  seed: string,
  options?: {
    round?: number;
    offset?: number;
  },
): string[] {
  if (models.length <= 1) return [...models];
  const baseOffset = parseModelOffset(process.env.OPENROUTER_MODEL_OFFSET);
  const roundOffset = options?.round ?? 0;
  const explicitOffset = options?.offset ?? 0;
  const offset = positiveModulo(hashSeed(seed) + baseOffset + explicitOffset + roundOffset, models.length);
  return [...models.slice(offset), ...models.slice(0, offset)];
}
