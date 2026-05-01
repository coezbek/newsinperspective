import { env } from "../config/env.js";
import { getCurrentDateString } from "../lib/runtime-date.js";
import { runIngestion } from "../services/ingestion.js";
import { runOpenRouterBacklog } from "../services/openrouter-backlog.js";

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

export function startScheduler(): void {
  if (!env.AUTO_INGEST) return;

  const scheduleNext = () => {
    const wait = msUntilNextRun(env.AUTO_INGEST_TIME_UTC);
    setTimeout(async () => {
      const date = getCurrentDateString();
      try {
        await runIngestion(date);
        void runOpenRouterBacklog({
          date,
          articleLimit: 25,
          clusterLimit: 10,
          sourceLimit: 10,
        });
      } finally {
        scheduleNext();
      }
    }, wait);
  };

  scheduleNext();
}
