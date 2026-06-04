// thinkingSplitter.ts — Streaming thinking-tag splitter extracted from agentSession.

export interface ThinkingCarry {
  buf: string;
  inThinking: boolean;
  expectedClose: string;
}

export const MAX_CARRY = 128;
export const OPEN_TAG_RE = /<\s*(thinking|think|thought|reasoning)\b[^>]*>/i;

export function findOpenTag(buf: string): { idx: number; len: number; name: string } | null {
  const m = buf.match(OPEN_TAG_RE);
  if (!m || m.index === undefined) { return null; }
  return { idx: m.index, len: m[0].length, name: m[1].toLowerCase() };
}

export function partialTagStart(buf: string): number {
  const lastLt = buf.lastIndexOf('<');
  if (lastLt === -1) { return -1; }
  if (buf.indexOf('>', lastLt) !== -1) { return -1; }
  return lastLt;
}

export function splitThinkingChunks(
  carryRef: ThinkingCarry,
  chunk: string,
  onOutside: (text: string) => void,
  onThinking: (text: string) => void,
  onThinkingStart: () => void,
  onThinkingEnd: () => void,
): void {
  let buf = carryRef.buf + chunk;
  carryRef.buf = '';

  while (buf.length > 0) {
    if (carryRef.inThinking) {
      const closeTag = carryRef.expectedClose;
      const idxLower = buf.toLowerCase().indexOf(closeTag.toLowerCase());
      if (idxLower === -1) {
        const partial = partialTagStart(buf);
        if (partial === -1) { onThinking(buf); carryRef.buf = ''; return; }
        if (partial > 0) { onThinking(buf.slice(0, partial)); }
        const tail = buf.slice(partial);
        if (tail.length > MAX_CARRY) { onThinking(tail); carryRef.buf = ''; }
        else { carryRef.buf = tail; }
        return;
      }
      if (idxLower > 0) { onThinking(buf.slice(0, idxLower)); }
      buf = buf.slice(idxLower + closeTag.length);
      carryRef.inThinking = false;
      carryRef.expectedClose = '';
      onThinkingEnd();
    } else {
      const hit = findOpenTag(buf);
      if (!hit) {
        const partial = partialTagStart(buf);
        if (partial === -1) { onOutside(buf); carryRef.buf = ''; return; }
        if (partial > 0) { onOutside(buf.slice(0, partial)); }
        const tail = buf.slice(partial);
        if (tail.length > MAX_CARRY) { onOutside(tail); carryRef.buf = ''; }
        else { carryRef.buf = tail; }
        return;
      }
      if (hit.idx > 0) { onOutside(buf.slice(0, hit.idx)); }
      buf = buf.slice(hit.idx + hit.len);
      carryRef.inThinking = true;
      carryRef.expectedClose = `</${hit.name}>`;
      onThinkingStart();
    }
  }
}

export function flushSplitter(
  carryRef: ThinkingCarry,
  onOutside: (text: string) => void,
  onThinking: (text: string) => void,
  onThinkingEnd: () => void,
): void {
  const tail = carryRef.buf;
  carryRef.buf = '';
  if (tail) {
    if (carryRef.inThinking) { onThinking(tail); }
    else { onOutside(tail); }
  }
  if (carryRef.inThinking) {
    carryRef.inThinking = false;
    carryRef.expectedClose = '';
    onThinkingEnd();
  }
}
