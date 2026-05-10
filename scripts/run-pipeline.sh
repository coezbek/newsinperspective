#!/usr/bin/env bash
# Run all daily-pipeline stages in order against a single combined log.
#
# Usage:
#   scripts/run-pipeline.sh [DATE] [CLUSTERS] [MAX_SOURCES_PER_CLUSTER]
#
# Defaults: DATE=today (UTC), CLUSTERS=5, MAX_SOURCES_PER_CLUSTER=5.
#
# Prerequisites (run separately):
#   - `docker compose up -d`  for postgres + ner sidecar
#   - `pnpm run dev`          for api + web + perspective sidecar
#
# Stage criticality:
#   - "critical" stages whose output later stages need (1, 2, 4) abort the
#     chain on non-zero exit.
#   - "noncritical" stages (3, 5, 6, 7) log a WARNING and continue so a
#     transient Wikipedia 429 storm or a missing optional feature doesn't
#     leave today's articles without perspective and narratives.
#
# Each stage prints its own banner, the per-stage exit code, and the full
# combined log lands at logs/pipeline-<DATE>-<HHMMSS>.log.
set -uo pipefail

cd "$(dirname "$0")/.."

DATE="${1:-$(date -u +%Y-%m-%d)}"
CLUSTERS="${2:-5}"
MAX_SOURCES="${3:-5}"
# Article and cluster caps for stage 2 scale with the run size so large
# (e.g. 20×20) ingests aren't artificially clipped at the previous 200/50
# defaults. Caps match the worst-case ingest (CLUSTERS × MAX_SOURCES) — no
# extra headroom, since each new article costs an LLM call.
ARTICLE_LIMIT=$(( CLUSTERS * MAX_SOURCES ))
CLUSTER_LIMIT=${CLUSTERS}
SOURCE_LIMIT=50
TS=$(date -u +%H%M%S)
LOG="logs/pipeline-${DATE}-${TS}.log"
mkdir -p logs

banner() {
  printf '\n========================================\n%s\n========================================\n' "$1"
}

# run_stage NAME CRITICALITY CMD
#   CRITICALITY = "critical" → non-zero exit aborts the chain.
#   CRITICALITY = "noncritical" → non-zero exit logs WARNING and continues.
run_stage() {
  local name=$1 criticality=$2 cmd=$3
  banner "STAGE: ${name}  [start $(date -u +%H:%M:%S)]"
  local t0 t1 dur code
  t0=$(date +%s)
  bash -c "${cmd}"
  code=$?
  t1=$(date +%s)
  dur=$((t1 - t0))
  printf '\n--- STAGE %s exit=%d duration=%ds ---\n' "${name}" "${code}" "${dur}"
  if [ "${code}" -ne 0 ]; then
    if [ "${criticality}" = "critical" ]; then
      printf '\nABORTING: critical stage %s failed (exit %d) — later stages depend on its output\n' "${name}" "${code}"
      return "${code}"
    fi
    printf '\nWARNING: noncritical stage %s failed (exit %d) — continuing chain\n' "${name}" "${code}"
    return 0
  fi
  return 0
}

(
  banner "PIPELINE date=${DATE} clusters=${CLUSTERS} maxSources=${MAX_SOURCES} articleLimit=${ARTICLE_LIMIT} clusterLimit=${CLUSTER_LIMIT}"
  PIPELINE_START=$(date +%s)

  KAGI_INGEST_MAX_SOURCES_PER_CLUSTER="${MAX_SOURCES}" \
  KAGI_INGEST_SKIP_EXISTING=false \
    run_stage "1-kagi-ingest" critical \
      "pnpm --filter @news/api exec tsx src/scripts/kagi-ingest.ts ${CLUSTERS} 0 '' ${DATE}" || exit $?

  run_stage "2-openrouter-backlog" critical \
    "pnpm --filter @news/api exec tsx src/scripts/enrich-openrouter.ts ${ARTICLE_LIMIT} ${CLUSTER_LIMIT} ${SOURCE_LIMIT} ${DATE}" || exit $?

  # Entity re-enrichment is independent of perspective scoring; partial /
  # throttled runs just leave some articles less-linked and can be re-run
  # later. --wait=1800 lets a still-running prior run finish first.
  run_stage "3-entity-re-enrich" noncritical \
    "pnpm --filter @news/api exec tsx src/scripts/entity-re-enrich.ts --date=${DATE} --force --wait=1800"

  # Critical: stages 5 & 6 read perspective scores written here.
  run_stage "4-cluster-perspective-backfill" critical \
    "pnpm --filter @news/api exec tsx src/scripts/cluster-perspective-backfill.ts --date ${DATE} --force" || exit $?

  # --force: recalibrate against the current corpus. Without this the script
  # short-circuits as `skipped_fresh` when computedAt is < ttlDays old, which
  # leaves narratives reading against an older, smaller-corpus calibration.
  # Noncritical: stage 6 falls back to existing thresholds if calibration
  # doesn't update.
  run_stage "5-perspective-calibrate" noncritical \
    "pnpm --filter @news/api exec tsx src/scripts/perspective-calibrate.ts --force"

  run_stage "6-perspective-narrative" noncritical \
    "pnpm --filter @news/api exec tsx src/scripts/perspective-narrative.ts --from-date ${DATE}"

  run_stage "7-perspective-resolve-countries" noncritical \
    "pnpm --filter @news/api exec tsx src/scripts/perspective-resolve-countries.ts --apply-empty"

  PIPELINE_END=$(date +%s)
  banner "PIPELINE COMPLETE  total=$((PIPELINE_END - PIPELINE_START))s"
) 2>&1 | tee -a "${LOG}"

EXIT_CODE=${PIPESTATUS[0]}
echo "Combined log: ${LOG}"
exit "${EXIT_CODE}"
