import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Append-only JSONL trace of every LLM call. One line per event so a run can
 * be inspected with `jq` or grep without loading megabytes into memory.
 *
 * Pairs each request with its response via `id`. The same id is returned by
 * `logLlmRequest` and passed back into `logLlmResponse`.
 *
 * Disable with `LLM_TRACE_DISABLE=true`. Override the file with `LLM_TRACE_FILE`.
 * By default the trace lands at `<repo-root>/logs/llm-trace.jsonl` (relative
 * to the api app's cwd, which is what every script uses).
 */

interface LlmRequestEvent {
  type: "request";
  id: string;
  ts: string;
  kind: string;
  model: string;
  contextId?: string;
  prompt: string;
  promptChars: number;
}

interface LlmResponseEvent {
  type: "response";
  id: string;
  ts: string;
  kind: string;
  model: string;
  contextId?: string;
  durationMs: number;
  ok: boolean;
  finishReason?: string | null;
  content?: string;
  contentChars?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: string;
  httpStatus?: number;
}

type LlmTraceEvent = LlmRequestEvent | LlmResponseEvent;

function isDisabled(): boolean {
  return process.env.LLM_TRACE_DISABLE === "true";
}

function tracePath(): string {
  const override = process.env.LLM_TRACE_FILE;
  if (override) return resolve(override);
  return resolve(process.cwd(), "logs", "llm-trace.jsonl");
}

let dirEnsured = false;
function ensureDir(path: string): void {
  if (dirEnsured) return;
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  dirEnsured = true;
}

function writeEvent(event: LlmTraceEvent): void {
  if (isDisabled()) return;
  const path = tracePath();
  try {
    ensureDir(path);
    appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Tracing must never break the caller. Silent.
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface LogLlmRequestParams {
  /** Logical caller, e.g. "openrouter-article-enrichment". */
  kind: string;
  /** Model identifier sent to the provider. */
  model: string;
  /** Optional correlation id (article id, cluster id, source domain). */
  contextId?: string;
  /** Full user-message prompt. */
  prompt: string;
}

/** Record an outgoing LLM request. Returns the call id and start timestamp. */
export function logLlmRequest(params: LogLlmRequestParams): {
  id: string;
  startedAt: number;
} {
  const id = newId();
  writeEvent({
    type: "request",
    id,
    ts: new Date().toISOString(),
    kind: params.kind,
    model: params.model,
    contextId: params.contextId,
    prompt: params.prompt,
    promptChars: params.prompt.length,
  });
  return { id, startedAt: Date.now() };
}

export interface LogLlmResponseParams {
  id: string;
  kind: string;
  model: string;
  contextId?: string;
  startedAt: number;
  ok: boolean;
  content?: string;
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: string;
  httpStatus?: number;
}

/** Record the response (or error) for a previously-logged request. */
export function logLlmResponse(params: LogLlmResponseParams): void {
  writeEvent({
    type: "response",
    id: params.id,
    ts: new Date().toISOString(),
    kind: params.kind,
    model: params.model,
    contextId: params.contextId,
    durationMs: Date.now() - params.startedAt,
    ok: params.ok,
    finishReason: params.finishReason ?? null,
    content: params.content,
    contentChars: params.content?.length,
    usage: params.usage ?? null,
    error: params.error,
    httpStatus: params.httpStatus,
  });
}
