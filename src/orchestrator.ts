// Orchestration layer: delegates work to parallel sub-agents via `delegate_task`,
// then folds their reports back. Side-effecting tools are gated through `onApproval`.

import {
  QGenieConfig,
  streamChatCompletion,
  ChatMessage,
} from './qgenieApi';
import {
  APPROVAL_REQUIRED_TOOLS,
  buildToolPrompt,
  buildWorkspaceContext,
  executeTool,
  disposeAgentTerminal,
  XML_TOOL_SCHEMA,
  NO_ECHO_TOOLS,
  coerceToolArgs,
} from './agentTools';
import { XmlToolParser } from './xmlToolParser';
import { splitThinkingChunks, flushSplitter, ThinkingCarry } from './thinkingSplitter';
import { isTransientStreamError } from './agentSession';
import {
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_ROUND_TIMEOUT_MS,
  MAX_CONCURRENT_SUBAGENTS,
} from './hardeningConfig';

/** Race a promise against a timeout; rejects with `new Error(label)` if `ms` elapses first.
 *  Always clears the timer so a settled `p` never leaks a pending handle. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Bounded async pool: runs `worker` over `items` with at most `limit` in flight.
 *  Never rejects — each item's outcome is captured as a PromiseSettledResult so one
 *  crash never discards siblings' results. */
async function runPool<T>(
  items: DelegatedTaskSpec[],
  limit: number,
  worker: (s: DelegatedTaskSpec, index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length);
  let next = 0;
  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) { return; }
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { status: 'rejected', reason: e };
      }
    }
  }
  const runnerCount = Math.min(Math.max(1, limit), items.length);
  const runners = Array.from({ length: runnerCount }, () => runner());
  await Promise.all(runners);
  return results;
}

// Same schema as the main session. Sub-agents may NOT call `delegate_task`
// (no recursion) to prevent runaway fan-out.
const SUBAGENT_TOOL_SCHEMA: Record<string, string[]> = XML_TOOL_SCHEMA;

export interface SubAgentProgress {
  /** A sub-agent started working on its task. */
  onStart?: (agentId: string, title: string, task: string) => void;
  /** Streaming plain-text "speech" from the sub-agent (its reasoning / answer). */
  onDelta?: (agentId: string, delta: string) => void;
  /** The sub-agent invoked a tool. */
  onTool?: (agentId: string, toolName: string, input: string, output: string, isError: boolean) => void;
  /** The sub-agent finished (success or error). `finalText` is its closing answer. */
  onDone?: (agentId: string, finalText: string, ok: boolean) => void;
}

interface RunSubAgentOptions {
  agentId: string;
  title: string;
  task: string;
  model: string;
  config: QGenieConfig;
  signal: AbortSignal;
  progress: SubAgentProgress;
  /** Gate for side-effecting tools. Resolve true to allow, false to deny. */
  onApproval: (agentId: string, title: string, toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Hard cap on tool-use rounds for one sub-agent. */
  maxIterations?: number;
}

interface SubAgentResult {
  agentId: string;
  title: string;
  task: string;
  finalText: string;
  ok: boolean;
  toolCalls: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT TEMPLATES — separated from logic for readability. Functions below
// interpolate dynamic values (workspace context, tool protocol) into these.
// ═══════════════════════════════════════════════════════════════════════════════

/** Static body of the orchestrator system prompt (dynamic workspace context appended at runtime). */
const ORCHESTRATOR_PROMPT_BODY = `# QGENIE ORCHESTRATOR — Multi-Agent Coordinator

You are QGenie running in ORCHESTRATOR mode. You coordinate a team of
identical QGenie sub-agents to complete the user's request faster and
more thoroughly than a single agent could. Each sub-agent is a full
instance of the same model with the same coding tools (read_file,
write_file, replace_in_file, execute_command, list_files, search_files,
etc.) but runs INDEPENDENTLY and in PARALLEL with the others.

## HOW YOU WORK

1. **Decompose.** Break the user's request into independent, well-scoped
   sub-tasks that can run in parallel without stepping on each other.
   Good sub-tasks are self-contained ("audit src/auth for security
   issues", "write unit tests for parser.ts", "summarise how the build
   pipeline works"). Bad sub-tasks depend on each other's mid-flight
   state.

2. **Delegate.** Use the \`delegate_task\` tool to dispatch the sub-tasks.
   You pass a JSON array of task objects; each runs as its own sub-agent
   in parallel. You get back every sub-agent's final report in one tool
   result.

3. **Synthesize.** Read the sub-agents' reports and either (a) delegate a
   follow-up round, or (b) write the final answer to the user that
   integrates their findings. Do NOT just concatenate their reports —
   reconcile, deduplicate, and resolve conflicts.

## WHEN TO DELEGATE vs DO IT YOURSELF

- Delegate when the work is genuinely parallelizable (independent files,
  independent questions, map-style "do X to each of these N things").
- Just answer directly (no delegation) for trivial questions or when the
  work is inherently sequential.
- Don't delegate a single task you could do in one step — the overhead
  isn't worth it.

## RULES

- Keep the number of parallel sub-agents reasonable (2–6 is the sweet
  spot; the tool will cap excessive fan-out).
- Give each sub-agent a CRISP, complete task description — it cannot see
  this conversation, only the task string you hand it.
- Sub-agents CANNOT delegate further (no recursion).
- Side-effecting tools a sub-agent runs (writes, shell commands) still
  require the human's approval, shown labelled with that sub-agent's
  name.
- After the final \`delegate_task\` result, STOP calling tools and write
  the synthesized final answer as plain prose (no tool tag).

## delegate_task TOOL

Emit it exactly like any other tool. The \`tasks\` parameter is a JSON
array of objects: each MUST have a short \`title\` and a detailed
\`task\`; optionally a \`model\` (defaults to your current model).

Example:
<delegate_task>
<tasks>
[
  { "title": "audit-auth", "task": "Read every file under src/auth and list security issues with file:line references. Do not modify anything." },
  { "title": "audit-db",   "task": "Read every file under src/db and list SQL-injection or connection-leak risks with file:line references. Do not modify anything." }
]
</tasks>
</delegate_task>
`;

/** System prompt for the orchestrator agent: explains multi-agent coordination via `delegate_task`. */
export function buildOrchestratorSystemPrompt(wsCtx: string): string {
  return ORCHESTRATOR_PROMPT_BODY + wsCtx;
}

/** Static text of the delegate_task tool documentation (no dynamic parts). */
const DELEGATE_TOOL_PROMPT_TEXT = `

# delegate_task  (ORCHESTRATOR-ONLY TOOL)
Dispatch one or more independent sub-tasks to parallel sub-agents
(fresh instances of the same model, each with the full tool set). You
receive every sub-agent's final report back in a single tool result.

Parameters:
  - tasks (required): a JSON array of task objects. Each object:
      { "title": "<short-id>", "task": "<detailed self-contained instructions>", "model": "<optional model id>" }

Rules:
  - The JSON must be valid and parse to an array of objects.
  - Each task runs in PARALLEL and in ISOLATION — it cannot see this
    conversation, only its own \`task\` string. Make each one complete.
  - Sub-agents cannot themselves delegate (no recursion).
  - 2–6 tasks is ideal; very large arrays are capped.

Example:
<delegate_task>
<tasks>
[
  { "title": "tests",  "task": "Write jest unit tests for src/util/parse.ts covering edge cases. Create the test file and run it." },
  { "title": "docs",   "task": "Read src/util/parse.ts and write a concise API reference in markdown to docs/parse.md." }
]
</tasks>
</delegate_task>
`;

/** Tool-protocol text for `delegate_task`, appended to the orchestrator's tool prompt. */
export function buildDelegateToolPrompt(): string {
  return DELEGATE_TOOL_PROMPT_TEXT;
}

export interface DelegatedTaskSpec {
  title: string;
  task: string;
  model?: string;
}

const MAX_PARALLEL_TASKS = 8;

/** Parse the `tasks` parameter into task specs; tolerates JSON arrays or newline/bullet lists. */
export function parseDelegatedTasks(raw: string): { specs: DelegatedTaskSpec[]; error?: string } {
  const text = (raw || '').trim();
  if (!text) { return { specs: [], error: 'empty tasks parameter' }; }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const specs: DelegatedTaskSpec[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (typeof item === 'string') {
          if (item.trim()) { specs.push({ title: `task-${i + 1}`, task: item.trim() }); }
        } else if (item && typeof item === 'object') {
          const task = String((item as Record<string, unknown>).task || '').trim();
          if (!task) { continue; }
          const title = String((item as Record<string, unknown>).title || `task-${i + 1}`).trim() || `task-${i + 1}`;
          const modelRaw = (item as Record<string, unknown>).model;
          const model = typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : undefined;
          specs.push({ title, task, model });
        }
      }
      return { specs: specs.slice(0, MAX_PARALLEL_TASKS) };
    }
  } catch { /* fall through to line parsing */ }

  const lines = text
    .split('\n')
    .map(l => l.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
    .filter(l => l.length > 0);
  if (lines.length === 0) {
    return { specs: [], error: 'could not parse tasks (expected a JSON array of {title,task} objects)' };
  }
  const specs = lines.slice(0, MAX_PARALLEL_TASKS).map((l, i) => ({ title: `task-${i + 1}`, task: l }));
  return { specs };
}

/** Static body of the sub-agent system prompt (workspace context + tool protocol appended at runtime). */
const SUB_AGENT_PROMPT_BODY = `# QGENIE SUB-AGENT

You are an autonomous QGenie sub-agent dispatched by an orchestrator to
complete ONE specific task. You have the full coding tool set. You run in
isolation — you cannot see the orchestrator's conversation or the other
sub-agents, only the task handed to you.

OPERATING RULES
- Ground everything in the codebase: read before you claim, read before
  you edit. Never fabricate file contents or APIs.
- Make the smallest correct change. Don't touch anything outside your
  task's scope.
- Use replace_in_file for edits to existing files; write_file only for
  new files or full rewrites.
- When the task is complete, STOP calling tools and write a concise
  FINAL REPORT as plain prose: what you did, what you found, file:line
  references, and anything the orchestrator needs to integrate your work.

## CRITICAL: HOW THE ORCHESTRATOR RECEIVES YOUR REPORT

The orchestrator does NOT see your tool calls, your live reasoning, or
any hidden-reasoning / scratchpad XML blocks you may emit. It receives
ONE thing: the plain-prose text of your LAST assistant message, with
hidden-reasoning blocks STRIPPED OUT. That stripped prose IS your report.
There is no other channel.

Therefore — these are HARD requirements, the runtime enforces them and
will nudge you up to 5 times if you violate them. After the 5th nudge
the orchestrator marks your report [INCOMPLETE] and may re-delegate.

1. Your final turn MUST contain real prose OUTSIDE any hidden-reasoning
   tag. A turn that is only a scratchpad/thinking block, only whitespace,
   or under ~40 characters of real prose is treated as "no report
   produced" and you will be nudged to try again.
2. NEVER end on an intent-announcement sentence like "Let me read X.",
   "Now let me check Y.", "I'll batch the remaining searches.", "I need
   to verify Z." — REGARDLESS of whether you terminate with a period or
   not. The runtime detects intent phrases at the end of your turn and
   treats them as a stalled-mid-task narration, NOT as a final report.
   Either emit the tool tag for that next action NOW (one tool call,
   nothing before it), or write the real report — never narrate intent
   and stop. This is the #1 reason sub-agents get marked [INCOMPLETE].
3. NEVER produce a "final report" that is just a one- or two-sentence
   acknowledgment ("Good — X is used. Let me batch the rest."). Reports
   under ~300 characters with zero tool calls are flagged as INCOMPLETE
   regardless of phrasing — they look like stalled progress updates,
   not findings.
4. The report should be self-contained. Assume the orchestrator has ZERO
   context and cannot see anything you did. Restate the task in one
   line, list what you did, list your findings with concrete file:line
   references, and flag any caveats. Aim for 100–600 words of useful
   content — not a one-liner, not a wall of irrelevant prose.
5. Plain prose / markdown is fine. Do NOT put tool tags in the final
   report (the runtime will not execute them at that point anyway).

## BATCHING TOOL CALLS

You can only emit ONE tool tag per assistant message. To do many things
fast, BATCH inside a single tool where the tool supports it:
- replace_in_file: stack multiple SEARCH/REPLACE blocks in one <diff> body.
- search_files: write a regex that matches ALL the patterns you need
  (alternation: \`pattern1|pattern2|pattern3\`).
- execute_command: combine multi-step shell logic (\`grep X file1 && grep Y file2\`).
Do NOT chain "I'll first do A, then B, then C" prose — emit the broadest
tool call you can, then react to the result.
`;

/** Builds the sub-agent system prompt with workspace context and tool protocol. */
function buildSubAgentSystemPrompt(wsCtx: string, toolsPrompt: string): string {
  return SUB_AGENT_PROMPT_BODY + wsCtx + toolsPrompt;
}


// RULE 1: never write the literal contiguous hidden-reasoning tag pair in source — the runtime
// pre-processor strips it. Build from concatenation (canonical exemplar). See OPERATING RULES.
const HR_OPEN  = '<' + 'thinking>';
const HR_CLOSE = '</' + 'thinking>';

/** Strips hidden-reasoning blocks from a model turn; tolerant of multiple blocks, mixed casing,
 *  and orphan open/close tags from a cut-off stream. */
function stripThinkingTags(text: string): string {
  if (!text) { return ''; }
  if (!text.includes('<')) { return text; }
  // Single pass: removes well-formed blocks AND an orphan open tag (open-to-end-of-string).
  const TAG_GROUP = '(?:thinking|thought|reasoning|think)';
  const blockOrOrphanOpenRe = new RegExp('<' + TAG_GROUP + '\\b[^>]*>[\\s\\S]*?(?:<\\/' + TAG_GROUP + '\\s*>|$)', 'gi');
  const orphanCloseRe = new RegExp('^[\\s\\S]*?<\\/' + TAG_GROUP + '\\s*>', 'i');
  let out = text.replace(blockOrOrphanOpenRe, '').replace(orphanCloseRe, '');
  void HR_OPEN; void HR_CLOSE; // suppress unused-variable warnings
  return out.trim();
}


/** Intent-announcement phrases signalling a stalled mid-task narration; governs both
 *  `looksUnfinished` and the report-quality check. */
const INTENT_PHRASE_RE =
  /^\s*(?:let me|let's|now (?:i|let)|i'?ll|i will|next[,:]?|then i|going to|i need to|i should|first[,:]?|i (?:can|should|might|may|want to)|i'?m going to|i'?m about to|let me batch|let me check|let me verify|let me read|let me search|let me look)/i;

function looksUnfinished(text: string): boolean {
  // Strip hidden-reasoning blocks first; only prose OUTSIDE them matters.
  const t = stripThinkingTags(text || '');
  // Empty after stripping → round was empty or 100% hidden reasoning.
  if (t.length === 0) { return true; }
  // Microscopic answers are almost never a real report; nudge the agent.
  if (t.length < 40) { return true; }
  // Trailing "to be continued" punctuation with no closing substance.
  if (/[:…]$/.test(t) || /\.\.\.$/.test(t)) { return true; }
  // Split on sentence terminators so intent phrases ending with "." are
  // caught too (the old `[^.!?]*$` regex missed those).
  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const last = sentences[sentences.length - 1] || t;
  if (INTENT_PHRASE_RE.test(last)) { return true; }
  return false;
}

/** Build the nudge message sent to a sub-agent whose last turn was incomplete. */
function buildNudgeMessage(
  reason: 'thinkingOnly' | 'tooShort' | 'unfinished',
  nudgeCount: number,
  maxNudges: number,
  charCount: number,
): string {
  switch (reason) {
    case 'thinkingOnly':
      return (
        `[SYSTEM] Your last turn contained ONLY hidden-reasoning content (a ` +
        `scratchpad/thinking block) and produced no prose for the orchestrator. ` +
        `That content is INVISIBLE to the orchestrator — it is dropped before your ` +
        `report is delivered. You MUST emit either (a) the single next tool tag, ` +
        `or (b) a real FINAL REPORT in plain prose OUTSIDE any thinking-style ` +
        `tags. The report should restate the task in one line, then list what you ` +
        `did and what you found with concrete file:line references — aim for ` +
        `100–600 words. Do NOT produce another thinking-only turn.`
      );
    case 'tooShort':
      return (
        `[SYSTEM] Your last turn produced almost no prose (${charCount} ` +
        `chars after stripping hidden-reasoning blocks). The orchestrator needs a ` +
        `real FINAL REPORT, not a one-liner. Write 100–600 words: restate the ` +
        `task, list what you did, give findings with file:line references, and ` +
        `flag any caveats. Or, if you still need to act, emit the next tool tag.`
      );
    case 'unfinished':
      return (
        `[SYSTEM] STALLED — your last turn announced an action ("let me…", ` +
        `"I'll…", "I need to…", "next…", etc.) but emitted NO tool call. This ` +
        `pattern keeps tripping the orchestrator's incomplete-report detector. ` +
        `You have TWO choices, no third option:\n` +
        `  (A) ACT — emit the SINGLE next tool tag NOW. One tool tag, nothing ` +
        `      before it (no preamble, no "ok let me…", no recap). The runtime ` +
        `      parses ONLY the first tool tag in your message; chatter before ` +
        `      it is wasted tokens. To do many checks fast, batch them: write ` +
        `      one search_files regex with alternation (\`A|B|C\`) instead of ` +
        `      three sequential greps; stack multiple SEARCH/REPLACE blocks ` +
        `      inside ONE replace_in_file <diff>; combine shell logic in one ` +
        `      execute_command.\n` +
        `  (B) FINISH — write your FINAL REPORT now as plain prose, 100–600 ` +
        `      words. Restate the task, list what you did, list findings with ` +
        `      file:line references, flag caveats. NO intent phrases, NO "let ` +
        `      me wrap up", NO "I'll summarize" — just the report itself.\n` +
        `Nudge ${nudgeCount}/${maxNudges}. After the final nudge your ` +
        `incomplete output is marked [INCOMPLETE] and may be re-delegated.`
      );
  }
}

/** Assemble the final text for a sub-agent result (uses early returns for clarity). */
function assembleFinalText(
  cleaned: string,
  isStalledFinal: boolean,
  errorText: string | undefined,
  toolCalls: number,
  nudges: number,
): string {
  if (cleaned && !isStalledFinal) { return cleaned; }
  if (cleaned && isStalledFinal) {
    return (
      `[INCOMPLETE — sub-agent ran out of nudge budget without producing a substantive final report. ` +
      `${toolCalls === 0 ? 'It made NO tool calls at all. ' : `It made ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}. `}` +
      `Re-delegate this task with an even tighter "you MUST write 200+ words of concrete findings with file:line references; do NOT narrate intent" instruction. The fragment it produced is below.]\n\n` +
      cleaned
    );
  }
  if (errorText) { return `(sub-agent failed: ${errorText})`; }
  if (toolCalls > 0) {
    return (
      `(sub-agent completed ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} but produced no ` +
      `prose final report after ${nudges} nudge${nudges === 1 ? '' : 's'}. ` +
      `The tool calls themselves succeeded — see the orchestrator's tool-execution log ` +
      `for what was done. Treat as PARTIAL success and consider re-delegating with a ` +
      `tighter "write 200 words summarizing your findings" instruction.)`
    );
  }
  return '(sub-agent produced no final report and made no tool calls — likely a model error)';
}

/** Run a single sub-agent to completion; reuses the same streaming + XML-tool execution path. */
export async function runSubAgent(opts: RunSubAgentOptions): Promise<SubAgentResult> {
  const { agentId, title, task, model, config, signal, progress, onApproval } = opts;
  // Bumped 24→36: audit tasks need many small read/grep rounds; the old cap
  // forced premature termination on multi-file investigations.
  const maxIterations = opts.maxIterations ?? 36;
  // Per-agent wall-clock budget: bound total time across all rounds so a
  // wedged sub-agent cannot block the pool indefinitely.
  const startedAt = Date.now();

  // Inject the same workspace context the main session uses; previously
  // omitted, leaving sub-agents blind to open folders and platform/shell.
  const wsCtx = buildWorkspaceContext();
  const toolsPrompt = buildToolPrompt();
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSubAgentSystemPrompt(wsCtx, toolsPrompt) },
    { role: 'user', content: task },
  ];

  const SUBAGENT_MAX_TOKENS_FLOOR = 24000;
  const subMaxTokens = Math.max(config.maxTokens || 0, SUBAGENT_MAX_TOKENS_FLOOR);
  const subConfig: QGenieConfig = { ...config, model: model || config.model, maxTokens: subMaxTokens };

  progress.onStart?.(agentId, title, task);


  let toolCalls = 0;
  let nudges = 0;
  let transientRetries = 0;
  // Bumped 3→5: sub-agents often need 2-3 nudges to stop narrating and
  // emit a real report; 3 was too few and accepted stalled one-liners.
  const MAX_CONSECUTIVE_NUDGES = 5;
  // Same transient-error retry budget as the main session; previously a
  // single socket hangup would kill the sub-agent outright.
  const MAX_TRANSIENT_RETRIES = 3;

  let lastText = '';
  let errorText: string | undefined;
  // Aggregator for handling token-limit truncation. When a round ends with
  // finish_reason='length' we issue ONE continuation request and accumulate
  // the partial+continuation text, so unfinished/quality checks operate on
  // the FULL logical turn. Reset on every successful tool call.
  let aggregateText = '';
  let continuationsUsed = 0;
  const MAX_CONTINUATIONS = 1;

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      if (signal.aborted) { errorText = 'cancelled'; break; }
      // Per-agent wall-clock deadline: stop a sub-agent that has run too long
      // across all its rounds so it cannot wedge the concurrency pool.
      if (Date.now() - startedAt > SUBAGENT_DEADLINE_MS) { errorText = 'timeout'; break; }

      let round: { text: string; tool?: { name: string; params: Record<string, string> }; error?: string; finishReason?: string };
      try {
        round = await streamSubAgentRound(agentId, messages, subConfig, signal, progress);
      } catch (err: unknown) {
        // Only network/stream errors should land here; the round function
        // already captures model errors in round.error. If we get a throw,
        // it's likely a code bug or unhandled exception — log it and bail.
        errorText = err instanceof Error ? err.message : String(err);
        break;
      }
      if (round.error) {
        // Retry transient errors (network/503) with backoff; hard errors
        // (auth, bad request, user-abort) fall through immediately.
        const retryable = !signal.aborted
          && isTransientStreamError(round.error)
          && transientRetries < MAX_TRANSIENT_RETRIES;
        if (retryable) {
          transientRetries++;
          const backoffMs = 500 * Math.pow(2, transientRetries - 1); // 0.5s, 1s, 2s
          progress.onDelta?.(
            agentId,
            `\n[transient stream error — retry ${transientRetries}/${MAX_TRANSIENT_RETRIES} in ${Math.round(backoffMs / 100) / 10}s: ${round.error}]\n`,
          );
          await new Promise<void>((r) => setTimeout(r, backoffMs));
          iter--; // this round didn't count — try again
          continue;
        }
        errorText = round.error;
        break;
      }
      transientRetries = 0;

      if (round.text) {
        messages.push({ role: 'assistant', content: round.text });
        aggregateText += round.text;
        lastText = aggregateText;
      }

      if (!round.tool) {
        const wasTruncated = round.finishReason === 'length';
        const cleanedNow = stripThinkingTags(aggregateText);

        if (wasTruncated && continuationsUsed < MAX_CONTINUATIONS && !signal.aborted) {
          continuationsUsed++;
          messages.push({
            role: 'user',
            content:
              '[CONTINUATION] Your previous response hit the token limit and was '
              + 'cut off mid-sentence. CONTINUE writing from EXACTLY where you '
              + 'stopped: do NOT restart, do NOT re-summarize anything you already '
              + 'wrote. Pick up at the next character/word and finish the report. '
              + 'Aim for under ~400 more words so this continuation also fits.',
          });
          continue;
        }

        if (wasTruncated && cleanedNow.length >= 200) {
          lastText = '[TRUNCATED at token limit; sub-agent report is partial]\n\n' + cleanedNow;
          break;
        }

        if (looksUnfinished(aggregateText) && nudges < MAX_CONSECUTIVE_NUDGES) {
          nudges++;
          const reason: 'thinkingOnly' | 'tooShort' | 'unfinished' =
            (cleanedNow.length === 0 && aggregateText.trim().length > 0) ? 'thinkingOnly'
            : cleanedNow.length < 40 ? 'tooShort'
            : 'unfinished';
          messages.push({ role: 'user', content: buildNudgeMessage(reason, nudges, MAX_CONSECUTIVE_NUDGES, cleanedNow.length) });
          continue;
        }
        if (cleanedNow) { lastText = cleanedNow; }
        break;
      }

      const toolName = round.tool.name;
      const args = coerceToolArgs(toolName, round.tool.params);
      const inputDisplay = Object.entries(args)
        .map(([k, v]) => `${k}: ${typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : JSON.stringify(v)}`)
        .join('\n');

      if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
        const ok = await onApproval(agentId, title, toolName, args);
        if (!ok || signal.aborted) {
          const out = 'User denied this operation.';
          progress.onTool?.(agentId, toolName, inputDisplay, out, true);
          messages.push({ role: 'user', content: `[tool ${toolName} result]\n${out}` });
          continue;
        }
      }

      // Pass signal so long-running tools (execute_command) can be cancelled;
      // previously omitted, so sub-agent tool calls ignored user Stop.
      // ctx.agentId routes execute_command through the per-sub-agent
      // terminal registry in agentTools.ts (no shared terminal, no
      // shell-integration queue contention). The terminal is reaped at
      // run-loop exit by disposeAgentTerminal() below.
      const result = await executeTool(toolName, args, signal, { agentId }) as { success: boolean; output: string; diffData?: unknown };
      toolCalls++;
      nudges = 0; // made progress, reset the stall counter
      aggregateText = '';
      continuationsUsed = 0;
      progress.onTool?.(agentId, toolName, inputDisplay, result.output, !result.success);

      const reminder = NO_ECHO_TOOLS.has(toolName)
        ? '\n\n[SYSTEM REMINDER: tool output already recorded — do not echo it. Continue or write your final report.]'
        : '';
      messages.push({ role: 'user', content: `[tool ${toolName} result]\n${result.output}${reminder}` });
    }
  } catch (err: unknown) {
    errorText = err instanceof Error ? err.message : String(err);
  }

  // Final cleanup: strip any hidden-reasoning content that leaked into
  // `lastText` even after nudge budget was exhausted.
  const cleaned = stripThinkingTags(lastText).trim();
  const ok = !errorText;

  // If the loop exited naturally but the text still looks unfinished,
  // prepend [INCOMPLETE] so the orchestrator can decide to re-delegate.
  const isStalledFinal =
    !errorText &&
    cleaned.length > 0 &&
    (looksUnfinished(cleaned) || (toolCalls === 0 && cleaned.length < 300));

  const finalText = assembleFinalText(cleaned, isStalledFinal, errorText, toolCalls, nudges);

  // A stalled-but-non-empty final still counts as not-OK so the
  // orchestrator's visible status flips to FAILED and the user sees it.
  const finalOk = ok && !isStalledFinal;
  progress.onDone?.(agentId, finalText, finalOk);

  // Tear down this sub-agent's dedicated execute_command terminal (if
  // one was ever created). Done at run-loop exit so the terminal is
  // reaped even if the agent never wrote to it; safe no-op when this
  // sub-agent never called execute_command.
  disposeAgentTerminal(agentId);

  return { agentId, title, task, finalText, ok: finalOk, toolCalls, error: errorText };
}

/** Stream one round of a sub-agent: feed deltas to the XML parser and detect the invoked tool. */
function streamSubAgentRound(
  agentId: string,
  messages: ChatMessage[],
  config: QGenieConfig,
  signal: AbortSignal,
  progress: SubAgentProgress,
): Promise<{ text: string; tool?: { name: string; params: Record<string, string> }; error?: string; finishReason?: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let error: string | undefined;
    let finishReason: string | undefined;
    let invokedTool: { name: string; params: Record<string, string> } | undefined;

    const parser = new XmlToolParser(SUBAGENT_TOOL_SCHEMA, {
      onSpeech: (t) => {
        chunks.push(t);
        if (t) { progress.onDelta?.(agentId, t); }
      },
      onToolEnd: (toolName, params) => {
        if (!invokedTool) { invokedTool = { name: toolName, params }; }
      },
    });

    const carry: ThinkingCarry = { buf: '', inThinking: false, expectedClose: '' };
    const onOutside = (s: string) => { if (s) { parser.feed(s); } };
    const noop = () => { /* swallow thinking */ };

    streamChatCompletion(
      messages,
      config,
      (chunk) => {
        if (chunk.error) { error = chunk.error; }
        if (chunk.finishReason) { finishReason = chunk.finishReason; }
        if (chunk.done) {
          flushSplitter(carry, onOutside, noop, noop);
          parser.end();
          const text = chunks.join('');
          resolve({ text, tool: invokedTool, error, finishReason });
          return;
        }
        if (chunk.delta) {
          splitThinkingChunks(carry, chunk.delta, onOutside, noop, noop, noop);
        }
      },
      signal,
    );
  });
}

export interface RunDelegatedTasksOptions {
  specs: DelegatedTaskSpec[];
  defaultModel: string;
  config: QGenieConfig;
  signal: AbortSignal;
  progress: SubAgentProgress;
  onApproval: (agentId: string, title: string, toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Generate a unique id for each spawned sub-agent. */
  makeId: (index: number, title: string) => string;
}

/** Run every task spec in parallel; returns an aggregated text blob for the `delegate_task` result. */
export async function runDelegatedTasks(opts: RunDelegatedTasksOptions): Promise<string> {
  const { specs, defaultModel, config, signal, progress, onApproval, makeId } = opts;

  // Bounded concurrency: at most MAX_CONCURRENT_SUBAGENTS run at once, and
  // each is captured as a settled result so one crash never discards the
  // siblings' reports.
  const settled = await runPool<SubAgentResult>(
    specs,
    MAX_CONCURRENT_SUBAGENTS,
    (spec, i) =>
      runSubAgent({
        agentId: makeId(i, spec.title),
        title: spec.title,
        task: spec.task,
        model: spec.model || defaultModel,
        config,
        signal,
        progress,
        onApproval,
      }),
  );

  const results: SubAgentResult[] = settled.map((res, i) => {
    if (res.status === 'fulfilled') { return res.value; }
    // Synthesize a FAILED result so a thrown sub-agent still appears in the
    // aggregated report with the same shape as the success path.
    const spec = specs[i];
    const errMsg = String(res.reason instanceof Error ? res.reason.message : res.reason);
    return {
      agentId: makeId(i, spec.title),
      title: spec.title,
      task: spec.task,
      finalText: `(sub-agent failed: ${errMsg})`,
      ok: false,
      toolCalls: 0,
      error: errMsg,
    };
  });

  const okCount = results.filter(r => r.ok).length;
  const header =
    `[delegate_task result] ${results.length} sub-agent${results.length === 1 ? '' : 's'} finished ` +
    `(${okCount} ok, ${results.length - okCount} failed). Their final reports follow. ` +
    `Synthesize them into your answer — do not just concatenate.\n`;

  const sections = results.map((r, i) => {
    const status = r.ok ? 'OK' : `FAILED${r.error ? ` (${r.error})` : ''}`;
    return (
      `\n──────── SUB-AGENT #${i + 1} [${r.title}] — ${status}, ${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'} ────────\n` +
      `TASK: ${r.task}\n\n` +
      `REPORT:\n${r.finalText}\n`
    );
  });

  return header + sections.join('\n');
}
