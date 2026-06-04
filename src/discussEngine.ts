// File: /usr2/ashwv/nexus-skills/src/discussEngine.ts
// discussEngine.ts — multi-agent "Discuss" engine with a live Shared Message
// Channel (SMC).
//
// Several role-specialised AI agents (Planner, Coder, Reviewer, optionally
// Researcher) debate a user's problem over a number of rounds using the REAL
// LLM, then a Synthesizer converges on a final consolidated solution.
//
// LIVE COMMUNICATION (the upgrade):
//   Previously each agent produced a FULL response in isolation and the next
//   agent only saw COMPLETED messages. Now every agent turn is STREAMED, its
//   hidden reasoning ("thinking") is separated from its answer with the shared
//   thinkingSplitter, and BOTH are broadcast live over a SharedMessageChannel
//   (SMC). Peer agents therefore see each other's *thinking as it happens* and
//   may post short live INTERJECTIONS that the active/next agent reacts to.
//
// Each agent is the SAME underlying model with a different system prompt.
// The engine reuses the existing streaming LLM client from ./qgenieApi — it
// does NOT reimplement any HTTP.

import {
  loadQGenieConfig,
  streamChatCompletion,
  ChatMessage,
  StreamChunk,
} from './qgenieApi';
import {
  splitThinkingChunks,
  flushSplitter,
  ThinkingCarry,
} from './thinkingSplitter';

/** Cap (in chars) applied to each prior message fed back into a prompt, so the
 *  transcript stays compact even over many rounds. */
const TRANSCRIPT_MSG_CAP = 800;

/** Cap (in chars) applied to the live thinking we replay into peers' prompts. */
const THINKING_CONTEXT_CAP = 600;

/** Roles included by default when `DiscussConfig.agents` is omitted. */
const DEFAULT_AGENTS: string[] = ['planner', 'coder', 'reviewer'];
/** Delay (ms) between successive agents' OPENING turns, so the live channel
 *  fills incrementally instead of N simultaneous cold-starts. */
const STAGGER_MS = 400;

/** Max time (ms) an agent waits for a peer to add new channel activity before
 *  it goes ahead and speaks again — prevents a quiet channel from deadlocking. */
const LISTEN_TIMEOUT_MS = 8000;

/** Poll interval (ms) used while listening for peer activity. */
const POLL_MS = 120;

/**
 * Mutable state shared across all concurrent agent loops. Because agents run
 * overlapping (no discrete rounds), this is the single source of truth for the
 * global budget and convergence; loops read/write it directly.
 */
interface ConvState {
  /** Utterances spoken so far across ALL agents (claimed before each turn). */
  utterances: number;
  /** Global utterance budget (== maxRounds * number of agents). */
  maxUtterances: number;
  /** Set true once convergence is detected (e.g. Reviewer APPROVE). */
  converged: boolean;
  /** Human-readable convergence reason for the final event. */
  reason: string;
  /** Monotonic id handed out per utterance for stable transcript ordering. */
  nextTurnId: number;
  /** Whether live cross-talk is enabled (carried from DiscussConfig.liveChat). */
  liveChat: boolean;
}



// ── Role system prompts ──────────────────────────────────────────────────────

const PLANNER_PROMPT =
  'You are the PLANNER on a collaborative engineering team. Decompose the ' +
  "problem into a concrete, ordered plan: list the steps, the key decisions, " +
  'and the acceptance criteria. Be specific and actionable. Do not write the ' +
  'full implementation — leave that to the Coder.';

const CODER_PROMPT =
  'You are the CODER on a collaborative engineering team. Propose or refine a ' +
  'concrete implementation that satisfies the plan and addresses any prior ' +
  'critique. Include code blocks where relevant. Be precise; prefer correct, ' +
  'complete code over prose.';

const REVIEWER_PROMPT =
  'You are the REVIEWER on a collaborative engineering team. Critique the ' +
  'latest proposal for correctness, completeness, edge cases, and quality. If ' +
  'the proposal is correct and complete and you have no further changes, reply ' +
  'with the single word APPROVE on its own line. Otherwise, give specific, ' +
  'actionable critique that the Coder can act on in the next round.';

const RESEARCHER_PROMPT =
  'You are the RESEARCHER on a collaborative engineering team. Surface ' +
  'relevant facts, prior art, library/API options, and edge cases the rest of ' +
  'the team should account for. Be concise and cite concrete specifics.';

const SYNTHESIZER_PROMPT =
  'You are the SYNTHESIZER / Lead on a collaborative engineering team. Read ' +
  'the full debate transcript and produce the final, consolidated solution the ' +
  'team agreed on. Resolve any remaining disagreements, fold in the accepted ' +
  'critique, and present a single clean answer (with complete code blocks where ' +
  'relevant). Do not narrate the debate — output only the final solution.';

/** Shared instruction appended to every agent so they actually USE the channel. */
const SMC_PROTOCOL =
  '\n\nLIVE TEAM CHANNEL: Your teammates can see your reasoning as you think, ' +
  'and you can see theirs (including their live thinking and any short ' +
  'interjections). Build on what they are working through right now; address ' +
  'their interjections by name when relevant. Think out loud inside ' +
  ' — that reasoning is broadcast live to the team.';

/** Map a role key to its tailored system prompt and a human display label. */
function roleInfo(role: string): { prompt: string; label: string } {
  switch (role.toLowerCase()) {
    case 'planner':
      return { prompt: PLANNER_PROMPT, label: 'Planner' };
    case 'coder':
      return { prompt: CODER_PROMPT, label: 'Coder' };
    case 'reviewer':
      return { prompt: REVIEWER_PROMPT, label: 'Reviewer' };
    case 'researcher':
      return { prompt: RESEARCHER_PROMPT, label: 'Researcher' };
    default:
      // Unknown role — fall back to a generic contributor prompt.
      return {
        prompt:
          'You are a contributor on a collaborative engineering team. Help ' +
          'advance the discussion toward a correct, complete solution.',
        label: role.charAt(0).toUpperCase() + role.slice(1),
      };
  }
}

// ── Public types ─────────────────────────────────────────────────────────────

/** One entry in the running debate transcript. */
interface TranscriptEntry {
  round: number;
  role: string;
  agent: string;
  content: string;
}

/**
 * Discriminated union of events the engine streams to a listener so the UI can
 * render the debate live. Discriminated on the `type` field.
 */
export type DiscussEvent =
  | { type: 'roundStart'; round: number; total: number }
  | { type: 'agentStart'; round: number; agent: string; role: string }
  | { type: 'agentDelta'; round: number; agent: string; role: string; channel: 'thinking' | 'answer'; delta: string }
  | { type: 'agentMessage'; round: number; agent: string; role: string; content: string }
  | { type: 'interjection'; round: number; from: string; fromRole: string; to: string; content: string }
  | { type: 'converged'; round: number; reason: string }
  | { type: 'final'; solution: string }
  | { type: 'error'; message: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number };

/** Configuration for one Discuss run. */
export interface DiscussConfig {
  task: string;
  model: string;
  maxRounds: number;
  /** Which role agents to include; defaults to ['planner','coder','reviewer']. */
  agents?: string[];
  /** When true (default), agents broadcast live thinking + may interject. */
  liveChat?: boolean;
}

// ── Shared Message Channel (SMC) ─────────────────────────────────────────────

/** A single broadcast on the shared channel. `thinking`/`content` accumulate
 *  live as the owning agent streams. */
interface SmcMessage {
  round: number;
  role: string;
  agent: string;
  kind: 'turn' | 'interjection';
  thinking: string;
  content: string;
}

/**
 * SharedMessageChannel — the lightweight pub/sub blackboard every agent reads
 * from and writes to. It is the "framework" that lets agents communicate while
 * thinking: an agent appends its live thinking/answer here, subscribers (the
 * engine, for context-building and event emission) react in real time, and the
 * next agent's prompt is built from a live snapshot.
 */
class SharedMessageChannel {
  private log: SmcMessage[] = [];
  private subs: Array<(m: SmcMessage, deltaKind: 'create' | 'thinking' | 'answer') => void> = [];

  subscribe(cb: (m: SmcMessage, deltaKind: 'create' | 'thinking' | 'answer') => void): void {
    this.subs.push(cb);
  }

  /** Open a new message on the channel and return a handle to stream into it. */
  open(round: number, role: string, agent: string, kind: 'turn' | 'interjection'): SmcMessage {
    const m: SmcMessage = { round, role, agent, kind, thinking: '', content: '' };
    this.log.push(m);
    this.subs.forEach((s) => s(m, 'create'));
    return m;
  }

  appendThinking(m: SmcMessage, delta: string): void {
    m.thinking += delta;
    this.subs.forEach((s) => s(m, 'thinking'));
  }

  appendAnswer(m: SmcMessage, delta: string): void {
    m.content += delta;
    this.subs.forEach((s) => s(m, 'answer'));
  }

  snapshot(): SmcMessage[] {
    return this.log.slice();
  }

  /**
   * Render the live channel for a peer's prompt: includes both the answer and a
   * capped slice of live thinking, plus any interjections, so an agent can
   * "communicate while thinking".
   */
  render(): string {
    if (this.log.length === 0) { return ''; }
    return this.log
      .map((m) => {
        if (m.kind === 'interjection') {
          const c = m.content.trim();
          return '» ' + m.agent + ' (live note, r' + m.round + '): ' + c;
        }
        const parts: string[] = [];
        let answer = m.content.trim();
        if (answer.length > TRANSCRIPT_MSG_CAP) {
          answer = answer.slice(0, TRANSCRIPT_MSG_CAP) + '… [truncated]';
        }
        let thinking = m.thinking.trim();
        if (thinking) {
          if (thinking.length > THINKING_CONTEXT_CAP) {
            thinking = thinking.slice(0, THINKING_CONTEXT_CAP) + '… [truncated]';
          }
          parts.push('(thinking) ' + thinking);
        }
        if (answer) { parts.push(answer); }
        return '[Round ' + m.round + ' — ' + m.agent + ']\n' + parts.join('\n');
      })
      .join('\n\n');
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class DiscussEngine {
  /** The SharedMessageChannel of the currently-active run (null when idle). */
  private _activeSmc: SharedMessageChannel | null = null;

  constructor(private emit: (e: DiscussEvent) => void) {}

  /** Inject a live user/director message into the running discussion so every agent sees it on their next turn. Safe to call when no run is active (no-op). */
  public injectUserMessage(text: string): void {
    const clean = (text || '').trim();
    if (!clean || !this._activeSmc) { return; }
    const m = this._activeSmc.open(0, 'user', 'You', 'interjection');
    this._activeSmc.appendAnswer(m, 'DIRECTOR (live user instruction): ' + clean);
  }

  /**
   * Run the debate loop and return the final synthesised solution string.
   * Honors `signal`: if aborted between agent turns, stops the loop and
   * returns the best-so-far synthesis (or transcript fallback).
   */
  async run(cfg: DiscussConfig, signal?: AbortSignal): Promise<string> {
    const transcript: TranscriptEntry[] = [];
    const roles = (cfg.agents && cfg.agents.length > 0 ? cfg.agents : DEFAULT_AGENTS);
    const total = Math.max(1, cfg.maxRounds);
    const liveChat = cfg.liveChat !== false;
    const smc = new SharedMessageChannel();
    this._activeSmc = smc;

    try {
      this.emit({ type: 'roundStart', round: 1, total });

      // Shared, mutable conversation state across all concurrent agent loops.
      // There are no discrete "rounds" anymore: every agent runs its own
      // listen<->talk loop, all overlapping. `nextTurnId` hands out a unique,
      // monotonically increasing id per utterance so the UI/transcript keep a
      // stable ordering; `utterances`/`maxUtterances` form the global budget.
      const state: ConvState = {
        utterances: 0,
        maxUtterances: total * roles.length,
        converged: false,
        reason: '',
        nextTurnId: 0,
        liveChat,
      };

      // Launch EVERY agent at once. They speak, listen to peers via the live
      // shared channel, and loop until convergence or the budget runs out.
      await Promise.all(
        roles.map((role, i) =>
          this.runAgentLoop(cfg, role, smc, state, transcript, i, signal),
        ),
      );

      const reason = signal?.aborted
        ? 'aborted'
        : state.reason ||
          (state.utterances >= state.maxUtterances
            ? 'conversation budget reached'
            : 'discussion settled');
      this.emit({ type: 'converged', round: state.nextTurnId || 1, reason });

      // One synthesis call over the whole transcript.
      const synthPrompt = this.buildSynthesisPrompt(cfg.task, transcript);
      let solution: string;
      if (signal?.aborted) {
        // Aborted: return best-so-far without a fresh LLM call.
        solution = this.bestSoFar(transcript);
      } else {
        solution = await this.complete(SYNTHESIZER_PROMPT, synthPrompt, cfg.model, signal);
        if (!solution.trim()) { solution = this.bestSoFar(transcript); }
      }

      this.emit({ type: 'final', solution });
      return solution;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', message });
      // Return best-so-far so callers still get something usable.
      return this.bestSoFar(transcript);
    } finally {
      this._activeSmc = null;
    }
  }

  /**
   * One agent's full life: a listen<->talk loop that overlaps with every other
   * agent's loop. The agent speaks, then waits for peers to add something to the
   * live channel (so it's reacting to fresh context rather than monologuing),
   * then speaks again — until the discussion converges or the shared budget is
   * exhausted. All loops share the same mutable `state`.
   *
   * `index` staggers the very first utterance so the agents don't all fire their
   * opening turn on the exact same tick.
   */
  private async runAgentLoop(
    cfg: DiscussConfig,
    role: string,
    smc: SharedMessageChannel,
    state: ConvState,
    transcript: TranscriptEntry[],
    index: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const info = roleInfo(role);
    const agent = info.label;

    // Stagger openings so the channel fills incrementally instead of N
    // simultaneous cold-start turns.
    if (index > 0) {
      await this.sleep(index * STAGGER_MS, signal);
    }

    while (!this.shouldStop(state, signal)) {
      // Claim a slot in the global budget up-front so concurrent loops can't
      // collectively overshoot maxUtterances.
      if (state.utterances >= state.maxUtterances) { break; }
      state.utterances++;
      const turnId = ++state.nextTurnId;

      this.emit({ type: 'agentStart', round: turnId, agent, role });

      const finalContent = await this.speakOnce(cfg, role, info, smc, turnId, signal);

      const entry: TranscriptEntry = { round: turnId, role, agent, content: finalContent };
      transcript.push(entry);
      this.emit({ type: 'agentMessage', round: turnId, agent, role, content: finalContent });

      // Convergence check after each utterance (any loop can trip it).
      if (role.toLowerCase() === 'reviewer' && /\bapprove\b/i.test(finalContent)) {
        if (!state.converged) {
          state.converged = true;
          state.reason = 'Reviewer approved the proposal';
        }
      }
      if (this.shouldStop(state, signal)) { break; }

      // Listen: wait for at least one peer to contribute (new channel activity)
      // before talking again, so this agent reacts to fresh context. Bounded by
      // a timeout so a quiet channel doesn't deadlock the loop.
      await this.waitForActivity(transcript, signal);
    }
  }

  /**
   * Stream a single turn for `role` into the shared channel, broadcasting hidden
   * reasoning and the answer live, and return the final answer text.
   */
  private async speakOnce(
    cfg: DiscussConfig,
    role: string,
    info: ReturnType<typeof roleInfo>,
    smc: SharedMessageChannel,
    turnId: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const agent = info.label;
    const userPrompt = this.buildUserPrompt(cfg.task, smc, info.label);
    const msg = smc.open(turnId, role, agent, 'turn');
    let answer = '';
    try {
      const res = await this.streamTurn(
        info.prompt + SMC_PROTOCOL,
        userPrompt,
        cfg.model,
        signal,
        (delta) => {
          smc.appendThinking(msg, delta);
          this.emit({ type: 'agentDelta', round: turnId, agent, role, channel: 'thinking', delta });
        },
        (delta) => {
          smc.appendAnswer(msg, delta);
          this.emit({ type: 'agentDelta', round: turnId, agent, role, channel: 'answer', delta });
        },
      );
      answer = res.answer;
    } catch {
      // A single failed turn must never tear down the whole conversation.
    }
    return answer.trim() || msg.content.trim() || msg.thinking.trim();
  }

  /** True when the conversation should stop (converged, aborted, or budget hit). */
  private shouldStop(state: ConvState, signal?: AbortSignal): boolean {
    return !!signal?.aborted || state.converged || state.utterances >= state.maxUtterances;
  }

  /**
   * Block until the transcript grows (a peer spoke) or a bounded timeout fires.
   * Polling keeps this dependency-free and works regardless of which peer loop
   * produced the new activity.
   */
  private async waitForActivity(
    transcript: TranscriptEntry[],
    signal?: AbortSignal,
  ): Promise<void> {
    const startLen = transcript.length;
    const deadline = Date.now() + LISTEN_TIMEOUT_MS;
    while (
      !signal?.aborted &&
      transcript.length === startLen &&
      Date.now() < deadline
    ) {
      await this.sleep(POLL_MS, signal);
    }
  }

  /** Promise-based sleep that resolves early if the signal aborts. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) { return resolve(); }
      const t = setTimeout(() => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  /** Build the user prompt for an agent turn from the LIVE shared channel. */
  private buildUserPrompt(task: string, smc: SharedMessageChannel, speaker: string): string {
    const parts: string[] = [];
    parts.push('ORIGINAL TASK:\n' + task);
    const channel = smc.render();
    if (channel) {
      parts.push('\nLIVE TEAM CHANNEL (most recent reasoning, answers & notes):\n' + channel);
    }
    parts.push(
      '\nYou are the ' + speaker + '. You are in a LIVE, concurrent discussion ' +
      'with your teammates — they may be speaking at the same time as you. Read ' +
      'the channel above, build on or push back against what peers just said, ' +
      'and add your next contribution. If you are the Reviewer and you are fully ' +
      'satisfied the team has converged on a correct solution, include the word ' +
      'APPROVE.',
    );
    return parts.join('\n');
  }

  /** Build the synthesis user prompt: original task + the full transcript. */
  private buildSynthesisPrompt(task: string, transcript: TranscriptEntry[]): string {
    return (
      'ORIGINAL TASK:\n' + task +
      '\n\nFULL DISCUSSION TRANSCRIPT:\n' + this.renderTranscript(transcript) +
      '\n\nProduce the final consolidated solution the team agreed on.'
    );
  }

  /** Render the transcript compactly, capping each message to TRANSCRIPT_MSG_CAP chars. */
  private renderTranscript(transcript: TranscriptEntry[]): string {
    return transcript
      .map((e) => {
        let c = e.content.trim();
        if (c.length > TRANSCRIPT_MSG_CAP) {
          c = c.slice(0, TRANSCRIPT_MSG_CAP) + '… [truncated]';
        }
        return '[Round ' + e.round + ' — ' + e.agent + ']\n' + c;
      })
      .join('\n\n');
  }

  /** Best-so-far fallback when synthesis is skipped (abort/error/empty). */
  private bestSoFar(transcript: TranscriptEntry[]): string {
    if (transcript.length === 0) { return ''; }
    // Prefer the latest non-reviewer (proposal-bearing) message, else the last.
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role.toLowerCase() !== 'reviewer') {
        return transcript[i].content;
      }
    }
    return transcript[transcript.length - 1].content;
  }

  /**
   * Stream one agent turn. Routes raw stream deltas through the thinkingSplitter
   * so hidden-reasoning text and answer text are delivered to separate callbacks
   * live. Resolves with the accumulated thinking + answer.
   */
  private streamTurn(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    signal: AbortSignal | undefined,
    onThinking: (delta: string) => void,
    onAnswer: (delta: string) => void,
  ): Promise<{ thinking: string; answer: string }> {
    return new Promise<{ thinking: string; answer: string }>((resolve, reject) => {
      const config = { ...loadQGenieConfig(), model };
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const carry: ThinkingCarry = { buf: '', inThinking: false, expectedClose: '' };
      let thinking = '';
      let answer = '';
      let settled = false;

      const pushThinking = (t: string) => { if (t) { thinking += t; onThinking(t); } };
      const pushAnswer = (t: string) => { if (t) { answer += t; onAnswer(t); } };

      streamChatCompletion(
        messages,
        config,
        (chunk: StreamChunk) => {
          if (settled) { return; }

          if (chunk.usage) {
            this.emit({
              type: 'usage',
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
            });
          }

          if (chunk.delta) {
            splitThinkingChunks(
              carry,
              chunk.delta,
              pushAnswer,    // text outside thinking tags = the answer
              pushThinking,  // text inside thinking tags = live reasoning
              () => {},      // onThinkingStart (no-op: deltas carry the boundary)
              () => {},      // onThinkingEnd
            );
          }

          if (chunk.done) {
            settled = true;
            // Flush any buffered partial tag remainder.
            flushSplitter(carry, pushAnswer, pushThinking, () => {});
            if (chunk.error && answer.length === 0 && thinking.length === 0) {
              reject(new Error(chunk.error));
              return;
            }
            resolve({ thinking, answer });
          }
        },
        signal,
      );
    });
  }

  /**
   * Non-streaming convenience wrapper (used for synthesis & interjections):
   * accumulate the answer (thinking stripped) and resolve on done.
   */
  private complete(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let answer = '';
      let thinking = '';
      this.streamTurnSilent(systemPrompt, userPrompt, model, signal,
        (t) => { thinking += t; },
        (a) => { answer += a; },
      ).then(
        () => resolve(answer.trim() ? answer : thinking),
        (err) => reject(err),
      );
    });
  }

  /** Like streamTurn but without emitting agentDelta events (internal calls). */
  private streamTurnSilent(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    signal: AbortSignal | undefined,
    onThinking: (delta: string) => void,
    onAnswer: (delta: string) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const config = { ...loadQGenieConfig(), model };
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];
      const carry: ThinkingCarry = { buf: '', inThinking: false, expectedClose: '' };
      let any = false;
      let settled = false;

      streamChatCompletion(
        messages,
        config,
        (chunk: StreamChunk) => {
          if (settled) { return; }
          if (chunk.usage) {
            this.emit({
              type: 'usage',
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
            });
          }
          if (chunk.delta) {
            any = true;
            splitThinkingChunks(carry, chunk.delta, onAnswer, onThinking, () => {}, () => {});
          }
          if (chunk.done) {
            settled = true;
            flushSplitter(carry, onAnswer, onThinking, () => {});
            if (chunk.error && !any) { reject(new Error(chunk.error)); return; }
            resolve();
          }
        },
        signal,
      );
    });
  }
}
