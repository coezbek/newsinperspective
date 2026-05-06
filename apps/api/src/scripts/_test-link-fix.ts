import { entityLinkerService } from "../services/entity-linker.js";
import { EntityType } from "../domain/entity-types.js";

const tests: Array<{ entityText: string; entityType: EntityType }> = [
  { entityText: "eBay", entityType: EntityType.ORG },
  { entityText: "GameStop", entityType: EntityType.ORG },
  { entityText: "TD Securities", entityType: EntityType.ORG },
  { entityText: "Joe Biden", entityType: EntityType.PERSON },
  { entityText: "Napoli", entityType: EntityType.GPE },
  { entityText: "Mike Rogers", entityType: EntityType.PERSON },
];

async function main() {
  for (const t of tests) {
    const r = await entityLinkerService.linkEntity({
      ...t,
      confidence: 0.9,
      startOffset: 0,
      endOffset: t.entityText.length,
      context: "",
    });
    console.log("---", t.entityText);
    console.log("  url:", r.wikipediaUrl ?? "(none)");
    console.log("  summary:", (r.summary ?? "").slice(0, 240));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
