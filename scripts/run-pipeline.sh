#!/usr/bin/env bash
# Run all 5 daily-pipeline stages in order against a single combined log.
#
# Usage:
#   scripts/run-pipeline.sh [DATE] [CLUSTERS] [MAX_SOURCES_PER_CLUSTER]
#
# Defaults: DATE=today (UTC), CLUSTERS=5, MAX_SOURCES_PER_CLUSTER=5.
#
# Each stage prints its own banner, the per-stage exit code, and the full
# combined log lands at logs/pipeline-<DATE>-<HHMMSS>.log. A failure in any
# stage stops the chain; later stages are skipped (the script keeps the
# already-imported state intact so you can re-run from where it broke).
set -uo pipefail

cd "$(dirname "$0")/.."

DATE="${1:-$(date -u +%Y-%m-%d)}"
CLUSTERS="${2:-5}"
MAX_SOURCES="${3:-5}"
TS=$(date -u +%H%M%S)
LOG="logs/pipeline-${DATE}-${TS}.log"
mkdir -p logs

banner() {
  printf '\n========================================\n%s\n========================================\n' "$1"
}

run_stage() {
  local name=$1 cmd=$2
  banner "STAGE: ${name}  [start $(date -u +%H:%M:%S)]"
  local t0 t1 dur
  t0=$(date +%s)
  bash -c "${cmd}"
  local code=$?
  t1=$(date +%s)
  dur=$((t1 - t0))
  printf '\n--- STAGE %s exit=%d duration=%ds ---\n' "${name}" "${code}" "${dur}"
  if [ "${code}" -ne 0 ]; then
    printf '\nABORTING: stage %s failed (exit %d)\n' "${name}" "${code}"
    return "${code}"
  fi
  return 0
}

(
  banner "PIPELINE date=${DATE} clusters=${CLUSTERS} maxSources=${MAX_SOURCES}"
  PIPELINE_START=$(date +%s)

  KAGI_INGEST_MAX_SOURCES_PER_CLUSTER="${MAX_SOURCES}" \
  KAGI_INGEST_SKIP_EXISTING=false \
    run_stage "1-kagi-ingest" \
      "pnpm --filter @news/api exec tsx src/scripts/kagi-ingest.ts ${CLUSTERS} 0 '' ${DATE}" || exit $?

  run_stage "2-openrouter-backlog" \
    "pnpm --filter @news/api exec tsx src/scripts/enrich-openrouter.ts 200 50 50 ${DATE}" || exit $?

  run_stage "3-entity-re-enrich" \
    "pnpm --filter @news/api exec tsx src/scripts/entity-re-enrich.ts --date=${DATE} --force" || exit $?

  run_stage "4-cluster-perspective-backfill" \
    "pnpm --filter @news/api exec tsx src/scripts/cluster-perspective-backfill.ts --date ${DATE} --force" || exit $?

  run_stage "5-perspective-calibrate" \
    "pnpm --filter @news/api exec tsx src/scripts/perspective-calibrate.ts" || exit $?

  run_stage "6-perspective-narrative" \
    "pnpm --filter @news/api exec tsx src/scripts/perspective-narrative.ts --from-date ${DATE}" || exit $?

  run_stage "7-perspective-resolve-countries" \
    "pnpm --filter @news/api exec tsx src/scripts/perspective-resolve-countries.ts --apply-empty" || exit $?

  PIPELINE_END=$(date +%s)
  banner "PIPELINE COMPLETE  total=$((PIPELINE_END - PIPELINE_START))s"
) 2>&1 | tee -a "${LOG}"

EXIT_CODE=${PIPESTATUS[0]}
echo "Combined log: ${LOG}"
exit "${EXIT_CODE}"
