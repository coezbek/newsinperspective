import { PipelineTrigger } from "@prisma/client";
import { env } from "../config/env.js";
import { pipelineRunner } from "../services/pipeline-runner.js";
import { getCurrentDateString } from "../lib/runtime-date.js";

function msUntilNextRun(timeUtc: string): number {
  const [hours, minutes] = timeUtc.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hours ?? 12, minutes ?? 0, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function nextScheduledRun(timeUtc: string): Date {
  return new Date(Date.now() + msUntilNextRun(timeUtc));
}

export function startScheduler(): void {
  if (!env.AUTO_INGEST) return;

  const scheduleNext = () => {
    const wait = msUntilNextRun(env.AUTO_INGEST_TIME_UTC);
    setTimeout(async () => {
      try {
        const snapshotDate = getCurrentDateString();
        await pipelineRunner.enqueue({
          kind: "kagi-ingest",
          trigger: PipelineTrigger.SCHEDULED,
        });
        await pipelineRunner.enqueue({
          kind: "openrouter-backlog",
          target: snapshotDate,
          trigger: PipelineTrigger.SCHEDULED,
        });
        await pipelineRunner.enqueue({
          kind: "entity-re-enrich",
          target: snapshotDate,
          trigger: PipelineTrigger.SCHEDULED,
        });
        await pipelineRunner.enqueue({
          kind: "cluster-perspective-backfill",
          trigger: PipelineTrigger.SCHEDULED,
        });
        await pipelineRunner.enqueue({
          kind: "perspective-calibrate",
          trigger: PipelineTrigger.SCHEDULED,
        });
      } finally {
        scheduleNext();
      }
    }, wait);
  };

  scheduleNext();
}
