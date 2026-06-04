#!/usr/bin/env bash
# rate-limit-probe.sh — fire N truly-concurrent chat-completion requests at
# the QGenie gateway and report how many succeed, how many are rate-limited
# (HTTP 429), and how many fail for some other reason.
#
# This bypasses the VS Code extension's orchestrator (which caps concurrent
# sub-agents at 4 — see src/hardeningConfig.ts MAX_CONCURRENT_SUBAGENTS), so
# it actually measures the gateway / model rate limit rather than our own
# self-imposed pool.
#
# Usage:
#   scripts/rate-limit-probe.sh <MODEL> <N> [PROMPT]
#
#   MODEL   model id as accepted by /v1/chat/completions (e.g. the value of
#           "id" returned by /v1/models). Quote ids that contain "::".
#   N       number of CONCURRENT requests to fire.
#   PROMPT  optional user prompt; defaults to a tiny ping that returns ~1 token.
#
# Env:
#   QGENIE_API_KEY   API key. If unset, the script falls back to parsing
#                    ~/.config/qgenie-cli/config.toml (line: api_key = "...").
#   QGENIE_API_BASE  defaults to https://qgenie-api.qualcomm.com/v1
#   MAX_TOKENS       defaults to 4 (keep responses cheap)
#   TIMEOUT          curl --max-time, default 60 (seconds)
#
# Exit codes:
#   0  no 429s observed (all requests at this concurrency level admitted)
#   1  at least one 429 observed (rate limit hit at this concurrency)
#   2  hard error (missing key, missing deps, etc.)
#
# Output:
#   stdout: one line per request "code=<http>  time=<sec>"
#           then a summary "OK=<n>  429=<n>  OTHER=<n>  N=<n>  MODEL=<id>"
#   stderr: progress / warnings only

set -u

# ── arg parsing ────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "usage: $0 <MODEL> <N> [PROMPT]" >&2
  exit 2
fi
MODEL="$1"
N="$2"
PROMPT="${3:-ping}"

if ! [[ "$N" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: N must be a positive integer, got '$N'" >&2
  exit 2
fi

# ── deps ──────────────────────────────────────────────────────────────────
for cmd in curl jq xargs awk; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 2
  fi
done

# ── API key resolution ────────────────────────────────────────────────────
API_BASE="${QGENIE_API_BASE:-https://qgenie-api.qualcomm.com/v1}"
API_KEY="${QGENIE_API_KEY:-}"
if [[ -z "$API_KEY" ]]; then
  CFG="$HOME/.config/qgenie-cli/config.toml"
  if [[ -r "$CFG" ]]; then
    API_KEY="$(awk -F= '/^[[:space:]]*api_key[[:space:]]*=/{
      gsub(/^[[:space:]]*"|"[[:space:]]*$/, "", $2); print $2; exit }' "$CFG" | tr -d '"'"'"' \r\n')"
  fi
fi
if [[ -z "$API_KEY" ]]; then
  echo "error: no API key (set QGENIE_API_KEY or write ~/.config/qgenie-cli/config.toml)" >&2
  exit 2
fi

MAX_TOKENS="${MAX_TOKENS:-4}"
TIMEOUT="${TIMEOUT:-60}"

# ── build request body once ───────────────────────────────────────────────
BODY="$(jq -nc \
  --arg model "$MODEL" \
  --arg prompt "$PROMPT" \
  --argjson max_tokens "$MAX_TOKENS" \
  '{model:$model, max_tokens:$max_tokens, stream:false,
    messages:[{role:"user", content:$prompt}]}')"

# ── temp dir for per-request output ───────────────────────────────────────
TMP="$(mktemp -d -t qg-rl-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# ── single-request worker ─────────────────────────────────────────────────
# Writes one line "code=<http>  time=<sec>  err=<short>" to $TMP/$i.
fire_one() {
  local i="$1"
  local out="$TMP/$i.out"
  local err="$TMP/$i.err"
  # -w is the only thing we keep on stdout; response body goes to /dev/null.
  local rc
  curl --silent --show-error \
       --max-time "$TIMEOUT" \
       -o /dev/null \
       -w 'code=%{http_code}  time=%{time_total}\n' \
       -X POST "$API_BASE/chat/completions" \
       -H "Authorization: Bearer $API_KEY" \
       -H "X-Encrypted-Key: $API_KEY" \
       -H 'Content-Type: application/json' \
       --data-raw "$BODY" \
       >"$out" 2>"$err"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    # curl-level failure (timeout, DNS, conn reset). Mark as code=000 with err msg.
    local emsg
    emsg="$(tr '\n' ' ' <"$err" | cut -c1-120)"
    printf 'code=000  time=NA  err=%s\n' "${emsg:-curl_rc_$rc}" >"$out"
  fi
}
export -f fire_one
export TMP API_BASE API_KEY BODY TIMEOUT

# ── fan out via xargs -P (true OS-level parallelism) ──────────────────────
START_TS="$(date +%s.%N)"
echo "▶ probing MODEL=$MODEL  N=$N  base=$API_BASE  max_tokens=$MAX_TOKENS" >&2
seq 1 "$N" | xargs -P "$N" -I{} bash -c 'fire_one "$@"' _ {}
END_TS="$(date +%s.%N)"

# ── collect & report ──────────────────────────────────────────────────────
ok=0; rate=0; other=0
for i in $(seq 1 "$N"); do
  line="$(cat "$TMP/$i.out" 2>/dev/null || echo 'code=??? time=NA err=missing')"
  printf '#%-3d  %s\n' "$i" "$line"
  code="$(printf '%s' "$line" | sed -n 's/^code=\([0-9]*\).*/\1/p')"
  case "$code" in
    2??)              ok=$((ok+1)) ;;
    429)              rate=$((rate+1)) ;;
    *)                other=$((other+1)) ;;
  esac
done

WALL="$(awk -v s="$START_TS" -v e="$END_TS" 'BEGIN{printf "%.2f", e-s}')"
printf 'OK=%d  429=%d  OTHER=%d  N=%d  WALL=%ss  MODEL=%s\n' \
  "$ok" "$rate" "$other" "$N" "$WALL" "$MODEL"

if [[ $rate -gt 0 ]]; then exit 1; fi
exit 0
