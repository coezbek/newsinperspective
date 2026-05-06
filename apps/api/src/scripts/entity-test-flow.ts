import "../config/env.js";
import { entityRecognitionService } from "../services/entity-recognition.js";
import { entityLinkerService } from "../services/entity-linker.js";

const testArticle = `
Why Jarome Luai's PNG parade was so painful for Tigers fans

The star playmaker returned to Sydney on Monday evening after a not-so-subtle trip to meet Chiefs officials in PNG.
Wests Tigers fans are right to be worried.
`;

async function main() {
  console.log("\n=== TESTING FULL ENRICHMENT FLOW ===\n");

  // Step 1: Recognize entities
  console.log("Step 1: Entity Recognition (NER)");
  console.log("-".repeat(60));

  const nerResult = await entityRecognitionService.recognizeEntities(testArticle);

  console.log(`✓ Found ${nerResult.totalEntities} entities`);
  console.log(`  By type:`, nerResult.byType);
  console.log(`  Confidence: min=${nerResult.confidence.min.toFixed(2)}, max=${nerResult.confidence.max.toFixed(2)}, avg=${nerResult.confidence.average.toFixed(2)}`);

  // Step 2: Link entities to Wikipedia
  console.log("\nStep 2: Entity Linking (Wikipedia)");
  console.log("-".repeat(60));

  let linkedCount = 0;
  let withoutWiki = 0;

  for (const entity of nerResult.entities) {
    console.log(`\n  Processing: "${entity.entityText}" (${entity.entityType})`);
    console.log(`    Confidence: ${(entity.confidence * 100).toFixed(1)}%`);
    console.log(`    Context: "${entity.context.substring(0, 60)}..."`);

    try {
      const linked = await entityLinkerService.linkEntity(entity);

      if (linked.wikipediaUrl) {
        console.log(`    ✓ Wikipedia URL: ${linked.wikipediaUrl}`);
        console.log(`    ✓ Summary: ${linked.summary ? linked.summary.substring(0, 60) + "..." : "NONE"}`);
        linkedCount++;
      } else {
        console.log(`    ❌ NO WIKIPEDIA LINK FOUND`);
        withoutWiki++;
      }
    } catch (error) {
      console.error(`    ❌ Error linking:`, error instanceof Error ? error.message : String(error));
      withoutWiki++;
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Summary
  console.log("\n\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Entities recognized: ${nerResult.totalEntities}`);
  console.log(`Entities linked to Wikipedia: ${linkedCount}`);
  console.log(`Entities without Wikipedia: ${withoutWiki}`);
  console.log(`Success rate: ${linkedCount > 0 ? ((linkedCount / (linkedCount + withoutWiki)) * 100).toFixed(1) + "%" : "0%"}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
