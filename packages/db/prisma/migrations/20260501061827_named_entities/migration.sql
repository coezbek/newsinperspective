-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PERSON', 'GPE', 'ORG', 'EVENT');

-- AlterTable
ALTER TABLE "SourceProfile" ALTER COLUMN "associatedEntities" DROP DEFAULT;

-- CreateTable
CREATE TABLE "NamedEntity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "wikiId" TEXT,
    "wikipediaUrl" TEXT,
    "wikidataId" TEXT,
    "summary" TEXT,
    "imageUrl" TEXT,
    "infoboxJson" JSONB,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NamedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityMention" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "context" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityStatistics" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "totalMentions" INTEGER NOT NULL DEFAULT 0,
    "uniqueArticles" INTEGER NOT NULL DEFAULT 0,
    "mentions7Days" INTEGER NOT NULL DEFAULT 0,
    "mentions30Days" INTEGER NOT NULL DEFAULT 0,
    "averagePosition" DOUBLE PRECISION,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityStatistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityCooccurrence" (
    "id" TEXT NOT NULL,
    "entity1Id" TEXT NOT NULL,
    "entity2Id" TEXT NOT NULL,
    "cooccurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityCooccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NamedEntity_name_key" ON "NamedEntity"("name");

-- CreateIndex
CREATE UNIQUE INDEX "NamedEntity_wikiId_key" ON "NamedEntity"("wikiId");

-- CreateIndex
CREATE INDEX "NamedEntity_name_idx" ON "NamedEntity"("name");

-- CreateIndex
CREATE INDEX "NamedEntity_type_idx" ON "NamedEntity"("type");

-- CreateIndex
CREATE INDEX "EntityMention_entityId_idx" ON "EntityMention"("entityId");

-- CreateIndex
CREATE INDEX "EntityMention_articleId_idx" ON "EntityMention"("articleId");

-- CreateIndex
CREATE INDEX "EntityMention_confidence_idx" ON "EntityMention"("confidence");

-- CreateIndex
CREATE UNIQUE INDEX "EntityStatistics_entityId_key" ON "EntityStatistics"("entityId");

-- CreateIndex
CREATE INDEX "EntityCooccurrence_entity1Id_idx" ON "EntityCooccurrence"("entity1Id");

-- CreateIndex
CREATE INDEX "EntityCooccurrence_entity2Id_idx" ON "EntityCooccurrence"("entity2Id");

-- CreateIndex
CREATE UNIQUE INDEX "EntityCooccurrence_entity1Id_entity2Id_key" ON "EntityCooccurrence"("entity1Id", "entity2Id");

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "NamedEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityStatistics" ADD CONSTRAINT "EntityStatistics_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "NamedEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityCooccurrence" ADD CONSTRAINT "EntityCooccurrence_entity1Id_fkey" FOREIGN KEY ("entity1Id") REFERENCES "NamedEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityCooccurrence" ADD CONSTRAINT "EntityCooccurrence_entity2Id_fkey" FOREIGN KEY ("entity2Id") REFERENCES "NamedEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
