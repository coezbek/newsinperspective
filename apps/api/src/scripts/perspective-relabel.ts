import { Prisma, ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { applyCalibration, getCalibration } from "../services/perspective-calibration.js";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function main(): Promise<void> {
  const calibration = await getCalibration();
  console.log(
    `Calibration: n=${calibration.sampleSize} p25=${calibration.p25} p75=${calibration.p75} p90=${calibration.p90}`,
  );

  const rows = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
    },
    select: { id: true, clusterId: true, featureSet: true },
  });

  let updated = 0;
  let unchanged = 0;
  const counts = { low: 0, moderate: 0, high: 0, very_high: 0, null: 0 };

  for (const row of rows) {
    const f = row.featureSet as Record<string, unknown>;
    const score = typeof f.divergenceScore === "number" ? (f.divergenceScore as number) : null;
    const newLabel = applyCalibration(score, calibration);
    const oldLabel = (f.divergenceLabel as string | null) ?? null;
    counts[newLabel ?? "null"] = (counts[newLabel ?? "null"] ?? 0) + 1;

    if (newLabel === oldLabel) {
      unchanged += 1;
      continue;
    }

    const next = toInputJson({
      ...f,
      divergenceLabel: newLabel,
      calibration: {
        p25: calibration.p25,
        p75: calibration.p75,
        p90: calibration.p90,
        sampleSize: calibration.sampleSize,
        computedAt: calibration.computedAt,
      },
    });
    await prisma.nlpFeature.update({ where: { id: row.id }, data: { featureSet: next } });
    updated += 1;
  }

  console.log(
    `Relabeled ${updated}/${rows.length} cluster perspectives (${unchanged} unchanged).`,
  );
  console.log(
    `New label distribution: low=${counts.low} moderate=${counts.moderate} high=${counts.high} very_high=${counts.very_high}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
