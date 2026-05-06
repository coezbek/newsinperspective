import { Prisma, ScopeType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const KIND = "perspective_calibration_v1";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fixed thresholds applied to the SBERT framing-divergence score.
 * Boundaries are inclusive on the lower side: score < p25 → "low", and so on.
 *
 * We keep the same four labels the sidecar emits so the rest of the pipeline
 * doesn't need to learn a new vocabulary; only the boundaries change.
 */
export interface PerspectiveCalibration {
  p25: number;
  p75: number;
  p90: number;
  /** Number of cluster scores the calibration was computed from. */
  sampleSize: number;
  /** ISO timestamp of computation. */
  computedAt: string;
}

export type DivergenceLabel = "low" | "moderate" | "high" | "very_high";

const STATIC_FALLBACK: PerspectiveCalibration = {
  p25: 0.08,
  p75: 0.15,
  p90: 0.25,
  sampleSize: 0,
  computedAt: new Date(0).toISOString(),
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function applyCalibration(
  score: number | null,
  calibration: PerspectiveCalibration,
): DivergenceLabel | null {
  if (score === null) return null;
  if (score < calibration.p25) return "low";
  if (score < calibration.p75) return "moderate";
  if (score < calibration.p90) return "high";
  return "very_high";
}

export async function getCalibration(): Promise<PerspectiveCalibration> {
  const row = await prisma.nlpFeature.findFirst({
    where: { scopeType: ScopeType.GLOBAL, featureSet: { path: ["kind"], equals: KIND } },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return STATIC_FALLBACK;
  const f = row.featureSet as Record<string, unknown>;
  const p25 = typeof f.p25 === "number" ? f.p25 : null;
  const p75 = typeof f.p75 === "number" ? f.p75 : null;
  const p90 = typeof f.p90 === "number" ? f.p90 : null;
  if (p25 === null || p75 === null || p90 === null) return STATIC_FALLBACK;
  return {
    p25,
    p75,
    p90,
    sampleSize: typeof f.sampleSize === "number" ? f.sampleSize : 0,
    computedAt:
      typeof f.computedAt === "string" ? f.computedAt : row.updatedAt.toISOString(),
  };
}

async function loadAllScores(): Promise<number[]> {
  const rows = await prisma.nlpFeature.findMany({
    where: {
      scopeType: ScopeType.CLUSTER,
      featureSet: { path: ["kind"], equals: "perspective_v1" },
    },
    select: { featureSet: true },
  });
  const scores: number[] = [];
  for (const row of rows) {
    const f = row.featureSet as { divergenceScore?: unknown };
    if (typeof f.divergenceScore === "number" && Number.isFinite(f.divergenceScore)) {
      scores.push(f.divergenceScore);
    }
  }
  return scores;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export interface RecalibrateResult {
  calibration: PerspectiveCalibration;
  recomputed: boolean;
  reason: "ttl_expired" | "no_calibration" | "forced" | "skipped_fresh" | "skipped_no_data";
}

export async function recalibrate(): Promise<PerspectiveCalibration> {
  const scores = await loadAllScores();
  if (scores.length === 0) {
    throw new Error("No perspective scores available for calibration");
  }
  scores.sort((a, b) => a - b);
  const calibration: PerspectiveCalibration = {
    p25: Number(quantile(scores, 0.25).toFixed(4)),
    p75: Number(quantile(scores, 0.75).toFixed(4)),
    p90: Number(quantile(scores, 0.9).toFixed(4)),
    sampleSize: scores.length,
    computedAt: new Date().toISOString(),
  };
  const payload = toInputJson({ kind: KIND, ...calibration });
  const existing = await prisma.nlpFeature.findFirst({
    where: { scopeType: ScopeType.GLOBAL, featureSet: { path: ["kind"], equals: KIND } },
    select: { id: true },
  });
  if (existing) {
    await prisma.nlpFeature.update({ where: { id: existing.id }, data: { featureSet: payload } });
  } else {
    await prisma.nlpFeature.create({ data: { scopeType: ScopeType.GLOBAL, featureSet: payload } });
  }
  return calibration;
}

export async function recalibrateIfStale(
  options?: { ttlMs?: number; force?: boolean },
): Promise<RecalibrateResult> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const force = options?.force === true;

  const existing = await getCalibration();
  if (!force && existing.sampleSize > 0) {
    const ageMs = Date.now() - new Date(existing.computedAt).getTime();
    if (ageMs < ttlMs) {
      return { calibration: existing, recomputed: false, reason: "skipped_fresh" };
    }
  }

  try {
    const calibration = await recalibrate();
    const reason: RecalibrateResult["reason"] = force
      ? "forced"
      : existing.sampleSize === 0
        ? "no_calibration"
        : "ttl_expired";
    return { calibration, recomputed: true, reason };
  } catch {
    // No data yet — keep whatever we have (fallback or stale).
    return { calibration: existing, recomputed: false, reason: "skipped_no_data" };
  }
}
