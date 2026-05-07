/**
 * Direct LLM translation of StoryCluster.title for clusters whose title is
 * non-English and whose articles offer no translatable fallback.
 *
 * The free pass (apps/api/src/scripts/cluster-translate-titles.ts) only
 * helps clusters that already contain an English-language member article.
 * For clusters where every member article is foreign (Croatian, Macedonian,
 * Romanian, etc.) the only path is to translate the cluster.title string
 * itself — short input (~10 tokens), so even with the free-tier OpenRouter
 * pool the cost is effectively zero.
 *
 * Defaults:
 *   - Selects clusters with translatedTitle IS NULL and a non-ASCII title
 *     (the proxy for "non-English"). Pass --all to consider every NULL row.
 *   - Dry-run unless --apply is passed. Logs every proposed translation
 *     so you can spot bad ones before flipping --apply.
 *   - --limit caps the number of clusters processed.
 *
 * Usage:
 *   pnpm --filter @news/api cluster:translate-titles-llm --limit=5
 *   pnpm --filter @news/api cluster:translate-titles-llm --apply --limit=20
 *   pnpm --filter @news/api cluster:translate-titles-llm --apply
 */
import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import {
  orderOpenRouterModels,
  resolveOpenRouterModels,
} from "../services/openrouter-models.js";

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const a = process.argv.find((v) => v.startsWith(prefix));
  return a ? a.slice(prefix.length) : undefined;
}

const TIMEOUT_MS = 8_000;
const BACKOFF_MS = [3_000, 8_000, 30_000];
const MAX_BACKOFF_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric * 1000);
  const ts = Date.parse(header);
  if (Number.isNaN(ts)) return null;
  const delta = ts - Date.now();
  return delta > 0 ? delta : 0;
}

function computeBackoffMs(round: number, retryAfterMs: number | null): number {
  const scheduled = BACKOFF_MS[round] ?? BACKOFF_MS.at(-1) ?? 5_000;
  const base = retryAfterMs !== null ? Math.max(scheduled, retryAfterMs) : scheduled;
  const jitter = Math.floor(Math.random() * 1_000);
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

/**
 * Strip the most common ways free-tier models wrap a one-line answer:
 *   - leading/trailing whitespace and quote marks
 *   - "Here is the translation: ..." / "Translation: ..." prefixes
 *   - markdown bold/italic
 *   - trailing source-attribution like "(translated from Croatian)"
 *
 * Returns null if the cleaned output looks unusable (empty, identical to
 * input, suspiciously long compared to the original, or still contains
 * non-Latin script — meaning the model returned the original instead of
 * a translation).
 */
export function extractTranslation(raw: string, original: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // Strip a leading line that looks like a label.
  s = s.replace(/^\s*(?:translation|english|translated|in english)\s*[:\-–—]\s*/i, "");
  // Strip enclosing quotes (straight or curly) once.
  s = s.replace(/^["“'‘`](.*)["”'’`]$/s, "$1").trim();
  // Strip leading markdown bold/italic.
  s = s.replace(/^[*_]+|[*_]+$/g, "").trim();
  // Drop a trailing parenthetical attribution.
  s = s.replace(/\s*\((?:translated|from)[^)]*\)\s*$/i, "").trim();
  // Free-tier models sometimes return multiple lines with explanations; take only the first non-empty.
  const firstLine = s.split(/\n+/).find((l) => l.trim().length > 0)?.trim();
  if (!firstLine) return null;
  s = firstLine;

  if (s.length < 5) return null;
  // Headlines run ~30-150 chars; allow up to 3× original to absorb expansion
  // (Cyrillic/Korean compress to short strings; English versions can be 2× longer).
  if (s.length > Math.max(200, original.length * 3)) return null;
  if (s.trim() === original.trim()) return null;

  // Reject outputs that don't start with a letter or digit. Free-tier models
  // sometimes return fragments like "'s Fall to European mixing" when their
  // translation truncates to a continuation rather than a full sentence.
  if (!/^[\p{L}\p{N}]/u.test(s)) return null;

  // Reject outputs that are dramatically shorter than the original. A real
  // English translation of a non-English headline is roughly the same length
  // (sometimes shorter, but rarely <50%). Outputs missing the subject look
  // like the "European mixing" case above.
  if (original.length > 30 && s.length < original.length * 0.5) return null;

  // Reject all-caps output (model glitch indicator).
  if (s.length >= 8 && s === s.toUpperCase()) return null;

  // Reject obvious refusals/non-translations from the model.
  if (/\b(?:i\s+(?:can(?:not|'t)|am unable|cannot|won't)|no translation|sorry,|as an ai|i'm sorry)\b/i.test(s)) return null;

  // Output should look like English: predominantly ASCII letters. We allow
  // diacritics on borrowed names (Kévin, São Paulo) but reject if more than
  // 30% of characters are non-ASCII.
  let nonAscii = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 127) nonAscii += 1;
  if (s.length > 0 && nonAscii / s.length > 0.3) return null;

  // Structural sanity: if the original has no mid-word uppercase transitions
  // (no [a-z][A-Z] pattern), the translation shouldn't introduce them either.
  // This catches the free-tier "beatAtlético" / "EuropeanMixing" word-fusion
  // bug while leaving alone legit camelCase brands (iPhone, eBay, PayPal)
  // — those would also be present in the original.
  const camelInOriginal = /[a-z][A-Z]/.test(original);
  if (!camelInOriginal && /[a-z][A-Z]/.test(s)) return null;

  return s;
}

interface TranslateResult {
  translation: string | null;
  model: string;
  error: string | null;
}

async function translateOnce(
  title: string,
  model: string,
  log?: (m: string) => void,
): Promise<{ ok: boolean; status: number | null; content: string | null; retryAfterMs: number | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
        // Hard cap output length — translated headlines are short.
        max_tokens: 80,
        messages: [
          {
            role: "system",
            content:
              "You translate news headlines into English. Output ONLY the translated headline as a single line. No quotes, no preamble, no commentary. Preserve proper names exactly.",
          },
          { role: "user", content: title },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        content: null,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        error: `http ${response.status}`,
      };
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content ?? "";
    return { ok: true, status: response.status, content, retryAfterMs: null, error: null };
  } catch (err) {
    log?.(`network error on ${model}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: null, content: null, retryAfterMs: null, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function translateClusterTitle(
  title: string,
  log: ((m: string) => void) | undefined,
  freeOnly: boolean,
): Promise<TranslateResult> {
  const all = resolveOpenRouterModels(env.OPENROUTER_MODEL);
  // Restrict to ":free"-suffixed models when the caller asked. Bulk runs
  // across the 376 unresolved clusters could otherwise hit paid models in
  // the rotation; with the suffix filter the operator can safely turn
  // --apply on overnight.
  const models = freeOnly ? all.filter((m) => m.endsWith(":free")) : all;
  const primary = models[0] ?? "(none)";
  if (models.length === 0) {
    return {
      translation: null,
      model: "(none)",
      error: freeOnly
        ? "no :free-suffixed models in OPENROUTER_MODEL"
        : "OPENROUTER_MODEL is empty",
    };
  }
  if (!env.OPENROUTER_API_KEY) {
    return { translation: null, model: primary, error: "OPENROUTER_API_KEY missing" };
  }

  let lastError = "OpenRouter request failed";
  const maxRounds = BACKOFF_MS.length + 1;
  for (let round = 0; round < maxRounds; round += 1) {
    const ordered = orderOpenRouterModels(models, title, { round });
    let sawRetryable = false;
    let maxRetryAfter: number | null = null;
    for (const model of ordered) {
      const r = await translateOnce(title, model, log);
      if (r.ok && r.content !== null) {
        const t = extractTranslation(r.content, title);
        if (t) {
          return { translation: t, model, error: null };
        }
        log?.(`${model}: unparseable response: ${r.content.slice(0, 80)}`);
        sawRetryable = true; // try next model
        continue;
      }
      lastError = r.error ?? lastError;
      if (r.status !== null && isRetryableStatus(r.status)) {
        sawRetryable = true;
        if (r.retryAfterMs !== null) {
          maxRetryAfter = maxRetryAfter === null ? r.retryAfterMs : Math.max(maxRetryAfter, r.retryAfterMs);
        }
      } else if (r.status === null) {
        sawRetryable = true; // network errors are retryable
      }
    }
    if (!sawRetryable || round >= BACKOFF_MS.length) break;
    const backoff = computeBackoffMs(round, maxRetryAfter);
    log?.(`round ${round + 1}: backing off ${Math.ceil(backoff / 1000)}s`);
    await sleep(backoff);
  }
  return { translation: null, model: primary, error: lastError };
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const all = process.argv.includes("--all");
  const limitRaw = parseFlag("limit");
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : undefined;
  const verbose = process.argv.includes("--verbose");
  const id = parseFlag("id");
  const freeOnly = process.argv.includes("--free-only");

  console.log("\n=== CLUSTER TITLE LLM TRANSLATION ===");
  console.log(`Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "WRITE"}`);
  console.log(`Selection: ${all ? "all NULL clusters" : "NULL clusters with non-ASCII titles"}`);
  console.log(`Models: ${freeOnly ? "free-only (--free-only)" : "all configured"}`);
  console.log(`Limit: ${limit ?? "(all)"}`);
  console.log("-".repeat(60));

  // Pull candidates. Prisma has no easy "title contains non-ASCII" predicate
  // in a portable way, so we filter in Node. Reads are cheap (just title +
  // id), so taking 5000 is fine for a backlog of <1000.
  let candidates: Array<{ id: string; title: string; storyDate: Date }> = [];
  if (id) {
    const single = await prisma.storyCluster.findUnique({
      where: { id },
      select: { id: true, title: true, storyDate: true, translatedTitle: true },
    });
    if (!single) {
      console.error(`No cluster with id=${id}`);
      await prisma.$disconnect();
      process.exitCode = 1;
      return;
    }
    if (single.translatedTitle) {
      console.warn(
        `Cluster ${id} already has translatedTitle: ${single.translatedTitle}; will overwrite if --apply.`,
      );
    }
    candidates = [{ id: single.id, title: single.title, storyDate: single.storyDate }];
  } else {
    const all_candidates = await prisma.storyCluster.findMany({
      where: { translatedTitle: null },
      select: { id: true, title: true, storyDate: true },
      orderBy: { storyDate: "desc" },
      take: 5000,
    });
    const filtered = all
      ? all_candidates
      : all_candidates.filter((c) => !/^[\x00-\x7F]+$/.test(c.title));
    candidates = limit ? filtered.slice(0, limit) : filtered;
  }

  console.log(`Candidates: ${candidates.length}`);
  if (candidates.length === 0) {
    await prisma.$disconnect();
    return;
  }

  let resolved = 0;
  let failed = 0;
  let writes = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const r = await translateClusterTitle(
      c.title,
      verbose ? (m) => console.log(`    [${c.id}] ${m}`) : undefined,
      freeOnly,
    );
    if (!r.translation) {
      failed += 1;
      console.log(`  [FAIL] ${c.id} ${c.title.slice(0, 60)} -- ${r.error}`);
      continue;
    }
    resolved += 1;
    console.log(`  [OK]   ${c.id} ${c.title.slice(0, 50)} -> ${r.translation.slice(0, 60)}  (${r.model})`);
    if (dryRun) continue;
    try {
      await prisma.storyCluster.update({
        where: { id: c.id },
        data: { translatedTitle: r.translation },
      });
      writes += 1;
    } catch (err) {
      console.warn(`  update failed ${c.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Processed: ${candidates.length}`);
  console.log(`Resolved: ${resolved}`);
  console.log(`Failed: ${failed}`);
  console.log(`DB writes: ${writes}${dryRun ? " (dry-run)" : ""}`);

  await prisma.$disconnect();
}

// Guard: only run main() when this file is invoked directly via `tsx`.
// Importing it from a test file (for extractTranslation) shouldn't kick off
// a real backfill against the live DB.
import { fileURLToPath } from "node:url";
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}
