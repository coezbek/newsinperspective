/**
 * Single-command daily pipeline runner.
 *
 * Replaces the README's tmux/`&&`-chain with one process that runs the
 * canonical 5-stage chain documented in `pipeline-runner.ts:JOB_KINDS`,
 * plus an enrichment loop that drains the article backlog before moving
 * on (the underlying script processes a fixed batch per call).
 *
 * Usage:
 *   pnpm pipeline:run [--date=YYYY-MM-DD] [--clusters=10] [--articles-per-cluster=10]
 *
 * Defaults reproduce the README's "100-article test (10 clusters x <=10
 * articles)" scenario for the current UTC day. Each stage's stdout/stderr
 * is mirrored to logs/pipeline-<n>-<name>.log so a failed stage can be
 * inspected and re-run individually.
 */
import "../config/env.js";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma } from "../lib/prisma.js";
import { getCurrentDateString } from "../lib/runtime-date.js";

interface StageResult {
  name: string;
  status: "ok" | "fail";
  exitCode: number | null;
  durationMs: number;
  logFile: string;
  tail: string;
}

function getCliArg(name: string): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function runStage(
  name: string,
  script: string,
  args: string[],
  envOverride: NodeJS.ProcessEnv,
  logsDir: string,
): Promise<StageResult> {
  const logFile = resolve(logsDir, `pipeline-${name}.log`);
  const header = `\n========== [${name}] ${script} ${args.join(" ")} ==========\n`;
  process.stdout.write(header);
  await writeFile(logFile, header);

  const start = Date.now();
  const child = spawn(
    "pnpm",
    ["--filter", "@news/api", "exec", "tsx", script, ...args],
    {
      env: { ...process.env, ...envOverride },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const tailChunks: Buffer[] = [];
  let tailBytes = 0;
  const TAIL_LIMIT = 32_768;
  const writes: Promise<unknown>[] = [];
  const onChunk = (chunk: Buffer): void => {
    process.stdout.write(chunk);
    writes.push(
      // Append in order; collect promises so we can flush before resolving.
      // node:fs/promises has no appendFile barrier, so we serialise via a chain.
      // For simplicity: each chunk is a separate writeFile in append mode.
      // (Failures here are non-fatal; we log to stdout regardless.)
      (async () => {
        const fs = await import("node:fs/promises");
        await fs.appendFile(logFile, chunk).catch(() => {});
      })(),
    );
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > TAIL_LIMIT && tailChunks.length > 1) {
      const dropped = tailChunks.shift();
      if (dropped) tailBytes -= dropped.length;
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const exitCode = await new Promise<number | null>((res, rej) => {
    child.on("error", rej);
    child.on("exit", (code) => res(code));
  });
  await Promise.allSettled(writes);

  return {
    name,
    status: exitCode === 0 ? "ok" : "fail",
    exitCode,
    durationMs: Date.now() - start,
    logFile,
    tail: Buffer.concat(tailChunks).toString("utf8"),
  };
}

/**
 * `enrich-openrouter.ts` ends with `JSON.stringify(result)`, where result
 * shape is `{ articles: { attempted, ready, failed }, clusters: {...},
 * sources: {...} }`. The backlog is drained when no scope had anything to
 * attempt this round.
 */
function isBacklogDrained(stageTail: string): boolean {
  const match = stageTail.match(/\{[\s\S]*"articles"[\s\S]*\}\s*$/);
  if (!match) return false;
  try {
    const parsed = JSON.parse(match[0]) as {
      articles?: { attempted?: number };
      clusters?: { attempted?: number };
      sources?: { attempted?: number };
    };
    const articleAttempts = parsed.articles?.attempted ?? 0;
    const clusterAttempts = parsed.clusters?.attempted ?? 0;
    const sourceAttempts = parsed.sources?.attempted ?? 0;
    return articleAttempts === 0 && clusterAttempts === 0 && sourceAttempts === 0;
  } catch {
    return false;
  }
}

interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
  byModel: Map<string, { prompt: number; completion: number; total: number; calls: number }>;
}

async function summariseTokenUsage(logsDir: string): Promise<TokenUsage> {
  const usage: TokenUsage = {
    prompt: 0,
    completion: 0,
    total: 0,
    calls: 0,
    byModel: new Map(),
  };
  const files = await readdir(logsDir).catch(() => []);
  // Match the recognisable line shape emitted by performOpenRouterRequest:
  //   [tokens] model=<model> prompt=<n> completion=<n> total=<n>
  const re = /\[tokens\] model=(\S+) prompt=(\d+) completion=(\d+) total=(\d+)/;
  for (const file of files) {
    if (!file.startsWith("pipeline-")) continue;
    const text = await readFile(resolve(logsDir, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const m = line.match(re);
      if (!m) continue;
      const [, model, p, c, t] = m;
      const promptN = Number(p);
      const completionN = Number(c);
      const totalN = Number(t);
      usage.prompt += promptN;
      usage.completion += completionN;
      usage.total += totalN;
      usage.calls += 1;
      const bucket = usage.byModel.get(model!) ?? {
        prompt: 0,
        completion: 0,
        total: 0,
        calls: 0,
      };
      bucket.prompt += promptN;
      bucket.completion += completionN;
      bucket.total += totalN;
      bucket.calls += 1;
      usage.byModel.set(model!, bucket);
    }
  }
  return usage;
}

async function main(): Promise<void> {
  const date = getCliArg("date") ?? getCurrentDateString();
  const topClusters = parsePositiveInt(getCliArg("clusters"), 10);
  const maxArticlesPerCluster = parsePositiveInt(getCliArg("articles-per-cluster"), 10);
  const enrichmentMaxRounds = parsePositiveInt(getCliArg("enrichment-rounds"), 20);

  const logsDir = resolve(process.cwd(), "logs");
  await mkdir(logsDir, { recursive: true });

  console.log("================ Pipeline run ================");
  console.log(`  Date:                       ${date}`);
  console.log(`  Top clusters:               ${topClusters}`);
  console.log(`  Max articles per cluster:   ${maxArticlesPerCluster}`);
  console.log(`  Paid fallback model:        ${process.env.OPENROUTER_PAID_FALLBACK_MODEL ?? "(unset)"}`);
  console.log(`  OpenRouter API key set:     ${process.env.OPENROUTER_API_KEY ? "yes" : "no"}`);
  console.log(`  Logs directory:             ${logsDir}`);
  console.log("==============================================");

  // Stage env: cap source extraction to the requested per-cluster article
  // count, and force re-extraction so a re-run on the same date refreshes
  // article bodies instead of skipping them.
  const stageEnv: NodeJS.ProcessEnv = {
    KAGI_INGEST_MAX_SOURCES_PER_CLUSTER: String(maxArticlesPerCluster),
    KAGI_INGEST_SKIP_EXISTING: "false",
    ENRICHMENT_CONCURRENCY: process.env.ENRICHMENT_CONCURRENCY ?? "2",
  };

  const results: StageResult[] = [];

  // -- Stage 1: Kagi cluster ingest -----------------------------------------
  // `<topClusters> 0` -> exactly N global clusters, no per-category top-up.
  // The README's "10 clusters x <=10 articles" scenario uses `10 0`.
  results.push(
    await runStage(
      "1-kagi-ingest",
      "src/scripts/kagi-ingest.ts",
      [String(topClusters), "0", "", date],
      stageEnv,
      logsDir,
    ),
  );
  if (results.at(-1)?.status === "fail") return finalize(results, logsDir);

  // -- Stage 2: OpenRouter enrichment loop ----------------------------------
  // `enrich-openrouter.ts` processes a fixed batch per call. We loop until
  // the backlog drains or we hit a hard ceiling (so a stuck article can't
  // run forever). Per-iteration cap is generous so realistic backlogs
  // finish in 1-2 rounds.
  const articleBudget = Math.max(50, topClusters * maxArticlesPerCluster * 2);
  let drained = false;
  for (let i = 0; i < enrichmentMaxRounds && !drained; i += 1) {
    const stage = await runStage(
      `2-openrouter-${String(i + 1).padStart(2, "0")}`,
      "src/scripts/enrich-openrouter.ts",
      [String(articleBudget), "50", "50", date],
      stageEnv,
      logsDir,
    );
    results.push(stage);
    if (stage.status === "fail") return finalize(results, logsDir);
    drained = isBacklogDrained(stage.tail);
    if (drained) {
      console.log(`[pipeline] backlog drained after round ${i + 1}`);
    } else if (i + 1 === enrichmentMaxRounds) {
      console.log(
        `[pipeline] enrichment loop hit max rounds (${enrichmentMaxRounds}); proceeding with remaining backlog`,
      );
    }
  }

  // -- Stage 3: Entity re-enrichment ----------------------------------------
  results.push(
    await runStage(
      "3-entities",
      "src/scripts/entity-re-enrich.ts",
      [`--date=${date}`],
      stageEnv,
      logsDir,
    ),
  );
  if (results.at(-1)?.status === "fail") return finalize(results, logsDir);

  // -- Stage 4: Cluster perspective backfill --------------------------------
  // `--force` so we overwrite any perspective row that was computed by the
  // /api/clusters/:id/perspective lazy-compute path before stage 2 finished.
  // Without --force the backfill skips "already computed" clusters and
  // leaves the pre-enrichment garbage in place.
  results.push(
    await runStage(
      "4-perspective",
      "src/scripts/cluster-perspective-backfill.ts",
      ["--date", date, "--force"],
      stageEnv,
      logsDir,
    ),
  );
  if (results.at(-1)?.status === "fail") return finalize(results, logsDir);

  // -- Stage 5: Calibration -------------------------------------------------
  // Refresh global divergence quantiles. Cheap; safe to run every time.
  results.push(
    await runStage(
      "5-calibrate",
      "src/scripts/perspective-calibrate.ts",
      [],
      stageEnv,
      logsDir,
    ),
  );

  return finalize(results, logsDir);
}

async function finalize(results: StageResult[], logsDir: string): Promise<void> {
  const usage = await summariseTokenUsage(logsDir);

  console.log("\n================ Pipeline summary ================");
  for (const r of results) {
    const tag = r.status === "ok" ? "[ok]  " : "[FAIL]";
    console.log(
      `  ${tag} ${r.name.padEnd(22)} ${(r.durationMs / 1000).toFixed(1).padStart(7)}s  ${r.logFile}`,
    );
  }

  console.log("\n---------------- Token usage ----------------");
  console.log(`  Calls:       ${usage.calls}`);
  console.log(`  Prompt:      ${usage.prompt.toLocaleString()}`);
  console.log(`  Completion:  ${usage.completion.toLocaleString()}`);
  console.log(`  Total:       ${usage.total.toLocaleString()}`);
  if (usage.byModel.size > 0) {
    console.log("  By model:");
    const rows = [...usage.byModel.entries()].sort(
      (a, b) => b[1].total - a[1].total,
    );
    for (const [model, b] of rows) {
      console.log(
        `    ${model.padEnd(40)} calls=${String(b.calls).padStart(5)}  prompt=${String(b.prompt).padStart(8)}  completion=${String(b.completion).padStart(8)}  total=${String(b.total).padStart(8)}`,
      );
    }
  }
  console.log("=============================================");

  const anyFail = results.some((r) => r.status === "fail");
  if (anyFail) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
