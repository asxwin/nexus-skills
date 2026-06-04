// thinkingSplitter.test.ts — unit tests for the streaming thinking-tag splitter.
//
// HOW TO RUN (no test framework is configured in package.json):
//   Compile then run with node's built-in test runner:
//     npx tsc -p ./ && node --test out/thinkingSplitter.test.js
//   Or, if ts-node / tsx is available:
//     npx tsx --test src/thinkingSplitter.test.ts
//     npx ts-node --esm src/thinkingSplitter.test.ts   (depending on tsconfig)
//
// These tests use ONLY node built-ins (node:test + node:assert), so no extra
// devDependencies are required beyond @types/node (already present).
//
// FIXTURE NOTE: the model's hidden-reasoning open/close tag is assembled by
// string concatenation below so the literal contiguous pair never appears in
// this source file (the runtime would otherwise strip it).

import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  ThinkingCarry,
  splitThinkingChunks,
  flushSplitter,
} from './thinkingSplitter';

// Build the reasoning tags via concatenation so the contiguous pair is never
// present as a literal in this file.
const OPEN = '<' + 'thinking>';
const CLOSE = '</' + 'thinking>';

interface Captured {
  outside: string;
  thinking: string;
  starts: number;
  ends: number;
}

/** Feed the whole input as ONE chunk and capture all callback output. */
function runWhole(input: string): Captured {
  const carry: ThinkingCarry = { buf: '', inThinking: false, expectedClose: '' };
  const cap: Captured = { outside: '', thinking: '', starts: 0, ends: 0 };
  splitThinkingChunks(
    carry,
    input,
    (t) => { cap.outside += t; },
    (t) => { cap.thinking += t; },
    () => { cap.starts++; },
    () => { cap.ends++; },
  );
  flushSplitter(
    carry,
    (t) => { cap.outside += t; },
    (t) => { cap.thinking += t; },
    () => { cap.ends++; },
  );
  return cap;
}

/** Feed the input ONE BYTE (character) PER CHUNK through a single shared carry. */
function runByteByByte(input: string): Captured {
  const carry: ThinkingCarry = { buf: '', inThinking: false, expectedClose: '' };
  const cap: Captured = { outside: '', thinking: '', starts: 0, ends: 0 };
  const onOutside = (t: string) => { cap.outside += t; };
  const onThinking = (t: string) => { cap.thinking += t; };
  const onStart = () => { cap.starts++; };
  const onEnd = () => { cap.ends++; };
  for (const ch of input) {
    splitThinkingChunks(carry, ch, onOutside, onThinking, onStart, onEnd);
  }
  flushSplitter(carry, onOutside, onThinking, onEnd);
  return cap;
}

test('happy path: full reasoning tag in a single chunk', () => {
  const input = `Hello ${OPEN}secret reasoning${CLOSE} world`;
  const cap = runWhole(input);
  assert.equal(cap.outside, 'Hello  world', 'visible text should exclude the tag and its body');
  assert.equal(cap.thinking, 'secret reasoning', 'reasoning body captured');
  assert.equal(cap.starts, 1, 'one thinking start');
  assert.equal(cap.ends, 1, 'one thinking end');
  // The raw tag must NOT leak into visible output.
  assert.ok(!cap.outside.includes(OPEN), 'open tag must not appear in visible text');
  assert.ok(!cap.outside.includes(CLOSE), 'close tag must not appear in visible text');
});

test('straddling: reasoning tag fed ONE BYTE PER CHUNK is recognized, not flushed as half-tag', () => {
  const input = `A${OPEN}think${CLOSE}B`;
  const cap = runByteByByte(input);
  // Visible text is only the surrounding letters; the tag itself never leaks.
  assert.equal(cap.outside, 'AB', 'only non-tag text is visible');
  assert.equal(cap.thinking, 'think', 'reasoning body captured across byte-split chunks');
  assert.equal(cap.starts, 1, 'exactly one thinking start across the byte stream');
  assert.equal(cap.ends, 1, 'exactly one thinking end across the byte stream');
  assert.ok(!cap.outside.includes('<'), 'no partial "<" half-tag leaked to visible text');
});

test('straddling: alternate reasoning name <reasoning> recognized byte-by-byte', () => {
  const input = 'x<reasoning>deep</reasoning>y';
  const cap = runByteByByte(input);
  assert.equal(cap.outside, 'xy');
  assert.equal(cap.thinking, 'deep');
  assert.equal(cap.starts, 1);
  assert.equal(cap.ends, 1);
});

test('plain text with a stray "<" that is NOT a tag is eventually emitted', () => {
  // "a < b" — the "<" has no matching ">" so it is a non-tag and flushed on end.
  const input = 'a < b';
  const cap = runWhole(input);
  assert.equal(cap.outside, 'a < b', 'stray < must survive as visible text after flush');
  assert.equal(cap.thinking, '');
  assert.equal(cap.starts, 0);
  assert.equal(cap.ends, 0);
});

test('no tags at all: passthrough', () => {
  const cap = runByteByByte('just some plain visible text');
  assert.equal(cap.outside, 'just some plain visible text');
  assert.equal(cap.thinking, '');
  assert.equal(cap.starts, 0);
});
