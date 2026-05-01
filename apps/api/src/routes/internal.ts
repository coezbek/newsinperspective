import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getCurrentDateString } from "../lib/runtime-date.js";
import { enrichArticleText } from "../services/article-text.js";
import { runIngestion } from "../services/ingestion.js";

export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/ingest/run", async (request) => {
    const bodySchema = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .default({});

    const body = bodySchema.parse(request.body ?? {});
    const date = body.date ?? getCurrentDateString();

    return runIngestion(date);
  });

  app.get("/internal/ingest/runs/:date", async (request, reply) => {
    const params = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.params);
    const ingestionDate = new Date(`${params.date}T00:00:00.000Z`);
    const run = await prisma.ingestionRun.findUnique({
      where: { ingestionDate },
      include: { feedFetches: true },
    });

    if (!run) {
      reply.code(404);
      return { message: "Run not found" };
    }

    return run;
  });

  app.post("/internal/articles/enrich", async (request) => {
    const bodySchema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().positive().max(1000).optional(),
      force: z.boolean().optional(),
    });

    const body = bodySchema.parse(request.body ?? {});
    return enrichArticleText(body);
  });
}
