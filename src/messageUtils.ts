// messageUtils.ts — pruneMessages and isTransientStreamError extracted from agentSession.

import { ChatMessage } from './qgenieApi';
import { PRUNE_MAX_CHARS, PRUNE_ASSISTANT_PART_MAX_CHARS } from './hardeningConfig';

// ── Performance: message sliding window ───────────────────────
/** Truncate a single oversized text body by keeping head + tail and dropping
 *  the middle, so one huge response can't blow the context window. */
function clampTextPart(text: string, maxChars: number): string {
  if (text.length <= maxChars) { return text; }
  const keep = Math.floor(maxChars / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(text.length - keep);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n[…truncated ${dropped} chars…]\n${tail}`;
}

/** Prune older tool-result messages when conversation gets too large.
 *  Replaces bodies of older tool results with a summary to stay under
 *  `maxChars` (proxy for token count). Also caps any single oversized
 *  assistant/text part so one huge response can't blow the window. */
export function pruneMessages(messages: ChatMessage[], maxChars: number = PRUNE_MAX_CHARS): ChatMessage[] {
  // Estimate total character count
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') { total += m.content.length; }
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') { total += p.text.length; }
      }
    }
  }
  if (total <= maxChars) { return messages; }

  // Truncate from oldest tool-result messages (skip system[0] and last few)
  const result = [...messages];
  const KEEP_RECENT = 10; // always keep the last N messages intact
  for (let i = 1; i < result.length - KEEP_RECENT; i++) {
    if (total <= maxChars) { break; }
    const m = result[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[tool ')) {
      const lines = m.content.split('\n');
      const header = lines[0]; // "[tool X result]"
      const bodyLen = lines.length - 1;
      if (bodyLen > 5) {
        const truncated = `${header}\n[content truncated - ${bodyLen} lines]`;
        const saved = m.content.length - truncated.length;
        result[i] = { ...m, content: truncated };
        total -= saved;
      }
    }
  }

  // Window safety: cap any single oversized assistant/text part (head+tail),
  // even when over budget can't be reached by tool-result truncation alone.
  // Skips system[0] and the most-recent message so live output isn't mangled.
  for (let i = 1; i < result.length - 1; i++) {
    const m = result[i];
    if (typeof m.content === 'string') {
      if (m.content.length > PRUNE_ASSISTANT_PART_MAX_CHARS &&
          !(m.role === 'user' && m.content.startsWith('[tool '))) {
        const clamped = clampTextPart(m.content, PRUNE_ASSISTANT_PART_MAX_CHARS);
        total -= (m.content.length - clamped.length);
        result[i] = { ...m, content: clamped };
      }
    } else if (Array.isArray(m.content)) {
      let changed = false;
      const parts = m.content.map((p) => {
        if (p.type === 'text' && p.text.length > PRUNE_ASSISTANT_PART_MAX_CHARS) {
          const clamped = clampTextPart(p.text, PRUNE_ASSISTANT_PART_MAX_CHARS);
          total -= (p.text.length - clamped.length);
          changed = true;
          return { ...p, text: clamped };
        }
        return p;
      });
      if (changed) { result[i] = { ...m, content: parts }; }
    }
  }
  return result;
}

/** Is this stream error transient (worth retrying) vs permanent (auth/400/quota)?
 *
 *  NOTE: unknown errors default to retryable (return true at the end). This is
 *  SAFE only because the CALLER caps the number of retries — see the retry loop
 *  in qgenieApi.streamChatCompletion which enforces MAX_TRANSIENT_RETRIES. Do
 *  not rely on this predicate alone to bound retry attempts. */
export function isTransientStreamError(err: string): boolean {
  const e = err.toLowerCase();
  if (/\b(401|403|400|404)\b/.test(e)) { return false; }
  if (/(unauthor|forbidden|invalid api key|no api key|bad request|not found|insufficient|quota)/.test(e)) {
    return false;
  }
  if (/\b(408|429|5\d\d)\b/.test(e)) { return true; }
  if (/(timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|network|stream|fetch failed|aborted|temporarily|503|service unavailable|overloaded|rate limit)/.test(e)) {
    return true;
  }
  // Unknown: default retryable; MAX_TRANSIENT_RETRIES caps the blast radius.
  return true;
}
