-- CreateEnum
CREATE TYPE "PipelineJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PipelineTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateTable
CREATE TABLE "PipelineJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT,
    "args" JSONB,
    "status" "PipelineJobStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "PipelineTrigger" NOT NULL DEFAULT 'MANUAL',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "pid" INTEGER,
    "message" TEXT,
    "progress" JSONB,
    "logTail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineJob_status_queuedAt_idx" ON "PipelineJob"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "PipelineJob_kind_queuedAt_idx" ON "PipelineJob"("kind", "queuedAt");
