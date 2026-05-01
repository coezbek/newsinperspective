ALTER TABLE "SourceProfile"
ADD COLUMN "description" TEXT,
ADD COLUMN "country" TEXT,
ADD COLUMN "countryOfOrigin" TEXT,
ADD COLUMN "headquarters" TEXT,
ADD COLUMN "mediaOwner" TEXT,
ADD COLUMN "ownershipType" TEXT,
ADD COLUMN "employeeCount" INTEGER,
ADD COLUMN "wikipediaUrl" TEXT,
ADD COLUMN "associatedEntities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "lastEnrichedAt" TIMESTAMP(3),
ADD COLUMN "enrichmentModel" TEXT;
