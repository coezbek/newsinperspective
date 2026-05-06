import "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { recalibrateIfStale } from "../services/perspective-calibration.js";

interface CliOptions {
  ttlDays: number;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { ttlDays: 7, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--ttl-days":
        opts.ttlDays = Number(argv[++i] ?? opts.ttlDays);
        break;
      case "--force":
        opts.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm --filter @news/api perspective:calibrate [--ttl-days 7] [--force]",
        );
        process.exit(0);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const ttlMs = opts.ttlDays * 24 * 60 * 60 * 1000;
  const result = await recalibrateIfStale({ ttlMs, force: opts.force });
  const c = result.calibration;
  if (result.recomputed) {
    console.log(
      `Recalibrated (${result.reason}): n=${c.sampleSize}  p25=${c.p25}  p75=${c.p75}  p90=${c.p90}  computedAt=${c.computedAt}`,
    );
  } else {
    console.log(
      `Skipped (${result.reason}): n=${c.sampleSize}  p25=${c.p25}  p75=${c.p75}  p90=${c.p90}  computedAt=${c.computedAt}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
