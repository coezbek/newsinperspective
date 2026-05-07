import { prisma } from "../lib/prisma.js";
import { enrichSourceProfileWithOpenRouter } from "./source-profile-enrichment.js";
import { enrichSourceProfileFromWikidata } from "./source-profile-wikidata.js";

export interface SourceStatInput {
  sourceName: string;
  count: number;
  sentimentSum: number;
  biasSignals: Iterable<string>;
}

function needsSourceEnrichment(profile: {
  description: string | null;
  country: string | null;
  countryOfOrigin: string | null;
  headquarters: string | null;
  mediaOwner: string | null;
  wikipediaUrl: string | null;
} | null): boolean {
  if (!profile) return true;
  return !profile.country || !profile.headquarters || !profile.mediaOwner || !profile.wikipediaUrl || !profile.description;
}

export async function upsertSourceProfiles(
  sourceStats: Map<string, SourceStatInput>,
  options?: { incremental?: boolean; enrichMetadata?: boolean },
): Promise<void> {
  for (const [domain, stats] of sourceStats.entries()) {
    const existing = await prisma.sourceProfile.findUnique({
      where: { domain },
    });

    const previousCount = options?.incremental ? existing?.articleCount ?? 0 : 0;
    const previousSentimentTotal = options?.incremental ? (existing?.averageSentiment ?? 0) * previousCount : 0;
    const nextCount = previousCount + stats.count;
    const nextAverageSentiment =
      nextCount > 0 ? Number(((previousSentimentTotal + stats.sentimentSum) / nextCount).toFixed(3)) : 0;
    const nextBiasSignals = [
      ...new Set([
        ...(existing?.commonBiasSignals ?? []),
        ...[...stats.biasSignals].map((value) => value.trim()).filter(Boolean),
      ]),
    ].slice(0, 8);

    let enrichment: Awaited<ReturnType<typeof enrichSourceProfileWithOpenRouter>> | null = null;
    let wikidataId: string | null = existing?.wikidataId ?? null;
    if (options?.enrichMetadata !== false && needsSourceEnrichment(existing)) {
      const sourceName = existing?.sourceName ?? stats.sourceName;
      const wd = await enrichSourceProfileFromWikidata({ domain, sourceName });
      if (wd) {
        const { wikidataId: qid, ...rest } = wd;
        enrichment = rest;
        wikidataId = qid;
      } else {
        enrichment = await enrichSourceProfileWithOpenRouter({ domain, sourceName });
      }
    }

    await prisma.sourceProfile.upsert({
      where: { domain },
      update: {
        sourceName: existing?.sourceName ?? stats.sourceName,
        description: existing?.description ?? enrichment?.description ?? null,
        country: existing?.country ?? enrichment?.country ?? null,
        countryOfOrigin: existing?.countryOfOrigin ?? enrichment?.countryOfOrigin ?? null,
        headquarters: existing?.headquarters ?? enrichment?.headquarters ?? null,
        mediaOwner: existing?.mediaOwner ?? enrichment?.mediaOwner ?? null,
        ownershipType: existing?.ownershipType ?? enrichment?.ownershipType ?? null,
        employeeCount: existing?.employeeCount ?? enrichment?.employeeCount ?? null,
        wikipediaUrl: existing?.wikipediaUrl ?? enrichment?.wikipediaUrl ?? null,
        associatedEntities: [
          ...new Set([...(existing?.associatedEntities ?? []), ...(enrichment?.associatedEntities ?? [])]),
        ].slice(0, 8),
        articleCount: nextCount,
        averageSentiment: nextAverageSentiment,
        commonBiasSignals: nextBiasSignals,
        lastEnrichedAt: enrichment?.error ? existing?.lastEnrichedAt ?? null : enrichment ? new Date() : existing?.lastEnrichedAt ?? null,
        enrichmentModel: enrichment?.model ?? existing?.enrichmentModel ?? null,
        wikidataId,
      },
      create: {
        domain,
        sourceName: stats.sourceName,
        description: enrichment?.description ?? null,
        country: enrichment?.country ?? null,
        countryOfOrigin: enrichment?.countryOfOrigin ?? null,
        headquarters: enrichment?.headquarters ?? null,
        mediaOwner: enrichment?.mediaOwner ?? null,
        ownershipType: enrichment?.ownershipType ?? null,
        employeeCount: enrichment?.employeeCount ?? null,
        wikipediaUrl: enrichment?.wikipediaUrl ?? null,
        associatedEntities: enrichment?.associatedEntities ?? [],
        articleCount: stats.count,
        averageSentiment: Number((stats.sentimentSum / Math.max(stats.count, 1)).toFixed(3)),
        commonBiasSignals: [...new Set([...stats.biasSignals])].slice(0, 8),
        lastEnrichedAt: enrichment?.error ? null : enrichment ? new Date() : null,
        enrichmentModel: enrichment?.model ?? null,
        wikidataId,
      },
    });
  }
}
