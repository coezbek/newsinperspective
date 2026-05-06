import "../config/env.js";
import { entityLinkerService } from "../services/entity-linker.js";
import { EntityType } from "../domain/entity-types.js";

async function main() {
  console.log("\n=== TESTING ENTITY LINKER ===\n");

  // Test entities
  const testEntities = [
    {
      entityText: "Sydney",
      entityType: EntityType.GPE,
      confidence: 0.85,
      startOffset: 0,
      endOffset: 6,
      context: "Sydney is a city",
    },
    {
      entityText: "Australia",
      entityType: EntityType.GPE,
      confidence: 0.85,
      startOffset: 10,
      endOffset: 19,
      context: "Australia is a country",
    },
    {
      entityText: "Vladimir Putin",
      entityType: EntityType.PERSON,
      confidence: 0.95,
      startOffset: 0,
      endOffset: 14,
      context: "Vladimir Putin is a person",
    },
    {
      entityText: "Ben Roberts-Smith",
      entityType: EntityType.PERSON,
      confidence: 0.8,
      startOffset: 0,
      endOffset: 16,
      context: "Ben Roberts-Smith's girlfriend",
    },
  ];

  for (const entity of testEntities) {
    console.log(`\n📍 Testing: "${entity.entityText}" (${entity.entityType})`);
    console.log("-".repeat(60));

    try {
      const linked = await entityLinkerService.linkEntity(entity);

      console.log(`✓ Result:`);
      console.log(`  Wikipedia URL: ${linked.wikipediaUrl || "❌ MISSING"}`);
      console.log(`  Summary: ${linked.summary ? linked.summary.substring(0, 80) + "..." : "❌ MISSING"}`);
      console.log(`  Image URL: ${linked.imageUrl ? "✓" : "❌"}`);

      if (!linked.wikipediaUrl) {
        console.log(`\n⚠️  WARNING: No Wikipedia link found for "${entity.entityText}"`);
      }
    } catch (error) {
      console.error(`❌ Error:`, error instanceof Error ? error.message : String(error));
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\n" + "=".repeat(60));
  console.log("Test complete!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
