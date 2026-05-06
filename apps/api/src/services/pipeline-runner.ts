import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { PipelineJobStatus, PipelineTrigger, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const API_DIR = resolve(process.cwd());
const LOG_TAIL_BYTES = 64 * 1024;
const PROGRESS_PREFIX = "PROGRESS ";

export interface JobKindDefinition {
  kind: string;
  label: string;
  description: string;
  script: string;
  acceptsTarget?: "none" | "string";
  buildArgs: (target: string | null, args: Record<string, unknown> | null) => string[];
}

export const JOB_KINDS: Record<string, JobKindDefinition> = {
  "kagi-ingest": {
    kind: "kagi-ingest",
    label: "Kagi ingest",
    description: "Fetch the latest Kagi Kite snapshot, extract article bodies, refresh clusters.",
    script: "src/scripts/kagi-ingest.ts",
    acceptsTarget: "none",
    buildArgs: () => [],
  },
  "openrouter-backlog": {
    kind: "openrouter-backlog",
    label: "OpenRouter article+cluster backlog",
    description: "Translate non-English articles, fill summaries, and generate cluster keywords via OpenRouter.",
    script: "src/scripts/enrich-openrouter.ts",
    acceptsTarget: "string",
    // argv: [articleLimit, clusterLimit, sourceLimit, date]
    buildArgs: (target) => (target ? ["100", "50", "50", target] : []),
  },
  "openrouter-keywords": {
    kind: "openrouter-keywords",
    label: "OpenRouter keyword retry",
    description: "Retry OpenRouter cluster-level keyword enrichment on still-pending clusters.",
    script: "src/scripts/retry-openrouter-keywords.ts",
    acceptsTarget: "string",
    // argv: [limit, date]
    buildArgs: (target) => (target ? ["200", target] : []),
  },
  "cluster-perspective-backfill": {
    kind: "cluster-perspective-backfill",
    label: "Cluster perspective backfill",
    description: "Compute perspective metrics for clusters that don't yet have them.",
    script: "src/scripts/cluster-perspective-backfill.ts",
    acceptsTarget: "none",
    buildArgs: () => [],
  },
  "perspective-calibrate": {
    kind: "perspective-calibrate",
    label: "Perspective threshold calibration",
    description:
      "Recompute global divergence-score quantiles when the cached calibration is older than its TTL.",
    script: "src/scripts/perspective-calibrate.ts",
    acceptsTarget: "none",
    buildArgs: () => [],
  },
  "cluster-perspective": {
    kind: "cluster-perspective",
    label: "Cluster perspective (single)",
    description: "Recompute perspective for one cluster id.",
    script: "src/scripts/cluster-perspective.ts",
    acceptsTarget: "string",
    buildArgs: (target) => (target ? [target] : []),
  },
  "entity-re-enrich": {
    kind: "entity-re-enrich",
    label: "Entity re-enrichment",
    description: "Re-run named-entity recognition on articles.",
    script: "src/scripts/entity-re-enrich.ts",
    acceptsTarget: "string",
    buildArgs: (target) => (target ? [`--date=${target}`] : []),
  },
};

interface RunningJob {
  id: string;
  child: ChildProcess;
  buffer: Buffer[];
  bufferBytes: number;
}

class PipelineRunner {
  private running: RunningJob | null = null;
  private pumpQueued = false;

  async enqueue(input: {
    kind: string;
    target?: string | null;
    args?: Record<string, unknown> | null;
    trigger?: PipelineTrigger;
  }): Promise<{ id: string }> {
    const def = JOB_KINDS[input.kind];
    if (!def) {
      throw new Error(`Unknown job kind: ${input.kind}`);
    }
    if (def.acceptsTarget === "string" && !input.target) {
      throw new Error(`Job ${input.kind} requires a target`);
    }

    const job = await prisma.pipelineJob.create({
      data: {
        kind: input.kind,
        target: input.target ?? null,
        args: (input.args ?? undefined) as Prisma.InputJsonValue | undefined,
        trigger: input.trigger ?? PipelineTrigger.MANUAL,
        status: PipelineJobStatus.QUEUED,
      },
    });

    this.schedulePump();
    return { id: job.id };
  }

  async cancel(id: string): Promise<boolean> {
    if (this.running?.id === id) {
      this.running.child.kill("SIGTERM");
      return true;
    }
    const job = await prisma.pipelineJob.findUnique({ where: { id } });
    if (!job) return false;
    if (job.status === PipelineJobStatus.QUEUED) {
      await prisma.pipelineJob.update({
        where: { id },
        data: {
          status: PipelineJobStatus.CANCELLED,
          finishedAt: new Date(),
          message: "Cancelled before start",
        },
      });
      return true;
    }
    return false;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  runningJobId(): string | null {
    return this.running?.id ?? null;
  }

  schedulePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    setImmediate(() => {
      this.pumpQueued = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;

    const next = await prisma.pipelineJob.findFirst({
      where: { status: PipelineJobStatus.QUEUED },
      orderBy: { queuedAt: "asc" },
    });
    if (!next) return;

    const def = JOB_KINDS[next.kind];
    if (!def) {
      await prisma.pipelineJob.update({
        where: { id: next.id },
        data: {
          status: PipelineJobStatus.FAILED,
          startedAt: new Date(),
          finishedAt: new Date(),
          message: `Unknown job kind: ${next.kind}`,
        },
      });
      this.schedulePump();
      return;
    }

    const args = def.buildArgs(next.target, (next.args as Record<string, unknown> | null) ?? null);
    const child = spawn("pnpm", ["exec", "tsx", def.script, ...args], {
      cwd: API_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const job: RunningJob = {
      id: next.id,
      child,
      buffer: [],
      bufferBytes: 0,
    };
    this.running = job;

    await prisma.pipelineJob.update({
      where: { id: next.id },
      data: {
        status: PipelineJobStatus.RUNNING,
        startedAt: new Date(),
        pid: child.pid ?? null,
      },
    });

    let pendingProgressFlush: NodeJS.Timeout | null = null;
    const flushProgress = async (progress: Record<string, unknown>) => {
      try {
        await prisma.pipelineJob.update({
          where: { id: job.id },
          data: { progress: progress as Prisma.InputJsonValue },
        });
      } catch {
        // ignore
      }
    };

    const handleChunk = (chunk: Buffer) => {
      job.buffer.push(chunk);
      job.bufferBytes += chunk.length;
      while (job.bufferBytes > LOG_TAIL_BYTES && job.buffer.length > 1) {
        const dropped = job.buffer.shift()!;
        job.bufferBytes -= dropped.length;
      }

      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith(PROGRESS_PREFIX)) {
          const payload = line.slice(PROGRESS_PREFIX.length).trim();
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(payload);
          } catch {
            const match = payload.match(/^(\d+)\s*\/\s*(\d+)(?:\s+(.*))?$/);
            if (match) {
              parsed = {
                done: Number(match[1]),
                total: Number(match[2]),
                note: match[3] ?? null,
              };
            }
          }
          if (parsed) {
            if (pendingProgressFlush) clearTimeout(pendingProgressFlush);
            pendingProgressFlush = setTimeout(() => {
              pendingProgressFlush = null;
              void flushProgress(parsed!);
            }, 250);
          }
        }
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);

    child.on("error", async (error) => {
      await prisma.pipelineJob.update({
        where: { id: job.id },
        data: {
          status: PipelineJobStatus.FAILED,
          finishedAt: new Date(),
          message: error.message,
          logTail: Buffer.concat(job.buffer).toString("utf8"),
        },
      });
      this.running = null;
      this.schedulePump();
    });

    child.on("close", async (code, signal) => {
      if (pendingProgressFlush) {
        clearTimeout(pendingProgressFlush);
        pendingProgressFlush = null;
      }
      const ok = code === 0;
      const finalStatus = ok
        ? PipelineJobStatus.SUCCESS
        : signal === "SIGTERM"
          ? PipelineJobStatus.CANCELLED
          : PipelineJobStatus.FAILED;
      const message = ok
        ? "Completed"
        : signal
          ? `Terminated by ${signal}`
          : `Exited with code ${code}`;
      await prisma.pipelineJob.update({
        where: { id: job.id },
        data: {
          status: finalStatus,
          finishedAt: new Date(),
          exitCode: code ?? null,
          message,
          logTail: Buffer.concat(job.buffer).toString("utf8"),
        },
      });
      this.running = null;
      this.schedulePump();
    });
  }
}

export const pipelineRunner = new PipelineRunner();

export function startPipelineRunner(): void {
  pipelineRunner.schedulePump();
}
