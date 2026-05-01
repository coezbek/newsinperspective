import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { runOpenRouterBacklog } from "../services/openrouter-backlog.js";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main() {
  const articleLimit = parsePositiveInt(process.argv[2], 25);
  const clusterLimit = parsePositiveInt(process.argv[3], 10);
  const sourceLimit = parsePositiveInt(process.argv[4], 10);
  const date = process.argv[5];

  const result = await runOpenRouterBacklog({
    articleLimit,
    clusterLimit,
    sourceLimit,
    ...(date ? { date } : {}),
    log: (message) => {
      console.log(message);
    },
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
