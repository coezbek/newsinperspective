-- AlterTable
ALTER TABLE "SourceProfile" ADD COLUMN     "wikidataId" TEXT;

-- CreateIndex
CREATE INDEX "SourceProfile_wikidataId_idx" ON "SourceProfile"("wikidataId");
