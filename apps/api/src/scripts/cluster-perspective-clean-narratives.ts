import { ScopeType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import "../config/env.js";
import { prisma } from "../lib/prisma.js";

function stripModelReasoning(raw: string): string {
  if (!raw) return "";
  let out = raw;
  out = out.replace(/<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*\/\s*(think|thinking|reasoning)\s*>/gi, "");
  out = out.replace(/<\s*(think|thinking|reasoning)\s*>[\s\S]*?(?=\n\s*(?:\*\*|\d+\.\s|##|\*|-))/gi, "");
  out = out.replace(/\[\s*\/?\s*(REASONING|THINKING)\s*\][\s\S]*?\[\s*\/\s*\1\s*\]/gi, "");
  return out.trim();
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function main(): Promise<void> {
  const rows = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
    },
    select: { id: true, clusterId: true, featureSet: true },
  });

  let inspected = 0;
  let updated = 0;
  for (const row of rows) {
    const f = row.featureSet as Record<string, unknown> | null;
    if (!f || !f.narrative) continue;
    inspected += 1;
    const narrative = f.narrative as Record<string, unknown>;
    const framingRaw = typeof narrative.framingAngles === "string" ? narrative.framingAngles : "";
    const countryRaw = typeof narrative.countryNarrative === "string" ? narrative.countryNarrative : "";
    const framing = stripModelReasoning(framingRaw);
    const country = stripModelReasoning(countryRaw);

    const changed = framing !== framingRaw || country !== countryRaw;
    if (!changed) continue;

    const newNarrative = {
      ...narrative,
      framingAngles: framing.length > 0 ? framing : null,
      countryNarrative: country.length > 0 ? country : null,
    };
    await prisma.nlpFeature.update({
      where: { id: row.id },
      data: { featureSet: toInputJson({ ...f, narrative: newNarrative }) },
    });
    updated += 1;
    console.log(`  cleaned ${row.clusterId}`);
  }

  console.log(`\nDone — inspected ${inspected} narrative(s), updated ${updated}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
