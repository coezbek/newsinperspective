import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

export interface PipelineStageStatus {
  name: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string | null; // HH:MM:SS as printed in the log banner
  durationSeconds: number | null;
  exitCode: number | null;
  lastLines: string[]; // tail of stdout for this stage (running stage only, else [])
}

export interface PipelineLogStatus {
  logFile: string | null;
  logFileMtime: string | null;
  pipelineHeader: string | null;
  pipelineComplete: boolean;
  pipelineTotalSeconds: number | null;
  abortMessage: string | null;
  stages: PipelineStageStatus[];
}

const STAGE_HEADER_RE = /^STAGE:\s+(\S+)\s+\[start\s+(\d{2}:\d{2}:\d{2})\]/;
const STAGE_FOOTER_RE = /^---\s+STAGE\s+(\S+)\s+exit=(-?\d+)\s+duration=(\d+)s\s+---/;
const PIPELINE_HEADER_RE = /^PIPELINE\s+date=.*$/;
const PIPELINE_COMPLETE_RE = /^PIPELINE COMPLETE\s+total=(\d+)s/;
const ABORT_RE = /^ABORTING:\s+(.+)$/;

const TAIL_LINES_RUNNING = 30;
const READ_TAIL_BYTES = 512 * 1024; // last 512KB is plenty for stage scanning

function logsDir(): string {
  // Pipeline logs are written by scripts/run-pipeline.sh into <repo>/logs.
  // The API may be started from either the repo root or apps/api, so resolve
  // both candidates and pick whichever exists; default to repo root (../..
  // from this file's package).
  const cwd = process.cwd();
  if (cwd.endsWith("/apps/api")) return resolve(cwd, "../../logs");
  return resolve(cwd, "logs");
}

async function findLatestPipelineLog(): Promise<{ path: string; mtime: Date } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(logsDir());
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => /^pipeline-\d{4}-\d{2}-\d{2}-\d{6}\.log$/.test(name));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(logsDir(), name);
      const stat = await fs.stat(path);
      return { path, mtime: stat.mtime };
    }),
  );
  stats.sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
  return stats[0] ?? null;
}

async function readLogTail(path: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(path);
  const size = stat.size;
  const offset = Math.max(0, size - maxBytes);
  const handle = await fs.open(path, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    let text = buffer.toString("utf8");
    if (offset > 0) {
      // Drop the leading partial line so we don't misparse a banner.
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

export async function getPipelineLogStatus(): Promise<PipelineLogStatus> {
  const latest = await findLatestPipelineLog();
  if (!latest) {
    return {
      logFile: null,
      logFileMtime: null,
      pipelineHeader: null,
      pipelineComplete: false,
      pipelineTotalSeconds: null,
      abortMessage: null,
      stages: [],
    };
  }

  const text = await readLogTail(latest.path, READ_TAIL_BYTES);
  const lines = text.split("\n");

  let pipelineHeader: string | null = null;
  let pipelineComplete = false;
  let pipelineTotalSeconds: number | null = null;
  let abortMessage: string | null = null;

  // Walk lines, tracking stages by start order. Each stage starts with the
  // STAGE: banner; ends with `--- STAGE name exit=… duration=…s ---`. If a
  // stage has a header but no footer, it's the currently running stage.
  const stages: PipelineStageStatus[] = [];
  let runningStageStartIdx: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    if (pipelineHeader === null) {
      const headerMatch = line.match(PIPELINE_HEADER_RE);
      if (headerMatch) pipelineHeader = line.trim();
    }

    const completeMatch = line.match(PIPELINE_COMPLETE_RE);
    if (completeMatch) {
      pipelineComplete = true;
      pipelineTotalSeconds = Number.parseInt(completeMatch[1] ?? "0", 10);
      continue;
    }

    const abortMatch = line.match(ABORT_RE);
    if (abortMatch) {
      abortMessage = abortMatch[1] ?? line;
      continue;
    }

    const headerMatch = line.match(STAGE_HEADER_RE);
    if (headerMatch) {
      stages.push({
        name: headerMatch[1] ?? "?",
        status: "running",
        startedAt: headerMatch[2] ?? null,
        durationSeconds: null,
        exitCode: null,
        lastLines: [],
      });
      runningStageStartIdx = i;
      continue;
    }

    const footerMatch = line.match(STAGE_FOOTER_RE);
    if (footerMatch) {
      const name = footerMatch[1] ?? "?";
      const exitCode = Number.parseInt(footerMatch[2] ?? "0", 10);
      const duration = Number.parseInt(footerMatch[3] ?? "0", 10);
      // Find the most recent matching running stage and close it.
      for (let j = stages.length - 1; j >= 0; j -= 1) {
        if (stages[j]?.name === name && stages[j]?.status === "running") {
          stages[j]!.status = exitCode === 0 ? "succeeded" : "failed";
          stages[j]!.exitCode = exitCode;
          stages[j]!.durationSeconds = duration;
          break;
        }
      }
      runningStageStartIdx = null;
    }
  }

  // For a still-running terminal stage, capture the tail of its output
  // so the UI can show "what is it doing right now".
  const lastStage = stages[stages.length - 1];
  if (lastStage && lastStage.status === "running" && runningStageStartIdx !== null) {
    const slice = lines.slice(runningStageStartIdx + 1);
    const meaningful = slice
      .map((line) => line.replace(/\s+$/, ""))
      .filter((line) => line.length > 0 && !line.startsWith("===="));
    lastStage.lastLines = meaningful.slice(-TAIL_LINES_RUNNING);
  }

  return {
    logFile: latest.path,
    logFileMtime: latest.mtime.toISOString(),
    pipelineHeader,
    pipelineComplete,
    pipelineTotalSeconds,
    abortMessage,
    stages,
  };
}
