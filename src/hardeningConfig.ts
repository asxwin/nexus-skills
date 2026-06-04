// hardeningConfig.ts — centralized deadline / retry / backoff / clamp
// constants for the nexus-skills hardening pass. Single source of truth so
// the tool layer (agentTools), orchestration (orchestrator/agentSession) and
// the streaming/API layer (qgenieApi) all agree on the same bounds.
//
// Keep this file dependency-free (no vscode import) so any module can pull it
// in without cycles.

// ── Tool-layer deadlines (section A) ──────────────────────────
/** Default wall-clock deadline for a single unbounded file/tool op. */
export const TOOL_OP_TIMEOUT_MS = 30_000;
/** Deadline handed to execFile('grep', …) in search_files. */
export const SEARCH_GREP_TIMEOUT_MS = 30_000;

// ── execute_command timeout clamp (section A #4) ──────────────
export const EXEC_TIMEOUT_MIN_MS = 1_000;       // 1 s floor
export const EXEC_TIMEOUT_MAX_MS = 600_000;     // 10 min ceiling
export const EXEC_TIMEOUT_DEFAULT_MS = 60_000;  // used when arg is NaN/absent

// ── list_files / search_files numeric clamps (section A #4) ───
export const LIST_MAX_DEPTH_MIN = 1;
export const LIST_MAX_DEPTH_MAX = 32;
export const LIST_MAX_DEPTH_DEFAULT = 8;
export const SEARCH_CONTEXT_LINES_MIN = 0;
export const SEARCH_CONTEXT_LINES_MAX = 50;
export const SEARCH_CONTEXT_LINES_DEFAULT = 2;

// ── writeFileAtomic transient retry (section A #6) ────────────
export const ATOMIC_WRITE_MAX_RETRIES = 3;
export const ATOMIC_WRITE_BACKOFF_MS = 50; // base; multiplied by attempt #
/** errno codes treated as transient (retryable) for atomic writes. */
export const ATOMIC_WRITE_TRANSIENT_CODES = ['EAGAIN', 'EBUSY', 'ENFILE'] as const;

// ── Sub-agent / orchestration deadlines (section C) ───────────
/** Total wall-clock budget for a single sub-agent across all its rounds. */
export const SUBAGENT_DEADLINE_MS = 5 * 60_000; // 5 min
/** Per-round budget for one streamSubAgentRound. */
export const SUBAGENT_ROUND_TIMEOUT_MS = 2 * 60_000; // 2 min
/** Hard cap on parallel sub-agent specs accepted by delegate_task. */
export const MAX_PARALLEL_TASKS = 8;
/** Concurrency pool size: at most this many sub-agents run at once. */
export const MAX_CONCURRENT_SUBAGENTS = 4;

// ── Streaming / network resilience (section D) ────────────────
/** Cap on transient stream-error retries (blast-radius limit). */
export const MAX_TRANSIENT_RETRIES = 4;
/** Base backoff for stream retries; grows exponentially per attempt. */
export const STREAM_RETRY_BASE_MS = 500;
export const STREAM_RETRY_MAX_MS = 30_000;
/** Connection establishment timeout. */
export const STREAM_CONNECT_TIMEOUT_MS = 30_000;
/** Idle timeout: abort if no bytes received within this window. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

// ── Context-window safety (section D #window) ─────────────────
export const PRUNE_MAX_CHARS = 100_000;
/** Per-message char cap for large assistant/text-part arrays. */
export const PRUNE_ASSISTANT_PART_MAX_CHARS = 24_000;

/** Clamp helper: returns `def` for NaN/non-finite, else clamps to [min,max]. */
export function clampInt(value: unknown, min: number, max: number, def: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) { return def; }
  const i = Math.trunc(n);
  if (i < min) { return min; }
  if (i > max) { return max; }
  return i;
}
