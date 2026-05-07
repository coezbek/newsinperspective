import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCachedFavicon } from "../services/favicon-cache.js";
import {
  getArticleDetail,
  getSourceProfile,
  getTagProfile,
  getStoryComparison,
  getStoryDetail,
  listStoriesByDate,
  listStoryDates,
  listStoryFacets,
  listStoryFacetsFiltered,
} from "../services/story-query.js";
import { entityQueryService } from "../services/entity-query.js";
import { JOB_KINDS, pipelineRunner } from "../services/pipeline-runner.js";
import { nextScheduledRun } from "../workers/scheduler.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import {
  computeClusterPerspective,
  getClusterReadiness,
  getStoredClusterPerspective,
} from "../services/cluster-perspective.js";
import {
  generateClusterNarrative,
  getStoredNarrative,
} from "../services/cluster-perspective-narrative.js";
import { getPerspectiveStats } from "../services/perspective-stats.js";
import {
  articleEntitiesQuerySchema,
  searchEntitiesQuerySchema,
  entityIdParamsSchema,
} from "@news/shared";

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dates", async () => {
    return listStoryDates();
  });

  app.get("/api/stories", async (request, reply) => {
    const querySchema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      category: z.string().optional(),
      region: z.string().optional(),
      keyword: z.string().optional(),
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    });
    const query = querySchema.parse(request.query);
    const filters =
      query.category || query.region
        ? {
            category: query.category,
            region: query.region,
            keyword: query.keyword,
          }
        : undefined;
    const finalFilters =
      query.keyword && !filters
        ? { keyword: query.keyword }
        : filters;
    return listStoriesByDate(query.date, finalFilters, {
      offset: query.offset,
      limit: query.limit,
    });
  });

  app.get("/api/facets", async (request) => {
    const querySchema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      keyword: z.string().optional(),
    });
    const query = querySchema.parse(request.query);
    if (query.keyword) {
      return listStoryFacetsFiltered(query.date, { keyword: query.keyword });
    }
    return listStoryFacets(query.date);
  });

  app.get("/api/stories/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    // Gate on full pipeline readiness — same threshold as the listing
    // filter, so a deep-link to a half-enriched cluster behaves like the
    // listing (which would have hidden it) instead of rendering wrong data.
    const readiness = await getClusterReadiness(params.id);
    if (readiness.totalArticles === 0) {
      reply.code(404);
      return { message: "Story not found" };
    }
    if (!readiness.ready) {
      reply.code(425);
      return {
        message: readiness.reason ?? "Story still being enriched",
        enriched: readiness.enrichedArticles,
        total: readiness.totalArticles,
        hasPerspective: readiness.hasPerspective,
      };
    }
    const detail = await getStoryDetail(params.id);
    if (!detail) {
      reply.code(404);
      return { message: "Story not found" };
    }
    return detail;
  });

  app.get("/api/stories/:id/comparison", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const readiness = await getClusterReadiness(params.id);
    if (readiness.totalArticles === 0) {
      reply.code(404);
      return { message: "Story not found" };
    }
    if (!readiness.ready) {
      reply.code(425);
      return {
        message: readiness.reason ?? "Comparison unavailable while enrichment is in progress",
        enriched: readiness.enrichedArticles,
        total: readiness.totalArticles,
        hasPerspective: readiness.hasPerspective,
      };
    }
    const comparison = await getStoryComparison(params.id);
    if (!comparison) {
      reply.code(404);
      return { message: "Story comparison not found" };
    }
    return comparison;
  });

  app.get("/api/articles/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const detail = await getArticleDetail(params.id);
    if (!detail) {
      reply.code(404);
      return { message: "Article not found" };
    }
    return detail;
  });

  app.get("/api/perspective/stats", async () => {
    return getPerspectiveStats();
  });

  app.get("/api/clusters/:id/perspective", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z
      .object({
        refresh: z.coerce.boolean().optional(),
        narrative: z.coerce.boolean().optional(),
      })
      .parse(request.query ?? {});

    let perspective = !query.refresh ? await getStoredClusterPerspective(params.id) : null;
    if (!perspective) {
      // Readiness guard via the shared helper. Same reasoning as before:
      // the lazy compute persists its result, so calling it on a half-
      // enriched cluster locks in a wrong divergence score until someone
      // forces ?refresh=true. Surface 425 so the UI shows "pipeline in
      // progress" instead of bad numbers.
      const readiness = await getClusterReadiness(params.id);
      if (readiness.totalArticles === 0) {
        reply.code(404);
        return { message: `Cluster ${params.id} has no articles` };
      }
      if (!readiness.ready) {
        reply.code(425);
        return {
          message: readiness.reason ?? "Cluster not ready",
          enriched: readiness.enrichedArticles,
          total: readiness.totalArticles,
          hasPerspective: readiness.hasPerspective,
        };
      }
      try {
        perspective = await computeClusterPerspective(params.id, { persist: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to compute perspective";
        if (message.includes("not found")) {
          reply.code(404);
          return { message };
        }
        reply.code(502);
        return { message };
      }
    }

    const { getCalibration } = await import("../services/perspective-calibration.js");
    const calibration = await getCalibration();
    const divergence_thresholds = {
      p25: calibration.p25,
      p75: calibration.p75,
      p90: calibration.p90,
    };

    if (!query.narrative) {
      return {
        ...perspective,
        divergence_thresholds,
        narrative: await getStoredNarrative(params.id),
      };
    }

    const { prisma } = await import("../lib/prisma.js");
    const cluster = await prisma.storyCluster.findUnique({
      where: { id: params.id },
      select: { title: true },
    });
    const title = cluster?.title ?? "";
    const narrative = await generateClusterNarrative(params.id, title, perspective);
    return { ...perspective, divergence_thresholds, narrative };
  });

  app.get("/api/sources/:domain", async (request, reply) => {
    const params = z.object({ domain: z.string() }).parse(request.params);
    const source = await getSourceProfile(params.domain);
    if (!source) {
      reply.code(404);
      return { message: "Source not found" };
    }
    return source;
  });

  app.get("/api/tags/:keyword", async (request, reply) => {
    const params = z.object({ keyword: z.string() }).parse(request.params);
    const tag = await getTagProfile(params.keyword);
    if (!tag) {
      reply.code(404);
      return { message: "Tag not found" };
    }
    return tag;
  });

  app.get("/api/favicons/:domain", async (request, reply) => {
    const params = z.object({ domain: z.string().min(1).max(255) }).parse(request.params);
    const query = z.object({ refresh: z.coerce.boolean().optional() }).parse(request.query);
    const favicon = await getCachedFavicon(params.domain, { forceRefresh: query.refresh ?? false });

    if (!favicon) {
      reply.code(404);
      return { message: `Favicon not found for domain: ${params.domain}` };
    }

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(favicon.contentType);
    return reply.send(favicon.buffer);
  });

  // Entity API Routes (NER + Wikipedia linking)

  app.get("/api/articles/:articleId/entities", async (request, reply) => {
    const paramsSchema = z.object({ articleId: z.string().min(1) });
    const params = paramsSchema.parse(request.params);
    const query = articleEntitiesQuerySchema.parse(request.query);

    try {
      const { prisma } = await import("../lib/prisma.js");
      const article = await prisma.article.findUnique({
        where: { id: params.articleId },
        select: { title: true },
      });
      if (!article) {
        reply.code(404);
        return { message: "Article not found" };
      }
      const entities = await entityQueryService.getArticleEntities(
        params.articleId,
        {
          type: query.type ? (query.type as any) : undefined,
          minConfidence: query.minConfidence,
          limit: query.limit,
        },
      );
      const byType = { PERSON: 0, GPE: 0, ORG: 0, EVENT: 0 };
      entities.forEach((e) => {
        if (e.entityType in byType) byType[e.entityType as keyof typeof byType]++;
      });
      return { articleId: params.articleId, title: article.title, totalEntities: entities.length, byType, entities };
    } catch (error) {
      if ((error as any).code === "P2025") { reply.code(404); return { message: "Article not found" }; }
      throw error;
    }
  });

  app.get("/api/entities/search", async (request, reply) => {
    const query = searchEntitiesQuerySchema.parse(request.query);
    try {
      const { results, totalResults } = await entityQueryService.searchEntities(query.q, {
        type: query.type ? (query.type as any) : undefined,
        limit: query.limit,
        offset: query.offset,
      });
      return { query: query.q, totalResults, results };
    } catch (error) {
      reply.code(500);
      return { message: "Search failed: " + (error as any).message };
    }
  });

  app.get("/api/entities/:entityId", async (request, reply) => {
    const params = entityIdParamsSchema.parse(request.params);
    try {
      const entity = await entityQueryService.getEntityDetail(params.entityId);
      return entity;
    } catch (error) {
      if ((error as any).message?.includes("Entity not found")) { reply.code(404); return { message: "Entity not found" }; }
      throw error;
    }
  });

  const clusterIdParams = z.object({ clusterId: z.string().min(1) });
  const clusterEntitiesQuery = z.object({
    type: z.enum(["PERSON", "ORG", "GPE", "EVENT"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  app.get("/api/clusters/:clusterId/entities", async (request) => {
    const { clusterId } = clusterIdParams.parse(request.params);
    const query = clusterEntitiesQuery.parse(request.query);
    const entities = await entityQueryService.getClusterEntities(clusterId, {
      limit: query.limit,
      type: query.type as any,
    });
    return { clusterId, totalEntities: entities.length, entities };
  });

  const clusterByDomainQuery = z.object({
    type: z.enum(["PERSON", "ORG", "GPE", "EVENT"]).optional(),
    perDomainLimit: z.coerce.number().int().min(1).max(50).optional(),
  });

  app.get("/api/clusters/:clusterId/entities/by-domain", async (request) => {
    const { clusterId } = clusterIdParams.parse(request.params);
    const query = clusterByDomainQuery.parse(request.query);
    const byDomain = await entityQueryService.getClusterEntitiesByDomain(clusterId, {
      perDomainLimit: query.perDomainLimit,
      type: query.type as any,
    });
    return { clusterId, domains: byDomain };
  });

  const domainParams = z.object({ domain: z.string().min(1) });
  const domainEntitiesQuery = z.object({
    type: z.enum(["PERSON", "ORG", "GPE", "EVENT"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  app.get("/api/domains/:domain/entities", async (request) => {
    const { domain } = domainParams.parse(request.params);
    const query = domainEntitiesQuery.parse(request.query);
    const entities = await entityQueryService.getDomainEntities(domain, {
      limit: query.limit,
      type: query.type as any,
    });
    return { domain, totalEntities: entities.length, entities };
  });

  app.get("/api/pipeline/info", async () => {
    return {
      autoIngest: env.AUTO_INGEST,
      autoIngestTimeUtc: env.AUTO_INGEST_TIME_UTC,
      nextScheduledRun: env.AUTO_INGEST ? nextScheduledRun(env.AUTO_INGEST_TIME_UTC).toISOString() : null,
      runningJobId: pipelineRunner.runningJobId(),
      kinds: Object.values(JOB_KINDS).map((definition) => ({
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        acceptsTarget: definition.acceptsTarget ?? "none",
      })),
    };
  });

  app.get("/api/pipeline/jobs", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        status: z.enum(["QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"]).optional(),
        kind: z.string().optional(),
      })
      .parse(request.query);
    const jobs = await prisma.pipelineJob.findMany({
      where: {
        status: query.status,
        kind: query.kind,
      },
      orderBy: { queuedAt: "desc" },
      take: query.limit ?? 50,
      select: {
        id: true,
        kind: true,
        target: true,
        status: true,
        trigger: true,
        queuedAt: true,
        startedAt: true,
        finishedAt: true,
        exitCode: true,
        message: true,
        progress: true,
      },
    });
    return { jobs };
  });

  app.get("/api/pipeline/jobs/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = await prisma.pipelineJob.findUnique({ where: { id } });
    if (!job) {
      reply.code(404);
      return { message: "Job not found" };
    }
    return { job };
  });

  app.post("/api/pipeline/jobs", async (request, reply) => {
    const body = z
      .object({
        kind: z.string(),
        target: z.string().optional().nullable(),
        args: z.record(z.unknown()).optional().nullable(),
      })
      .parse(request.body);
    try {
      const created = await pipelineRunner.enqueue({
        kind: body.kind,
        target: body.target ?? null,
        args: body.args ?? null,
      });
      return { id: created.id };
    } catch (error) {
      reply.code(400);
      return { message: error instanceof Error ? error.message : "Failed to enqueue job" };
    }
  });

  app.post("/api/pipeline/jobs/:id/cancel", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ok = await pipelineRunner.cancel(id);
    if (!ok) {
      reply.code(409);
      return { message: "Job is not running or queued" };
    }
    return { ok: true };
  });
}
