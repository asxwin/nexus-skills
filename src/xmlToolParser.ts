
// ─── xmlToolParser.ts ─────────────────────────────────────────────────────────
// A streaming parser for Cline-style XML tool tags emitted in plain
// assistant text. The parser is fed assistant `delta.content` chunks as
// they arrive from the LLM and emits high-level events:
//
//   - onToolStart(name)            – first byte of an opening tool tag
//   - onParamChunk(name, chunk)    – streaming text inside a parameter
//   - onParamEnd(name, fullValue)  – parameter closed
//   - onToolEnd(name, params)      – tool closed (all params collected)
//
// We deliberately accept only the registered tool/param names so that
// stray angle brackets in normal prose / code don't trigger false matches.
// Anything outside a recognised tool tag is forwarded as plain "speech"
// via onSpeech, so the chat view can still display the model's reasoning.

export interface XmlToolParserCallbacks {
  /** Plain assistant text outside any tool tag. */
  onSpeech?: (text: string) => void;
  /** Opening tag of a known tool seen. */
  onToolStart?: (name: string) => void;
  /** Streaming chunk inside a parameter (called many times). */
  onParamChunk?: (toolName: string, paramName: string, chunk: string) => void;
  /** Parameter fully received. */
  onParamEnd?: (toolName: string, paramName: string, fullValue: string) => void;
  /**
   * Tool fully received with all collected parameters.
   *
   * `truncated` is `true` when the tool call was NOT cleanly closed and
   * the parser had to force-finalize it. Downstream executors should
   * REFUSE to execute a truncated write_file / replace_in_file (or any
   * tool whose params may be half-parsed), since the parameter values
   * cannot be trusted. It is set in three situations:
   *   (a) end() finalized while still mid-parameter (open param tag never
   *       closed at end-of-stream),
   *   (b) the "stuck on open-bracket" 64-byte guard force-closed the tool
   *       because an opening bracket never reached a matching close,
   *   (c) an unrecognised sub-tag was dropped inside the tool.
   * `warning` carries an optional human-readable reason for the
   * truncation. Both fields are omitted (undefined) on the happy path.
   */
  onToolEnd?: (
    toolName: string,
    params: Record<string, string>,
    truncated?: boolean,
    warning?: string
  ) => void;
  /**
   * Fired when an unrecognised parameter (sub-tag) is dropped inside a
   * known tool. `msg` names the tool and the dropped param. Optional and
   * non-breaking — purely diagnostic.
   */
  onWarning?: (msg: string) => void;
}

type State =
  | { kind: 'speech' }
  | { kind: 'in-tool'; tool: string; params: Record<string, string> }
  | { kind: 'in-param'; tool: string; param: string; params: Record<string, string>; collected: string[] };

export class XmlToolParser {
  private _buf = '';
  private _state: State = { kind: 'speech' };
  private _ended = false;

  /** When a tool is force-finalized (truncated), this holds the reason
   * to surface via onToolEnd. Reset by _closeTool after each emit. */
  private _truncated = false;
  private _truncationReason: string | undefined = undefined;

  /** Hard safety cap on _step iterations per feed/end call. The parser
   * is structured so every iteration either consumes buffer bytes or
   * breaks out via the before==after check, so an infinite loop should
   * be impossible — this cap is paranoia against future bugs. */
  private static readonly MAX_STEPS_PER_FEED = 10000;

  // Set of recognised top-level tool names. Anything else is treated as
  // plain text — so e.g. a "<div>" in a code review never triggers a tool.
  private readonly _tools: Set<string>;

  // Per-tool: which child tags are valid parameters.
  private readonly _params: Record<string, Set<string>>;

  constructor(
    tools: Record<string, string[]>,
    private readonly _cb: XmlToolParserCallbacks = {}
  ) {
    this._tools = new Set(Object.keys(tools));
    this._params = {};
    for (const [tool, params] of Object.entries(tools)) {
      this._params[tool] = new Set(params);
    }
  }

  /** Feed the next chunk of streamed assistant text. */
  feed(chunk: string): void {
    if (this._ended) {
      // Stream already finalized — silently drop late chunks rather than
      // crashing or producing spurious tool calls.
      return;
    }
    this._buf += chunk;
    this._consume();
  }

  /**
   * Force-close the parser at end-of-stream.
   *
   *  - In `speech`: flush any remaining buffered text as speech.
   *  - In `in-param`: the stream ended mid-parameter (e.g. the model was
   *    cut off, or omitted the closing tag). Emit whatever content we
   *    buffered as the parameter value and finalize the tool, so a
   *    truncated write_file/replace_in_file still produces an actionable
   *    tool call instead of silently vanishing (a "stuck" symptom).
   *  - In `in-tool`: finalize with the params collected so far.
   */
  end(): void {
    if (this._ended) {
      // Idempotent: a double end() (e.g. natural end-of-stream followed
      // by an abort) is a no-op.
      return;
    }
    this._ended = true;
    if (this._state.kind === 'speech') {
      if (this._buf.length > 0) {
        this._cb.onSpeech?.(this._buf);
        this._buf = '';
      }
      return;
    }

    if (this._state.kind === 'in-param') {
      const st = this._state;
      // (a) Stream ended while still mid-parameter — the closing param tag
      // was never seen. Mark the resulting tool call truncated so the
      // executor can refuse a half-parsed write_file/replace_in_file.
      this._truncated = true;
      this._truncationReason =
        `tool <${st.tool}> ended mid-parameter <${st.param}> (no closing tag at end-of-stream)`;
      // Flush any unconsumed buffer as the tail of the parameter (we held
      // back a small window in case it was a partial close tag; at EOS it
      // is definitely content).
      if (this._buf.length > 0) {
        st.collected.push(this._buf);
        this._cb.onParamChunk?.(st.tool, st.param, this._buf);
        this._buf = '';
      }
      const fullValue = st.collected.join('');
      st.params[st.param] = fullValue;
      this._cb.onParamEnd?.(st.tool, st.param, fullValue);
      this._state = { kind: 'in-tool', tool: st.tool, params: st.params };
    }

    if (this._state.kind === 'in-tool') {
      this._buf = '';
      this._closeTool();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _consume(): void {
    // Loop until no more progress can be made on the current buffer.
    let steps = 0;
    while (true) {
      const before = this._buf.length;
      this._step();
      if (this._buf.length === before) { break; }
      if (++steps >= XmlToolParser.MAX_STEPS_PER_FEED) {
        console.warn('XmlToolParser: hit step cap, breaking');
        break;
      }
    }
  }

  private _step(): void {
    if (this._state.kind === 'speech') { this._stepSpeech(); return; }
    if (this._state.kind === 'in-tool') { this._stepInTool(); return; }
    if (this._state.kind === 'in-param') { this._stepInParam(); return; }
  }

  private _stepSpeech(): void {
    // Look for the next opening bracket. Anything before it is plain speech.
    const lt = this._buf.indexOf('<');
    if (lt === -1) {
      // No tag start in buffer — emit it all as speech and stop.
      if (this._buf.length > 0) {
        this._cb.onSpeech?.(this._buf);
        this._buf = '';
      }
      return;
    }

    // Emit any prefix before the bracket as speech.
    if (lt > 0) {
      this._cb.onSpeech?.(this._buf.slice(0, lt));
      this._buf = this._buf.slice(lt);
    }

    // We have an opening bracket at start of buffer. Need at least up to the
    // closing bracket to decide.
    const gt = this._buf.indexOf('>');
    if (gt === -1) {
      // Tag not closed yet; wait for more bytes. But if the buffer is
      // already huge without a closing bracket it's almost certainly not a
      // tag at all (e.g. a math expression) — emit one bracket as speech and
      // continue so we don't get stuck.
      if (this._buf.length > 64) {
        // UTF-16 / UTF-8 safety: JS strings are UTF-16 code units. A
        // non-BMP code point (emoji, some CJK, math symbols) is encoded
        // as a surrogate pair (high surrogate U+D800..U+DBFF followed by
        // a low surrogate U+DC00..U+DFFF). Emitting only the high
        // surrogate would produce a malformed lone surrogate in the
        // speech callback. Detect and emit the pair atomically.
        const code = this._buf.charCodeAt(0);
        if (code >= 0xD800 && code <= 0xDBFF && this._buf.length >= 2) {
          this._cb.onSpeech?.(this._buf.slice(0, 2));
          this._buf = this._buf.slice(2);
        } else {
          this._cb.onSpeech?.(this._buf[0]);
          this._buf = this._buf.slice(1);
        }
      }
      return;
    }

    const inside = this._buf.slice(1, gt);
    const tagName = inside.split(/\s/)[0].trim();

    // Closing tag here is unexpected in speech state — treat as plain text.
    if (inside.startsWith('/')) {
      this._cb.onSpeech?.(this._buf.slice(0, gt + 1));
      this._buf = this._buf.slice(gt + 1);
      return;
    }

    if (this._tools.has(tagName)) {
      // Enter the tool. Consume the open tag.
      this._buf = this._buf.slice(gt + 1);
      // Eat one optional newline right after the open tag for nicer parsing.
      if (this._buf.startsWith('\n')) { this._buf = this._buf.slice(1); }
      this._state = { kind: 'in-tool', tool: tagName, params: {} };
      this._cb.onToolStart?.(tagName);
      return;
    }

    // Unknown tag — emit as speech (keeps "<div>" etc. intact).
    this._cb.onSpeech?.(this._buf.slice(0, gt + 1));
    this._buf = this._buf.slice(gt + 1);
  }

  private _stepInTool(): void {
    if (this._state.kind !== 'in-tool') { return; }
    const st = this._state;

    // Look for the next opening bracket.
    const lt = this._buf.indexOf('<');
    if (lt === -1) {
      // Whitespace / leading text inside a tool body — discard quietly so
      // the model can put blank lines between params without us treating
      // them as content.
      this._buf = '';
      return;
    }
    if (lt > 0) {
      // Discard inter-tag whitespace. If it's not whitespace, drop it
      // anyway: free-form prose between params is undefined behaviour.
      this._buf = this._buf.slice(lt);
    }
    const gt = this._buf.indexOf('>');
    if (gt === -1) {
      if (this._buf.length > 64) {
        // (b) Stuck on an opening bracket with no close — give up and call
        // it done. Mark truncated: a tool tag was opened but never closed.
        this._truncated = true;
        this._truncationReason =
          `tool <${st.tool}> force-closed: opening bracket never reached a matching close within 64 bytes`;
        this._closeTool();
      }
      return;
    }

    const inside = this._buf.slice(1, gt);
    const closing = inside.startsWith('/');
    const tagName = (closing ? inside.slice(1) : inside).split(/\s/)[0].trim();

    if (closing) {
      if (tagName === st.tool) {
        // Tool closed.
        this._buf = this._buf.slice(gt + 1);
        if (this._buf.startsWith('\n')) { this._buf = this._buf.slice(1); }
        this._closeTool();
        return;
      }
      // Stray closing tag — drop it.
      this._buf = this._buf.slice(gt + 1);
      return;
    }

    // Opening tag: must be a valid param for this tool.
    const validParams = this._params[st.tool];
    if (validParams && validParams.has(tagName)) {
      this._buf = this._buf.slice(gt + 1);
      if (this._buf.startsWith('\n')) { this._buf = this._buf.slice(1); }
      this._state = { kind: 'in-param', tool: st.tool, param: tagName, params: st.params, collected: [] };
      this._cb.onParamChunk?.(st.tool, tagName, '');
      return;
    }

    // (c) Unknown sub-tag inside a tool — drop it and continue, but mark
    // the tool call truncated and fire the diagnostic callback so the
    // executor knows a param may have been silently lost.
    this._truncated = true;
    this._truncationReason =
      `tool <${st.tool}> contained unrecognised sub-tag <${tagName}> (dropped)`;
    this._cb.onWarning?.(
      `XmlToolParser: dropped unrecognised param <${tagName}> in tool <${st.tool}>`
    );
    this._buf = this._buf.slice(gt + 1);
  }

  private _stepInParam(): void {
    if (this._state.kind !== 'in-param') { return; }
    const st = this._state;
    const closeTag = `</${st.param}>`;

    // Stream as much content as possible *up to* the start of the closing
    // tag. We have to be careful: a chunk might end in a partial close
    // sequence like "</con" — we must not emit those bytes yet, otherwise
    // they'd appear as content. So we hold back the last (closeTag.length-1)
    // bytes until we either see the full close or get more data.
    const closeIdx = this._buf.indexOf(closeTag);
    if (closeIdx >= 0) {
      const piece = this._buf.slice(0, closeIdx);
      if (piece.length > 0) {
        st.collected.push(piece);
        this._cb.onParamChunk?.(st.tool, st.param, piece);
      }
      this._buf = this._buf.slice(closeIdx + closeTag.length);
      if (this._buf.startsWith('\n')) { this._buf = this._buf.slice(1); }
      const fullValue = st.collected.join('');
      st.params[st.param] = fullValue;
      this._cb.onParamEnd?.(st.tool, st.param, fullValue);
      // Back to in-tool waiting for next param or closing tool tag.
      this._state = { kind: 'in-tool', tool: st.tool, params: st.params };
      return;
    }

    // No full close in buffer — emit everything except the trailing window
    // that could still be the start of the close tag.
    const safe = Math.max(0, this._buf.length - (closeTag.length - 1));
    if (safe > 0) {
      const piece = this._buf.slice(0, safe);
      st.collected.push(piece);
      this._cb.onParamChunk?.(st.tool, st.param, piece);
      this._buf = this._buf.slice(safe);
    }
  }

  private _closeTool(): void {
    if (this._state.kind === 'speech') { return; }
    const tool = this._state.tool;
    const params = this._state.kind === 'in-tool' ? this._state.params
      : { ...this._state.params, [this._state.param]: (this._state as any).collected.join('') };
    this._state = { kind: 'speech' };
    const truncated = this._truncated;
    const reason = this._truncationReason;
    // Reset so a subsequent (clean) tool call isn't falsely flagged.
    this._truncated = false;
    this._truncationReason = undefined;
    this._cb.onToolEnd?.(tool, params, truncated || undefined, reason);
  }
}
