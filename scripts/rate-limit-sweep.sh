#!/usr/bin/env bash
# rate-limit-sweep.sh — find the parallelism ceiling for a given model by
# repeatedly invoking rate-limit-probe.sh at growing concurrency levels and
# stopping at the first level that produces an HTTP 429.
#
# Usage:
#   scripts/rate-limit-sweep.sh <MODEL> [STRATEGY] [START] [MAX] [STEP|FACTOR]
#
#   MODEL      model id (same format as the probe accepts)
#   STRATEGY   "linear" (default) or "double"
#                linear:  N = START, START+STEP, START+2*STEP, ...
#                double:  N = START, START*2, START*4, ...   (then bisect)
#   START      starting N (default 1)
#   MAX        upper N before giving up (default 64)
#   STEP/FACTOR linear step (default 1) OR double factor (default 2)
#
# Repeats:
#   To average noise out, set REPEATS=<k> (default 1). The probe is run k
#   times at each level and the level is considered "limited" if ANY of the
#   k runs returned a 429.
#
# Cool-down between levels (and between repeats):
#   COOLDOWN=<seconds> (default 5). Lets the gateway's per-minute window
#   reset so a previous level's bucket doesn't bleed into the next.
#
# Env passed through to the probe: QGENIE_API_KEY, QGENIE_API_BASE,
# MAX_TOKENS, TIMEOUT.
#
# Output:
#   - stderr: live progress per level
#   - stdout: a CSV-style results table, then a final "CEILING=<N>" line
#
# Exit codes:
#   0  ceiling found (printed on last line)
#   1  reached MAX without seeing a 429 (the ceiling is at least MAX)
#   2  configuration / dependency error

set -u

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <MODEL> [linear|double] [START] [MAX] [STEP|FACTOR]" >&2
  exit 2
fi

MODEL="$1"
STRATEGY="${2:-linear}"
START="${3:-1}"
MAX="${4:-64}"
STEP_OR_FACTOR="${5:-}"
REPEATS="${REPEATS:-1}"
COOLDOWN="${COOLDOWN:-5}"

case "$STRATEGY" in
  linear) STEP="${STEP_OR_FACTOR:-1}" ;;
  double) FACTOR="${STEP_OR_FACTOR:-2}" ;;
  *) echo "error: STRATEGY must be 'linear' or 'double'" >&2; exit 2 ;;
esac

for v in START MAX REPEATS; do
  if ! [[ "${!v}" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: $v must be a positive integer, got '${!v}'" >&2; exit 2
  fi
done

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PROBE="$SELF_DIR/rate-limit-probe.sh"
if [[ ! -x "$PROBE" ]]; then
  if [[ -f "$PROBE" ]]; then chmod +x "$PROBE"; else
    echo "error: probe not found: $PROBE" >&2; exit 2
  fi
fi

# ── header ────────────────────────────────────────────────────────────────
printf '# sweep MODEL=%s  STRATEGY=%s  START=%s  MAX=%s  REPEATS=%s  COOLDOWN=%ss\n' \
  "$MODEL" "$STRATEGY" "$START" "$MAX" "$REPEATS" "$COOLDOWN"
printf 'N\trun\tOK\t429\tOTHER\twall_s\tverdict\n'

# ── run a single (level, repeat); returns 0=ok 1=limited 2=other-failure ──
run_one_level() {
  local n="$1" run="$2"
  local out
  if ! out="$("$PROBE" "$MODEL" "$n" 2>/dev/null | tail -1)"; then
    # Probe returned non-zero — that means a 429 (per its contract).
    :
  fi
  # Parse the summary line: OK=.. 429=.. OTHER=.. N=.. WALL=..s MODEL=..
  local ok rate other wall verdict
  ok="$(printf '%s' "$out"   | sed -n 's/.*OK=\([0-9]*\).*/\1/p')"
  rate="$(printf '%s' "$out" | sed -n 's/.*429=\([0-9]*\).*/\1/p')"
  other="$(printf '%s' "$out"| sed -n 's/.*OTHER=\([0-9]*\).*/\1/p')"
  wall="$(printf '%s' "$out" | sed -n 's/.*WALL=\([0-9.]*\)s.*/\1/p')"
  if [[ -z "$ok$rate$other" ]]; then
    verdict="ERROR"
    printf '%d\t%d\t-\t-\t-\t-\t%s\n' "$n" "$run" "$verdict"
    return 2
  fi
  if [[ "$rate" -gt 0 ]]; then
    verdict="LIMITED"
  elif [[ "$other" -gt 0 ]]; then
    verdict="ERRORS"
  else
    verdict="OK"
  fi
  printf '%d\t%d\t%s\t%s\t%s\t%s\t%s\n' "$n" "$run" "$ok" "$rate" "$other" "$wall" "$verdict"
  if [[ "$rate" -gt 0 ]]; then return 1; fi
  return 0
}

level_is_limited() {
  # Returns 0 (shell "true") if ANY repeat at this level produced a 429,
  # 1 ("false") if every repeat was clean. This matches the convention used
  # by the callers (`if level_is_limited "$n"; then hit=1`).
  local n="$1" r limited=0
  for r in $(seq 1 "$REPEATS"); do
    if ! run_one_level "$n" "$r"; then
      # rc=1 from run_one_level means at least one 429 in this repeat
      limited=1
    fi
    if [[ "$r" -lt "$REPEATS" ]]; then sleep "$COOLDOWN"; fi
  done
  if [[ "$limited" -eq 1 ]]; then return 0; else return 1; fi
}

# ── linear strategy ───────────────────────────────────────────────────────
sweep_linear() {
  local n="$START"
  while [[ "$n" -le "$MAX" ]]; do
    echo "▶ level N=$n" >&2
    if level_is_limited "$n"; then
      printf 'CEILING=%d  (first N at which a 429 was observed)\n' "$n"
      return 0
    fi
    n=$((n + STEP))
    sleep "$COOLDOWN"
  done
  printf 'CEILING>%d  (no 429 up to MAX; raise MAX to keep searching)\n' "$MAX"
  return 1
}

# ── double-then-bisect strategy ───────────────────────────────────────────
sweep_double() {
  local prev=0 n="$START" hit=0
  while [[ "$n" -le "$MAX" ]]; do
    echo "▶ level N=$n  (doubling phase)" >&2
    if level_is_limited "$n"; then hit=1; break; fi
    prev="$n"; n=$((n * FACTOR))
    sleep "$COOLDOWN"
  done
  if [[ "$hit" -eq 0 ]]; then
    printf 'CEILING>%d  (no 429 up to MAX; raise MAX to keep searching)\n' "$MAX"
    return 1
  fi
  # Bisect between prev (clean) and n (limited).
  local lo="$prev" hi="$n"
  while [[ $((hi - lo)) -gt 1 ]]; do
    local mid=$(( (lo + hi) / 2 ))
    echo "▶ level N=$mid  (bisect [$lo,$hi])" >&2
    if level_is_limited "$mid"; then hi="$mid"; else lo="$mid"; fi
    sleep "$COOLDOWN"
  done
  printf 'CEILING=%d  (smallest N at which a 429 was observed; %d still clean)\n' "$hi" "$lo"
  return 0
}

case "$STRATEGY" in
  linear) sweep_linear ;;
  double) sweep_double ;;
esac
