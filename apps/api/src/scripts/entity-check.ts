import "../config/env.js";
import { prisma } from "../lib/prisma.js";

async function main() {
  // Get entity statistics
  const totalEntities = await prisma.namedEntity.count();
  const totalMentions = await prisma.entityMention.count();

  console.log("\n=== ENTITY STATISTICS ===");
  console.log(`Total Named Entities: ${totalEntities}`);
  console.log(`Total Entity Mentions: ${totalMentions}`);

  // Get entities with Wikipedia links
  const entitiesWithWiki = await prisma.namedEntity.count({
    where: {
      wikipediaUrl: { not: null },
    },
  });

  const entitiesWithoutWiki = await prisma.namedEntity.count({
    where: {
      wikipediaUrl: null,
    },
  });

  console.log(`\nEntities WITH Wikipedia links: ${entitiesWithWiki}`);
  console.log(`Entities WITHOUT Wikipedia links: ${entitiesWithoutWiki}`);

  // Get sample entities with all details
  const sampleEntities = await prisma.namedEntity.findMany({
    include: {
      _count: {
        select: { mentions: true },
      },
    },
    orderBy: {
      mentions: {
        _count: "desc",
      },
    },
    take: 10,
  });

  console.log("\n=== TOP 10 ENTITIES BY MENTION COUNT ===");
  sampleEntities.forEach((entity, i) => {
    console.log(`\n${i + 1}. ${entity.name}`);
    console.log(`   Type: ${entity.type}`);
    console.log(`   Mentions: ${entity._count.mentions}`);
    console.log(`   Wikipedia URL: ${entity.wikipediaUrl || "❌ MISSING"}`);
    console.log(`   Summary: ${entity.summary ? entity.summary.substring(0, 100) + "..." : "❌ MISSING"}`);
    console.log(`   Image URL: ${entity.imageUrl ? "✓ Present" : "❌ MISSING"}`);
  });

  // Get entities by type
  const byType = await prisma.namedEntity.groupBy({
    by: ["type"],
    _count: true,
  });

  console.log("\n=== ENTITIES BY TYPE ===");
  byType.forEach((group) => {
    console.log(`${group.type}: ${group._count}`);
  });

  // Check a specific article for entities
  const articles = await prisma.article.findMany({
    include: {
      _count: {
        select: { entityMentions: true },
      },
    },
    where: {
      entityMentions: {
        some: {},
      },
    },
    orderBy: {
      entityMentions: {
        _count: "desc",
      },
    },
    take: 5,
  });

  console.log("\n=== TOP ARTICLES WITH ENTITY MENTIONS ===");
  for (const article of articles) {
    console.log(`\n${article.title}`);
    console.log(`Domain: ${article.domain}`);
    console.log(`Entity mentions: ${article._count.entityMentions}`);

    // Get detailed entity mentions for this article
    const mentions = await prisma.entityMention.findMany({
      where: { articleId: article.id },
      include: { entity: true },
      take: 5,
    });

    mentions.forEach((mention) => {
      console.log(`  • "${mention.entity.name}" (${mention.entity.type})`);
      console.log(`    Confidence: ${mention.confidence}`);
      console.log(`    Wikipedia: ${mention.entity.wikipediaUrl ? "✓" : "❌"}`);
      console.log(`    Context: "${mention.context.substring(0, 80)}..."`);
    });
  }

  // Summary
  const articlesWithEntities = await prisma.article.count({
    where: {
      entityMentions: {
        some: {},
      },
    },
  });

  console.log("\n=== SUMMARY ===");
  console.log(`Articles with entity mentions: ${articlesWithEntities}`);
  console.log(`Total articles: ${await prisma.article.count()}`);
  console.log(`Coverage: ${((articlesWithEntities / (await prisma.article.count())) * 100).toFixed(2)}%`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
