// QGenie Agent — multi-tab webview shell.
//
// Each chat tab is a TabState that owns its own:
//   - thread DOM subtree (#thread's children)
//   - thoughts panel body subtree
//   - pending image attachments
//   - input draft text
//   - "is streaming" / "is writing" / "currently animating thinking" flags
//   - current agent block ref + accumulating agent text
//   - per-tab token counters
//
// Only ONE TabState is "visible" at a time. Switching tabs detaches the
// visible DOM children from the host elements (#thread,
// #thoughts-panel-body, #pending-images, etc.), stows them on the
// outgoing TabState, then attaches the incoming TabState's stowed
// children. Background tabs continue to receive events and update
// their (detached) DOM silently.
//
// Outbound messages from this webview are tagged with the active tab's
// sessionId; incoming messages from the provider always carry a
// `sessionId` and we route them to the matching TabState.

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  // Reveal the (already-styled) body once the external stylesheet has parsed.
  // This script is at the end of <body>, after the <link> in <head>, so a
  // single rAF guarantees a styled paint before we un-hide — no flash of
  // unstyled HTML on reload/open.
  (function revealWhenStyled() {
    function reveal() {
      document.body.classList.remove('nexus-booting');
      document.body.classList.add('nexus-ready');
    }
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', function () {
        requestAnimationFrame(reveal);
      });
    } else {
      requestAnimationFrame(reveal);
    }
  })();

  // ─── Host DOM references ────────────────────────────────────────────────
  var threadEl = document.getElementById('thread');
  var inputEl = document.getElementById('chat-input');
  var sendBtn = document.getElementById('send-btn');
  var stopBtn = document.getElementById('stop-btn');
  var modelSelect = document.getElementById('model-select');
  // Strip a trailing ":<suffix>" capability flag (e.g. ":1M") that appears
  // only AFTER the "::" vendor separator. Mirrors baseModelId() in qgenieApi.ts.
  function baseModelId(id) {
    if (!id) { return id; }
    var sep = id.indexOf('::');
    if (sep === -1) { return id; }
    var colon = id.indexOf(':', sep + 2);
    return colon === -1 ? id : id.slice(0, colon);
  }

  var skillSelect = document.getElementById('skill-select');
  var settingsBtn = document.getElementById('settings-btn');
  var settingsPanel = document.getElementById('settings-panel');
  var attachEditorBtn = document.getElementById('attach-editor-btn');
  var attachImageBtn = document.getElementById('attach-image-btn');
  var imageFileInput = document.getElementById('image-file-input');
  var pendingImagesEl = document.getElementById('pending-images');
  var dropOverlayEl = document.getElementById('drop-overlay');
  var approvalBar = document.getElementById('approval-bar');
  var approvalBarTitle = document.getElementById('approval-bar-title');
  var approvalBarPreview = document.getElementById('approval-bar-preview');
  var approvalAllowBtn = document.getElementById('approval-allow-btn');
  var approvalDenyBtn = document.getElementById('approval-deny-btn');
  var approvalQueueCount = document.getElementById('approval-queue-count');
  var approvalAllowAllBtn = document.getElementById('approval-allow-all-btn');
  var approvalDenyAllBtn = document.getElementById('approval-deny-all-btn');
  var autoApproveWriteToggle = document.getElementById('auto-approve-write');
  var autoApproveExecToggle = document.getElementById('auto-approve-exec');
  var autoScrollToggle = document.getElementById('auto-scroll-toggle');
  var showThinkingToggle = document.getElementById('show-thinking-toggle');
  var stripEmojisToggle = document.getElementById('strip-emojis-toggle');
  var compactToolToggle = document.getElementById('compact-tool-toggle');
  var historyBtn = document.getElementById('history-btn');
  var historyOverlay = document.getElementById('history-overlay');
  var historyPanelClose = document.getElementById('history-panel-close');
  var historyPanelBody = document.getElementById('history-panel-body');
  var historyClearAllBtn = document.getElementById('history-clear-all-btn');
  var tabStripEl = document.getElementById('tab-strip');
  var tabNewBtn = document.getElementById('tab-new-btn');
  var tabOrchBtn = document.getElementById('tab-orch-btn');

  // Thoughts panel host
  var thoughtsPanelEl = document.getElementById('thoughts-panel');
  var thoughtsPanelHeaderEl = document.getElementById('thoughts-panel-header');
  var thoughtsPanelBodyEl = document.getElementById('thoughts-panel-body');
  var thoughtsPanelStatusEl = document.getElementById('thoughts-panel-status');
  var thoughtsChevronEl = document.getElementById('thoughts-chevron');
  var thoughtsClearBtn = document.getElementById('thoughts-clear-btn');

  // Local codebase-index button (lives in the chat header).
  var indexBtn = document.getElementById('index-btn');
  /** @type {'unknown'|'none'|'fresh'|'stale'|'building'} */
  var indexState = 'unknown';
  var indexFileCount = 0;

  /** Repaint the [INDEX] header button for the given state. */
  function paintIndexBtn(state, fileCount, pct) {
    if (!indexBtn) { return; }
    indexBtn.classList.remove('idx-fresh', 'idx-stale', 'idx-building');
    var fc = (typeof fileCount === 'number' && fileCount > 0) ? fileCount : 0;
    if (state === 'fresh') {
      indexBtn.textContent = fc > 0 ? '[INDEXED ' + fc + ']' : '[ INDEXED]';
      indexBtn.classList.add('idx-fresh');
      indexBtn.title = 'Codebase index is up to date — click to re-index';
    } else if (state === 'stale') {
      indexBtn.textContent = fc > 0 ? '[\u21bb REINDEX ' + fc + ']' : '[\u21bb REINDEX]';
      indexBtn.classList.add('idx-stale');
      indexBtn.title = 'Codebase changed since last index — click to re-index';
    } else if (state === 'building') {
      var p = (typeof pct === 'number' && pct >= 0) ? Math.round(pct) : 0;
      indexBtn.textContent = '[\u2026 ' + p + '%]';
      indexBtn.classList.add('idx-building');
      indexBtn.title = 'Indexing in progress…';
    } else {
      // 'none' | 'unknown' | anything else.
      indexBtn.textContent = '[INDEX]';
      indexBtn.title = 'Index this codebase locally (no AI) so the agent sends only relevant snippets';
    }
  }

  if (indexBtn) {
    indexBtn.addEventListener('click', function () {
      if (indexState === 'building') { return; }
      var t = (indexState === 'stale' || indexState === 'fresh') ? 'reindexCodebase' : 'indexCodebase';
      vscode.postMessage({ type: t });
    });
    paintIndexBtn('unknown');
  }

  // ─── Module-level state (NOT per-tab) ────────────────────────────────────
  /** @type {Map<string, TabState>} */
  var tabs = new Map();
  /** @type {string|null} */
  var activeSessionId = null;
  // Cached approval id we currently show, plus pending queue notes.
  var currentApprovalId = null;
  var currentApprovalToolName = '';
  // Spinner animation frames (used by thinking/writing/sub-agent spinners).
  var SPIN_CHARS = ['|', '/', '-', '\\'];
  // Rotating status words for the thinking animation. The label cycles
  // through these one at a time (blink → next word → blink → …) so the
  // spinner feels alive instead of showing a single static word.
  var THINKING_WORDS = [
    'JACKING IN', 'COGITATING', 'SCHEMING', 'PARSING', 'REASONING',
    'CRUNCHING', 'PONDERING', 'DECODING', 'SYNTHESIZING', 'INFERRING',
    'CALCULATING', 'MULLING', 'PROCESSING', 'ANALYZING', 'DELIBERATING',
    'COMPUTING', 'THEORIZING', 'NOODLING', 'DIVINING', 'CONJURING',
    'RUMINATING', 'PLOTTING', 'WEIGHING', 'CONTEMPLATING', 'BREWING',
    'PERCOLATING',
  ];
  // Rotating status words while writing a brand-new file.
  var WRITING_WORDS = [
    'COMPILING', 'WRITING', 'EMITTING', 'GENERATING', 'ASSEMBLING',
    'FORGING', 'SCRIBING', 'RENDERING', 'BUILDING', 'CRAFTING',
    'MATERIALIZING', 'SPAWNING', 'AUTHORING', 'COMMITTING', 'STREAMING',
    'TRANSCRIBING', 'CASTING', 'FABRICATING', 'PRINTING', 'SCULPTING',
    'WEAVING', 'COMPOSING', 'INSCRIBING', 'MANIFESTING', 'BAKING',
    'DEPLOYING',
  ];
  // Rotating status words while patching/editing an existing file.
  var PATCHING_WORDS = [
    'PATCHING', 'EDITING', 'SPLICING', 'MUTATING', 'REWIRING',
    'GRAFTING', 'AMENDING', 'TWEAKING', 'REFACTORING', 'SURGERY',
    'STITCHING', 'RETROFITTING', 'ADJUSTING', 'MENDING', 'REVISING',
    'OVERWRITING', 'REPLACING', 'TRANSPLANTING', 'RESHAPING', 'TUNING',
    'DOCTORING', 'REWORKING', 'REWRITING', 'INJECTING', 'MORPHING',
    'RECONFIGURING',
  ];
  // Settings state. Every settings toggle funnels through the single
  // setAutoApprove message channel (the host generalizes the keys).
  // Defaults mirror the host defaults.
  var autoApprove = {
    write_file: false,
    execute_command: false,
    auto_scroll: true,
    show_thinking: true,
    strip_emojis: true,
    compact_tool: false,
  };
  // Derived runtime flags driven by the settings toggles.
  var autoScrollEnabled = true;
  var stripEmojisEnabled = true;
  var settingsOpen = false;
  // History list cache (not per-tab — global to the user).
  var lastHistorySessions = [];
  var lastCurrentSessionId = null;
  // Cached element with .agent-last-statement for O(1) removal.
  var _lastHighlightedEl = null;

  var MAX_IMAGES = 8;
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  // ─── TabState class ─────────────────────────────────────────────────────
  // One per session/tab. Owns its detached DOM subtrees and all the
  // per-session render state. When the tab is "visible", its threadFrag
  // children live inside #thread; when it's hidden, they're stowed inside
  // threadFrag (a DocumentFragment).

  /**
   * @param {string} id sessionId from the provider
   * @param {string} title display title
   */
  function TabState(id, title) {
    this.id = id;
    this.title = title || 'New chat';
    this.running = false;
    this.orchestrator = false;
    this.model = '';
    this.skillName = '';
    this.promptTokens = 0;
    this.completionTokens = 0;

    // Orchestration render state: map of agentId -> { card, streamEl,
    // reportEl, statusEl, spinnerEl, toolCountEl, toolCount }.
    this.subAgents = {};
    this.currentOrchestrateBlock = null;

    // DocumentFragments that stow this tab's DOM when it's NOT visible.
    // When it IS visible, these fragments are EMPTY and the children
    // live in the host elements (#thread, #thoughts-panel-body,
    // #pending-images). On switchTab we move them between the host and
    // these fragments.
    this.threadFrag = document.createDocumentFragment();
    this.thoughtsFrag = document.createDocumentFragment();
    this.imagesFrag = document.createDocumentFragment();

    // Render state
    this.isStreaming = false;
    this.currentAgentBlock = null;
    this.currentAgentText = '';
    this.messageCount = 0;
    this.thinkingBlock = null;
    this.thinkingInterval = null;
    this.writingBlock = null;
    this.writingInterval = null;
    this.writingFileEl = null;

    this.writingLabelEl = null;
    this.writingToolName = '';
    // Thought-panel session refs
    this.currentThoughtSessionEl = null;
    this.currentThoughtSessionTextEl = null;
    this.currentThoughtSessionText = '';
    this.totalThoughtSessions = 0;
    this.thoughtsStreaming = false;
    this.thoughtsStatus = '// idle';

    // Auto-scroll stickiness: true while the user is parked near the
    // bottom of the thread, false once they scroll up. scrollToBottom
    // only auto-scrolls while this is true, so a manual scroll-up during
    // a long-running execute_command is never yanked back down.
    this.stickToBottom = true;

    // Pending image attachments (for input area). Each entry:
    // { id, name, dataUrl }.
    this.pendingImages = [];
    this.pendingImageCounter = 0;

    // Saved input draft so switching away doesn't lose typing.
    this.inputDraft = '';

    // Has the user ever sent a message? Controls the empty-state splash.
    this.hasMessages = false;

    // rAF throttle flag for streaming renders (assistantDelta)
    this._renderPending = false;
    // rAF id for coalesced scrollToBottom
    this._scrollRAF = null;

    // Seed the thread fragment with the empty-state splash so freshly
    // created tabs look the same as a brand-new chat.
    this._appendEmptyState();
  }

  // The real Nexus ASCII splash (one string per row). Kept as an array so
  // the Matrix "decode" intro can address each glyph by row/column.
  var NEXUS_ASCII_ROWS = [
    ' _  _ _____  ___   _ ___ ',
    '| \\| | __\\ \\/ / | | / __|',
    '| .` | _| >  <| |_| \\__ \\',
    '|_|\\_|___/_/\\_\\\\___/|___/',
  ];

  // Compact ASCII banner shown when an orchestrate block deploys its swarm.
  // Decoded with the same Matrix cascade as the splash, then accented with a
  // "neural link" sweep (see runOrchestrateIntro / CSS .orch-banner).
  var ORCH_ASCII_ROWS = [
    '  __  ___  ___ _  _ ___ ___ _____ ___    _ _____ ___ ',
    ' / _ \\| _ \\/ __| || | __/ __|_   _| _ \\  /_\\_   _| __|',
    '| (_) |   / (__| __ | _|\\__ \\ | | |   / / _ \\| | | _| ',
    ' \\___/|_|_\\\\___|_||_|___|___/ |_| |_|_\\/_/ \\_\\_| |___|',
  ];

  // ─── Matrix "decode" intro for the Nexus splash ─────────────────────────
  // Each glyph of the ASCII art starts as a fast-cycling random green
  // character ("digital rain") and then locks into its real character with
  // a brief bright phosphor flash, cascading top→bottom left→right. Spaces
  // in the art stay blank. The whole thing runs once and self-cleans,
  // leaving the plain <pre class="splash"> text behind.
  //
  // Gate: the Matrix intro plays every time a fresh empty-state splash is
  // built — the whole-page boot (webview load / reload) AND every NEW chat
  // or new tab (each builds a brand-new TabState whose _appendEmptyState
  // runs the decode). Tab switches and history replays do NOT rebuild the
  // empty-state, so they show their existing content without re-running it.
  var MATRIX_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEFZ:.=*+-<>';

  // Generic Matrix-style decoder: scramble every glyph of `rows` then lock
  // them in with a cascading phosphor flash. `opts` tunes the timing and the
  // CSS hook class so the splash and the orchestrate banner can share it:
  //   opts.introClass  CSS class toggled on the element while decoding
  //   opts.settleBase / rowStep / colJitter  timing (ms)
  //   opts.tail        extra ms held after the last lock-in
  //   opts.onDone      callback fired once the decode finishes
  function runMatrixDecode(splashEl, rows, opts) {
    opts = opts || {};
    var introClass = opts.introClass || 'splash-intro';
    var SETTLE_BASE = opts.settleBase != null ? opts.settleBase : 380;
    var ROW_STEP = opts.rowStep != null ? opts.rowStep : 150;
    var COL_JITTER = opts.colJitter != null ? opts.colJitter : 220;
    var TAIL = opts.tail != null ? opts.tail : 120;
    var maxCols = 0;
    for (var r = 0; r < rows.length; r++) { if (rows[r].length > maxCols) { maxCols = rows[r].length; } }

    // Build a grid of <span> cells so we can mutate each glyph cheaply.
    splashEl.classList.add(introClass);
    splashEl.textContent = '';
    var cells = []; // cells[row][col] = { span, target, settled }
    for (var ri = 0; ri < rows.length; ri++) {
      var rowArr = [];
      var line = rows[ri];
      for (var ci = 0; ci < maxCols; ci++) {
        var ch = ci < line.length ? line[ci] : ' ';
        var span = document.createElement('span');
        if (ch === ' ') {
          span.textContent = ' ';
          rowArr.push({ span: span, target: ' ', settled: true });
        } else {
          span.textContent = MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];
          span.className = 'mx-cell';
          rowArr.push({ span: span, target: ch, settled: false });
        }
        splashEl.appendChild(span);
      }
      splashEl.appendChild(document.createTextNode('\n'));
      cells.push(rowArr);
    }

    // Schedule each non-space cell to "settle" at a staggered time so the
    // lock-in cascades top→bottom with a little per-column jitter.
    var settleAt = [];
    var lastSettle = 0;
    for (var rr = 0; rr < cells.length; rr++) {
      for (var cc = 0; cc < cells[rr].length; cc++) {
        if (cells[rr][cc].settled) { continue; }
        var t = SETTLE_BASE + rr * ROW_STEP + Math.random() * COL_JITTER;
        settleAt.push({ row: rr, col: cc, at: t });
        if (t > lastSettle) { lastSettle = t; }
      }
    }

    var start = performance.now();
    var rafId = null;
    function frame(now) {
      // Bail only if the splash was fully removed from the DOM (e.g. the chat
      // was cleared mid-intro). NOTE: the empty-state is built inside a
      // detached DocumentFragment and only mounted into #thread afterwards,
      // so we must NOT bail merely because isConnected is false — instead we
      // detect true orphaning: a removed node's root node is itself, whereas
      // a node living in a fragment has a DocumentFragment (nodeType 11) root.
      var root = splashEl.getRootNode();
      var orphaned = root === splashEl ||
        (root.nodeType !== 11 /* fragment */ && root.nodeType !== 9 /* document */);
      if (orphaned) { cancelAnimationFrame(rafId); return; }
      var elapsed = now - start;
      // Scramble every still-unsettled cell.
      for (var i = 0; i < settleAt.length; i++) {
        var s = settleAt[i];
        var cell = cells[s.row][s.col];
        if (cell.settled) { continue; }
        if (elapsed >= s.at) {
          cell.settled = true;
          cell.span.textContent = cell.target;
          cell.span.classList.add('mx-lock');
        } else {
          cell.span.textContent = MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];
        }
      }
      if (elapsed < lastSettle + TAIL) {
        rafId = requestAnimationFrame(frame);
      } else {
        // Done: collapse the grid back to plain text so the rest of the
        // app (and any ambient glow animation) treats it normally.
        splashEl.classList.remove(introClass);
        splashEl.textContent = rows.join('\n') + '\n';
        if (typeof opts.onDone === 'function') { opts.onDone(); }
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  // The Nexus splash decode (used on boot / new chat / new tab).
  function runMatrixIntro(splashEl, tab) {
    runMatrixDecode(splashEl, NEXUS_ASCII_ROWS, { introClass: 'splash-intro' });
  }

  // The orchestrate banner decode: faster cascade, then a 'neural link'
  // sweep handled in CSS via the .orch-live class added on completion.
  function runOrchestrateIntro(bannerEl) {
    runMatrixDecode(bannerEl, ORCH_ASCII_ROWS, {
      introClass: 'orch-decode',
      settleBase: 160,
      rowStep: 90,
      colJitter: 160,
      tail: 90,
      onDone: function () { bannerEl.classList.add('orch-live'); },
    });
  }

  TabState.prototype._appendEmptyState = function () {
    var isOrch = !!this.orchestrator;
    var art = isOrch ? ORCH_ASCII_ROWS : NEXUS_ASCII_ROWS;
    var splashCls = isOrch ? 'splash splash-orch' : 'splash';
    var subText = isOrch ? 'ORCHESTRATOR // STANDBY' : 'NEXUS v0.5 // READY';
    var div = document.createElement('div');
    div.id = 'empty-state-' + this.id;
    div.className = 'tab-empty-state';
    div.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;text-align:center;padding:20px 16px;min-height:200px;">' +
      '<pre class="' + splashCls + '">' +
      escHtml(art.join('\n')) + '\n' +
      '</pre>' +
      '<div class="empty-sub">' + subText + '</div>' +
      '<div class="empty-chips">' +
      '<button class="chip" data-quick="list workspace files">list workspace</button>' +
      '<button class="chip" data-quick="read the active editor file and explain it">read active file</button>' +
      '<button class="chip" data-quick="git status">git status</button>' +
      '<button class="chip" data-quick="find all TODO comments in the codebase">find TODOs</button>' +
      '</div></div>';
    this.threadFrag.appendChild(div);

    // Decode the splash every time a fresh empty-state is built: the
    // whole-page boot (webview load / reload), a NEW chat, and a NEW tab.
    // Each of those constructs a brand-new TabState whose empty-state is
    // built here, so the Matrix intro plays for all of them. Tab switches
    // and history replays do NOT rebuild the empty-state, so they keep
    // their existing content and never replay the decode.
    var splashEl = div.querySelector('.splash');
    if (splashEl) {
      if (isOrch) { runOrchestrateIntro(splashEl); }
      else { runMatrixIntro(splashEl, this); }
    }

    // Wire the chip buttons (they trigger sendMessage on this tab).
    var self = this;
    div.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        if (self !== getActiveTab()) { return; }
        var text = c.getAttribute('data-quick') || '';
        if (text) {
          inputEl.value = text;
          inputEl.dispatchEvent(new Event('input'));
          sendMessage();
        }
      });
    });
    // Also wire to a thoughts-empty placeholder.
    var tEmpty = document.createElement('div');
    tEmpty.className = 'thoughts-empty';
    tEmpty.textContent = "// no thoughts yet — they'll appear here as the agent reasons";
    this.thoughtsFrag.appendChild(tEmpty);
  };

  /** Remove the empty-state splash once the tab has real content. */
  TabState.prototype._removeEmptyState = function () {
    if (this.hasMessages) { return; }
    this.hasMessages = true;
    // If we're visible, find & remove the empty-state node from #thread.
    var es = document.getElementById('empty-state-' + this.id);
    if (es) { es.remove(); }
    // Also remove from the (detached) frag if not visible.
    var inFrag = this.threadFrag.querySelector('.tab-empty-state');
    if (inFrag) { inFrag.remove(); }
  };
  /**
   * Re-render the empty-state splash if the tab's orchestrator flag changed
   * AFTER construction (the flag is set by sessionsState/restore AFTER
   * `new TabState()` has already built the empty-state with default art).
   * No-op once the tab has real messages, or if the art already matches.
   */
  TabState.prototype._refreshEmptyStateArt = function () {
    if (this.hasMessages) { return; }
    var wantOrch = !!this.orchestrator;
    // Detect what's currently rendered: an orchestrate splash carries the
    // .splash-orch class. If it already matches what we want, do nothing.
    var liveEs = document.getElementById('empty-state-' + this.id);
    var fragEs = this.threadFrag.querySelector('.tab-empty-state');
    var es = liveEs || fragEs;
    if (es) {
      var hasOrch = !!es.querySelector('.splash-orch');
      if (hasOrch === wantOrch) { return; }
    }
    // Tear down the stale empty-state (live + frag) and rebuild with the
    // correct art. _appendEmptyState appends into threadFrag; if we're the
    // visible tab we also move the rebuilt node into #thread.
    if (liveEs) { liveEs.remove(); }
    if (fragEs) { fragEs.remove(); }
    var staleThoughts = this.thoughtsFrag.querySelector('.thoughts-empty');
    if (staleThoughts) { staleThoughts.remove(); }
    this._appendEmptyState();
    if (this === getActiveTab()) {
      var rebuilt = this.threadFrag.querySelector('.tab-empty-state');
      if (rebuilt) { threadEl.appendChild(rebuilt); }
    }
  };


  /** Get the live thread container — either #thread (if active) or the frag. */
  TabState.prototype.threadContainer = function () {
    return (this === getActiveTab()) ? threadEl : this.threadFrag;
  };
  TabState.prototype.thoughtsContainer = function () {
    return (this === getActiveTab()) ? thoughtsPanelBodyEl : this.thoughtsFrag;
  };
  TabState.prototype.imagesContainer = function () {
    return (this === getActiveTab()) ? pendingImagesEl : this.imagesFrag;
  };

  /** Re-render the pending-images chip strip (only if visible). */
  TabState.prototype.renderPendingImages = function () {
    var host = this.imagesContainer();
    host.innerHTML = '';
    var self = this;
    for (var i = 0; i < this.pendingImages.length; i++) {
      (function (img) {
        var chip = document.createElement('div');
        chip.className = 'pending-img-chip';
        chip.title = img.name;
        var preview = document.createElement('img');
        preview.src = img.dataUrl;
        preview.alt = img.name;
        chip.appendChild(preview);
        var rm = document.createElement('button');
        rm.className = 'pending-img-rm';
        rm.type = 'button';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          self.pendingImages = self.pendingImages.filter(function (i2) { return i2.id !== img.id; });
          self.renderPendingImages();
        });
        chip.appendChild(rm);
        host.appendChild(chip);
      })(this.pendingImages[i]);
    }
    // Toggle has-images class on the visible #pending-images host.
    if (this === getActiveTab()) {
      if (this.pendingImages.length > 0) { pendingImagesEl.classList.add('has-images'); }
      else { pendingImagesEl.classList.remove('has-images'); }
    }
  };

  // Auto-scroll respects two gates:
  //   1. autoScrollEnabled — the global "auto-scroll while streaming"
  //      setting. When off, we never auto-scroll.
  //   2. this.stickToBottom — per-tab; false once the user scrolls up,
  //      true again when they return to the bottom. THIS is the fix for
  //      the execute_command scroll-trap: a user reading earlier output
  //      while a command streams is no longer dragged to the bottom.
  TabState.prototype.scrollToBottom = function () {
    if (this !== getActiveTab()) { return; }
    if (!autoScrollEnabled) { return; }
    if (!this.stickToBottom) { return; }
    if (this._scrollRAF) { return; } // already scheduled — coalesce
    this._scrollRAF = requestAnimationFrame(function () {
      this._scrollRAF = null;
      threadEl.scrollTop = threadEl.scrollHeight;
    }.bind(this));
  };

  // Track whether the user is parked at the bottom of the thread. We
  // treat "within 40px of the bottom" as still sticky so sub-pixel /
  // scrollbar rounding doesn't spuriously disengage auto-scroll.
  if (threadEl) {
    threadEl.addEventListener('scroll', function () {
      var tab = getActiveTab();
      if (!tab) { return; }
      var gap = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
      tab.stickToBottom = gap < 40;
    });
  }

  // ─── Tab management ─────────────────────────────────────────────────────

  function getActiveTab() {
    if (!activeSessionId) { return null; }
    return tabs.get(activeSessionId) || null;
  }

  function getOrCreateTab(id, title) {
    var t = tabs.get(id);
    if (t) {
      if (title) { t.title = title; }
      return t;
    }
    t = new TabState(id, title);
    tabs.set(id, t);
    return t;
  }

  // ─── Shared DOM/state helpers (dedup) ───────────────────────────────────
  function clearChildren(el) { while (el.firstChild) { el.firstChild.remove(); } }
  function clearHostDOM() {
    clearChildren(threadEl);
    clearChildren(thoughtsPanelBodyEl);
    clearChildren(pendingImagesEl);
    pendingImagesEl.classList.remove('has-images');
  }
  function resetTabRenderState(tab) {
    tab.messageCount = 0;
    tab.currentAgentBlock = null;
    tab.currentAgentText = '';
    tab.pendingImages = [];
    tab.inputDraft = '';
    if (tab.thinkingInterval) { clearInterval(tab.thinkingInterval); tab.thinkingInterval = null; }
    tab.thinkingBlock = null;
    if (tab.writingInterval) { clearInterval(tab.writingInterval); tab.writingInterval = null; }
    tab.writingBlock = null;
    tab.currentThoughtSessionEl = null; tab.currentThoughtSessionTextEl = null;
    tab.currentThoughtSessionText = ''; tab.totalThoughtSessions = 0;
    tab.thoughtsStreaming = false;
    tab.thoughtsStatus = '// idle';
    tab.isStreaming = false;
  }

  /**
   * Re-key the currently active tab to a NEW sessionId. Used when the
   * provider replaces a session under the hood (e.g. loading a history
   * row spawns a brand-new session with a fresh id). We keep the SAME
   * TabState object — and therefore its already-mounted DOM — but move
   * it to the new key in the `tabs` map and repoint `activeSessionId`.
   *
   * Without this, the active tab would keep its dead old id: outgoing
   * 'sendMessage' would carry the stale id (the provider has no such
   * session, so the prompt is silently dropped and the agent never
   * "thinks"), and inbound events for the new id would fail the
   * `tabs.get(sid)` lookup so nothing ever renders.
   *
   * @param {string} newId  the new sessionId from the provider
   * @param {string} [title] optional new title
   */
  function rekeyActiveTab(newId, title) {
    if (!newId) { return; }
    var tab = getActiveTab();
    if (!tab) {
      // No active tab to re-key — create a fresh one under the new id.
      var fresh = getOrCreateTab(newId, title);
      activeSessionId = newId;
      return fresh;
    }
    if (tab.id === newId) {
      if (title) { tab.title = title; }
      return tab;
    }
    var oldId = tab.id;
    tabs.delete(oldId);
    tab.id = newId;
    if (title) { tab.title = title; }
    // Stale render flags from the old (now-dead) session must not leak.
    tab.isStreaming = false;
    tab.running = false;
    tabs.set(newId, tab);
    activeSessionId = newId;
    return tab;
  }

  /**
   * Make `id` the visible tab. Detaches the old tab's DOM into its
   * fragments, attaches the new tab's DOM into the host elements, and
   * repaints supporting UI (model dropdown, skill dropdown, token bar,
   * tab strip active highlight, input draft).
   */
  function switchTab(id) {
    if (!tabs.has(id)) { return; }
    if (id === activeSessionId) { return; }

    // 1. Stow the OUTGOING tab's DOM into its fragments.
    var prev = getActiveTab();
    if (prev) {
      // Move thread children → prev.threadFrag (Range-based bulk extraction)
      var _r = document.createRange();
      if (threadEl.firstChild) { _r.selectNodeContents(threadEl); prev.threadFrag.appendChild(_r.extractContents()); }
      // Move thoughts body → prev.thoughtsFrag
      if (thoughtsPanelBodyEl.firstChild) { _r.selectNodeContents(thoughtsPanelBodyEl); prev.thoughtsFrag.appendChild(_r.extractContents()); }
      // Move pending images → prev.imagesFrag
      if (pendingImagesEl.firstChild) { _r.selectNodeContents(pendingImagesEl); prev.imagesFrag.appendChild(_r.extractContents()); }
      // Stow input draft & class state
      prev.inputDraft = inputEl.value;
    } else {
      // Previous tab was deleted (e.g. newChat replaced it) — just
      // clear the host DOM so the new tab starts clean.
      clearHostDOM();
    }

    // 2. Activate new tab.
    activeSessionId = id;
    var next = getActiveTab();
    if (!next) { return; }

    // 3. Mount the new tab's DOM into the host elements (appendChild of a
    // DocumentFragment moves all children in one shot — no loop needed).
    threadEl.appendChild(next.threadFrag);
    thoughtsPanelBodyEl.appendChild(next.thoughtsFrag);
    pendingImagesEl.appendChild(next.imagesFrag);

    // 4. Repaint supporting UI.
    inputEl.value = next.inputDraft || '';
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    if (next.pendingImages.length > 0) { pendingImagesEl.classList.add('has-images'); }
    else { pendingImagesEl.classList.remove('has-images'); }
    // Stop button stays visible for the whole turn (incl. long-running
    // tool calls like delegate_task), not just while the LLM is mid-
    // stream — so OR `running` with `isStreaming` when re-mounting a
    // tab. Otherwise switching to a tab that is currently fanning work
    // out to sub-agents would hide the Stop button.
    setStreaming(!!(next.isStreaming || next.running));
    if (next.model && modelSelect) { modelSelect.value = next.model; }
    if (skillSelect) { skillSelect.value = next.skillName || ''; }
    updateTokenBarFromTab(next);
    updateThoughtsStatus(next.thoughtsStatus || '// idle');
    if (next.thoughtsStreaming) { thoughtsPanelEl.classList.add('thoughts-streaming'); }
    else { thoughtsPanelEl.classList.remove('thoughts-streaming'); }
    // Switching tabs re-engages stickiness so the mounted tab shows
    // its latest output.
    next.stickToBottom = true;
    next.scrollToBottom();
    renderTabStrip();

    // Notify provider so it can fire any future tab-switched events.
    vscode.postMessage({ type: 'switchTab', sessionId: id });
  }

  /** Render the tab strip from the current tabs map. Hides if only one tab. */
  function renderTabStrip() {
    if (!tabStripEl) { return; }
    // Clear existing tab items but keep the [+] and [▣ DEPLOY] buttons.
    var children = Array.from(tabStripEl.children);
    children.forEach(function (c) {
      if (c !== tabNewBtn && c !== tabOrchBtn) { c.remove(); }
    });

    // Insert tab items in insertion order BEFORE the [+] button.
    var idx = 0;
    tabs.forEach(function (tab) {
      idx++;
      var item = document.createElement('div');
      item.className = 'tab-item' + (tab.id === activeSessionId ? ' tab-active' : '');
      item.title = tab.title;
      // Index label
      var nLabel = document.createElement('span');
      nLabel.textContent = '[' + idx + ']';
      item.appendChild(nLabel);
      // Orchestrator badge
      if (tab.orchestrator) {
        var ob = document.createElement('span');
        ob.className = 'tab-orch-badge';
        ob.textContent = '▣';
        ob.title = 'Deploy-agents tab';
        item.appendChild(ob);
      }
      // Title
      var t = document.createElement('span');
      var displayTitle = tab.title || 'chat';
      if (displayTitle.length > 18) { displayTitle = displayTitle.substring(0, 17) + '…'; }
      t.textContent = displayTitle;
      item.appendChild(t);
      // Running indicator
      if (tab.running) {
        var r = document.createElement('span');
        r.className = 'tab-running';
        r.textContent = '*';
        item.appendChild(r);
      }
      // Close button
      var closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeTab(tab.id);
      });
      item.appendChild(closeBtn);

      item.addEventListener('click', function () { switchTab(tab.id); });
      tabStripEl.insertBefore(item, tabNewBtn);
    });

    // Show strip only when 2+ tabs (the [+] always lives inside but we
    // hide the strip entirely when there's just one chat to keep the
    // single-tab UX uncluttered).
    if (tabs.size >= 2) { tabStripEl.classList.add('has-tabs'); }
    else { tabStripEl.classList.remove('has-tabs'); }
  }

  function closeTab(id) {
    var tab = tabs.get(id);
    if (!tab) { return; }
    if (tab.running) {
      if (!confirm('Tab "' + tab.title + '" is still running. Close anyway?')) { return; }
    }
    // Tell the provider — it will remove its session and possibly
    // promote another tab to active. We optimistically remove our local
    // copy but wait for the next sessionsState/init to fully sync.
    if (id === activeSessionId) {
      // Switch to another tab if possible; otherwise the provider's
      // closeTab handler will create a fresh one and notify us.
      var others = Array.from(tabs.keys()).filter(function (k) { return k !== id; });
      if (others.length > 0) { switchTab(others[0]); }
    }
    tabs.delete(id);
    vscode.postMessage({ type: 'closeTab', sessionId: id });
    renderTabStrip();
  }

  function newTab() {
    vscode.postMessage({ type: 'newTab' });
  }
  function newOrchestratorTab() {
    vscode.postMessage({ type: 'newOrchestratorTab' });
  }

  // ─── Pending images (delegated to active tab) ─────────────────────────

  function ingestFiles(fileLike) {
    if (!fileLike) { return; }
    var tab = getActiveTab();
    if (!tab) { return; }
    for (var i = 0; i < fileLike.length; i++) {
      var f = fileLike[i];
      if (!f || !f.type || f.type.indexOf('image/') !== 0) { continue; }
      addImageFile(tab, f);
    }
  }

  function addImageFile(tab, file) {
    if (!file) { return; }
    if (tab.pendingImages.length >= MAX_IMAGES) {
      appendSysNote(tab, 'Image limit reached (' + MAX_IMAGES + ').', true);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      appendSysNote(tab, 'Image too large (max 8MB): ' + (file.name || 'pasted'), true);
      return;
    }
    var reader = new FileReader();
    reader.onload = function (ev) {
      var dataUrl = ev.target && typeof ev.target.result === 'string' ? ev.target.result : '';
      if (dataUrl.indexOf('data:image/') !== 0) {
        appendSysNote(tab, 'Failed to read image as data URL', true);
        return;
      }
      tab.pendingImageCounter++;
      tab.pendingImages.push({
        id: tab.pendingImageCounter,
        name: file.name || ('pasted-' + tab.pendingImageCounter),
        dataUrl: dataUrl,
      });
      tab.renderPendingImages();
    };
    reader.onerror = function () {
      appendSysNote(tab, 'Failed to read image: ' + (file.name || 'pasted'), true);
    };
    reader.readAsDataURL(file);
  }

  // [IMAGE] button
  if (attachImageBtn && imageFileInput) {
    attachImageBtn.addEventListener('click', function () { imageFileInput.click(); });
    imageFileInput.addEventListener('change', function () {
      ingestFiles(imageFileInput.files);
      imageFileInput.value = '';
    });
  }

  // Paste images
  inputEl.addEventListener('paste', function (e) {
    if (!e.clipboardData) { return; }
    var items = e.clipboardData.items;
    if (!items || items.length === 0) { return; }
    var imageFiles = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile();
        if (f) { imageFiles.push(f); }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      ingestFiles(imageFiles);
    }
  });

  // Drag-and-drop
  var dragDepth = 0;
  function showDropOverlay() { if (dropOverlayEl) { dropOverlayEl.classList.add('active'); } }
  function hideDropOverlay() { if (dropOverlayEl) { dropOverlayEl.classList.remove('active'); } }
  document.addEventListener('dragenter', function (e) {
    if (!e.dataTransfer) { return; }
    var hasFiles = false;
    if (e.dataTransfer.types) {
      for (var i = 0; i < e.dataTransfer.types.length; i++) {
        if (e.dataTransfer.types[i] === 'Files') { hasFiles = true; break; }
      }
    }
    if (!hasFiles) { return; }
    dragDepth++;
    showDropOverlay();
  });
  document.addEventListener('dragover', function (e) {
    if (dragDepth > 0) { e.preventDefault(); }
  });
  document.addEventListener('dragleave', function () {
    if (dragDepth > 0) { dragDepth--; }
    if (dragDepth === 0) { hideDropOverlay(); }
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer) { return; }
    e.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      ingestFiles(e.dataTransfer.files);
    }
  });

  // ─── Input + controls ──────────────────────────────────────────────────

  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    var tab = getActiveTab();
    if (tab) { tab.inputDraft = inputEl.value; }
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', function () {
    var tab = getActiveTab();
    if (!tab) { return; }
    vscode.postMessage({ type: 'stopGeneration', sessionId: tab.id });
  });
  if (tabNewBtn) { tabNewBtn.addEventListener('click', newTab); }
  if (tabOrchBtn) { tabOrchBtn.addEventListener('click', newOrchestratorTab); }
  attachEditorBtn.addEventListener('click', function () {
    var tab = getActiveTab();
    vscode.postMessage({ type: 'attachActiveEditor', sessionId: tab ? tab.id : undefined });
  });

  modelSelect.addEventListener('change', function () {
    var tab = getActiveTab();
    if (tab) { tab.model = modelSelect.value; }
    vscode.postMessage({ type: 'setModel', model: modelSelect.value, sessionId: tab ? tab.id : undefined });
  });
  skillSelect.addEventListener('change', function () {
    var tab = getActiveTab();
    if (tab) { tab.skillName = skillSelect.value; }
    vscode.postMessage({ type: 'setSkill', skill: skillSelect.value, sessionId: tab ? tab.id : undefined });
  });

  // History
  if (historyBtn) {
    historyBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'requestHistory' });
      showHistoryOverlay();
    });
  }
  if (historyPanelClose) { historyPanelClose.addEventListener('click', hideHistoryOverlay); }
  if (historyOverlay) {
    historyOverlay.addEventListener('click', function (e) {
      if (e.target === historyOverlay) { hideHistoryOverlay(); }
    });
  }
  // VS Code webviews do NOT reliably support window.confirm() — it
  // silently returns false / never opens, so a one-click delete-with-
  // confirm flow never fires the actual delete. We use a two-click
  // confirmation pattern instead: first click arms the button (label
  // changes to "[CONFIRM?]" in red), second click within 3s performs
  // the action; clicking elsewhere or waiting >3s disarms.
  /** @param {HTMLButtonElement} btn  @param {string} originalLabel  @param {() => void} action */
  function armTwoClickConfirm(btn, originalLabel, action) {
    var disarmBtn = function () {
      if (btn.dataset.armed !== '1') { return; }
      btn.dataset.armed = '0';
      btn.textContent = originalLabel;
      btn.classList.remove('btn-armed');
    };
    if (btn.dataset.armed === '1') {
      // Second click — fire the action.
      disarmBtn();
      action();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = '[CONFIRM?]';
    btn.classList.add('btn-armed');
    var timeoutId = setTimeout(function () { disarmBtn(); document.removeEventListener('click', disarm, true); }, 3000);
    // If the user clicks anywhere else, disarm immediately.
    var disarm = function (e) {
      if (e.target === btn) { return; }
      clearTimeout(timeoutId);
      disarmBtn();
      document.removeEventListener('click', disarm, true);
    };
    setTimeout(function () { document.addEventListener('click', disarm, true); }, 0);
  }
  if (historyClearAllBtn) {
    historyClearAllBtn.addEventListener('click', function () {
      if (!lastHistorySessions || lastHistorySessions.length === 0) { return; }
      armTwoClickConfirm(historyClearAllBtn, '[CLEAR ALL]', function () {
        vscode.postMessage({ type: 'clearHistory' });
      });
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && historyOverlay && historyOverlay.classList.contains('active')) {
      hideHistoryOverlay();
    }
  });

  // Settings
  settingsBtn.addEventListener('click', function () {
    settingsOpen = !settingsOpen;
    settingsPanel.style.display = settingsOpen ? 'block' : 'none';
    settingsBtn.textContent = settingsOpen ? '[CFG*]' : '[CFG]';
  });
  // All settings toggles funnel through the same setAutoApprove channel;
  // the host generalizes the key handling and persists each one.
  if (autoApproveWriteToggle) {
    autoApproveWriteToggle.addEventListener('change', function () {
      autoApprove.write_file = autoApproveWriteToggle.checked;
      vscode.postMessage({ type: 'setAutoApprove', key: 'write_file', value: autoApproveWriteToggle.checked });
    });
  }
  if (autoApproveExecToggle) {
    autoApproveExecToggle.addEventListener('change', function () {
      autoApprove.execute_command = autoApproveExecToggle.checked;
      vscode.postMessage({ type: 'setAutoApprove', key: 'execute_command', value: autoApproveExecToggle.checked });
    });
  }
  if (autoScrollToggle) {
    autoScrollToggle.addEventListener('change', function () {
      autoScrollEnabled = autoScrollToggle.checked;
      autoApprove.auto_scroll = autoScrollToggle.checked;
      if (autoScrollEnabled) {
        var t = getActiveTab();
        if (t) { t.stickToBottom = true; t.scrollToBottom(); }
      }
      vscode.postMessage({ type: 'setAutoApprove', key: 'auto_scroll', value: autoScrollToggle.checked });
    });
  }
  if (showThinkingToggle) {
    showThinkingToggle.addEventListener('change', function () {
      autoApprove.show_thinking = showThinkingToggle.checked;
      // UNchecked => hide the thinking / reasoning UI.
      document.body.classList.toggle('hide-thinking', !showThinkingToggle.checked);
      vscode.postMessage({ type: 'setAutoApprove', key: 'show_thinking', value: showThinkingToggle.checked });
    });
  }
  if (stripEmojisToggle) {
    stripEmojisToggle.addEventListener('change', function () {
      stripEmojisEnabled = stripEmojisToggle.checked;
      autoApprove.strip_emojis = stripEmojisToggle.checked;
      vscode.postMessage({ type: 'setAutoApprove', key: 'strip_emojis', value: stripEmojisToggle.checked });
    });
  }
  if (compactToolToggle) {
    compactToolToggle.addEventListener('change', function () {
      autoApprove.compact_tool = compactToolToggle.checked;
      document.body.classList.toggle('compact-tool-output', compactToolToggle.checked);
      vscode.postMessage({ type: 'setAutoApprove', key: 'compact_tool', value: compactToolToggle.checked });
    });
  }

  // Approval
  approvalAllowBtn.addEventListener('click', function () {
    if (!currentApprovalId) { return; }
    var id = currentApprovalId, toolName = currentApprovalToolName;
    hideApprovalBar();
    var tab = getActiveTab();
    if (tab) { addApprovalNote(tab, toolName, true); }
    vscode.postMessage({ type: 'approvalResponse', id: id, approved: true });
  });
  approvalDenyBtn.addEventListener('click', function () {
    if (!currentApprovalId) { return; }
    var id = currentApprovalId, toolName = currentApprovalToolName;
    hideApprovalBar();
    var tab = getActiveTab();
    if (tab) { addApprovalNote(tab, toolName, false); }
    vscode.postMessage({ type: 'approvalResponse', id: id, approved: false });
  });
  // Batch approval — ALLOW ALL / DENY ALL clear the whole queue at once.
  if (approvalAllowAllBtn) {
    approvalAllowAllBtn.addEventListener('click', function () {
      var toolName = currentApprovalToolName;
      hideApprovalBar();
      var tab = getActiveTab();
      if (tab) { addApprovalNote(tab, toolName + ' (+ queue)', true); }
      vscode.postMessage({ type: 'approvalResponseAll', approved: true });
    });
  }
  if (approvalDenyAllBtn) {
    approvalDenyAllBtn.addEventListener('click', function () {
      var toolName = currentApprovalToolName;
      hideApprovalBar();
      var tab = getActiveTab();
      if (tab) { addApprovalNote(tab, toolName + ' (+ queue)', false); }
      vscode.postMessage({ type: 'approvalResponseAll', approved: false });
    });
  }

  function showApprovalBar(approvalId, toolName, toolInput, sessionTitle, queueDepth) {
    // All file-mutating tools share the write_file auto-approve gate.
    var WRITE_GATE_TOOLS = ['write_file', 'replace_in_file', 'insert_in_file', 'delete_file', 'move_file'];
    var gateKey = WRITE_GATE_TOOLS.indexOf(toolName) !== -1 ? 'write_file' : toolName;
    if (autoApprove[gateKey]) {
      var tab = getActiveTab();
      if (tab) { addApprovalNote(tab, toolName, true); }
      vscode.postMessage({ type: 'approvalResponse', id: approvalId, approved: true });
      return;
    }
    currentApprovalId = approvalId;
    currentApprovalToolName = toolName;
    var titleText = toolName.toUpperCase();
    if (sessionTitle && tabs.size >= 2) { titleText = '[' + sessionTitle + '] ' + titleText; }
    approvalBarTitle.textContent = titleText;
    var inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
    approvalBarPreview.textContent = inputStr.length > 600 ? inputStr.substring(0, 600) + '\n...' : inputStr;
    // Batch-approval affordances: when more approvals are queued behind
    // this one, surface a "(+N more queued)" note and reveal the
    // ALLOW ALL / DENY ALL buttons. With an empty queue (queueDepth 0),
    // single approvals look exactly as before.
    var depth = typeof queueDepth === 'number' ? queueDepth : 0;
    if (approvalQueueCount) {
      approvalQueueCount.textContent = depth > 0 ? ('(+' + depth + ' more queued)') : '';
    }
    if (approvalAllowAllBtn) { approvalAllowAllBtn.style.display = depth > 0 ? 'flex' : 'none'; }
    if (approvalDenyAllBtn) { approvalDenyAllBtn.style.display = depth > 0 ? 'flex' : 'none'; }
    approvalBar.style.display = 'flex';
  }
  function hideApprovalBar() {
    approvalBar.style.display = 'none';
    currentApprovalId = null;
    currentApprovalToolName = '';
    if (approvalQueueCount) { approvalQueueCount.textContent = ''; }
    if (approvalAllowAllBtn) { approvalAllowAllBtn.style.display = 'none'; }
    if (approvalDenyAllBtn) { approvalDenyAllBtn.style.display = 'none'; }
  }

  function addApprovalNote(tab, toolName, approved) {
    tab._removeEmptyState();
    var note = document.createElement('div');
    note.className = 'approval-note ' + (approved ? 'note-allowed' : 'note-denied');
    note.textContent = (approved ? '[ALLOWED] ' : '[DENIED]  ') + toolName;
    tab.threadContainer().appendChild(note);
    tab.scrollToBottom();
  }

  // Send
  function sendMessage() {
    var tab = getActiveTab();
    if (!tab) { return; }
    if (tab.isStreaming) { return; }
    var text = inputEl.value.trim();
    var images = tab.pendingImages.map(function (i) { return i.dataUrl; });
    if (!text && images.length === 0) { return; }
    appendUserMessage(tab, text, images);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    tab.inputDraft = '';
    tab.pendingImages = [];
    tab.renderPendingImages();
    // Sending a new message re-engages auto-scroll so the user follows
    // their own prompt and the response.
    tab.stickToBottom = true;
    vscode.postMessage({ type: 'sendMessage', text: text, images: images, sessionId: tab.id });
  }

  // ─── Per-tab DOM rendering helpers ─────────────────────────────────────

  function appendUserMessage(tab, text, images) {
    tab._removeEmptyState();
    tab.messageCount++;
    var block = document.createElement('div');
    block.className = 'user-block';
    block.id = 'msg-' + tab.id + '-' + tab.messageCount;
    if (text) {
      var textNode = document.createElement('div');
      textNode.textContent = '> ' + text;
      block.appendChild(textNode);
    }
    if (images && images.length > 0) {
      var imgsRow = document.createElement('div');
      imgsRow.className = 'user-block-images';
      images.forEach(function (dataUrl) {
        var i = document.createElement('img');
        i.src = dataUrl; i.alt = 'attached image';
        i.addEventListener('click', function () {
          var w = window.open();
          if (w) { w.document.body.style.margin = '0'; w.document.body.innerHTML = '<img src="' + dataUrl + '" style="max-width:100%;max-height:100%;display:block;margin:auto;">'; }
        });
        imgsRow.appendChild(i);
      });
      block.appendChild(imgsRow);
    }
    tab.threadContainer().appendChild(block);
    tab.scrollToBottom();
  }

  function showThinking(tab) {
    tab._removeEmptyState();
    tab.messageCount++;
    var block = document.createElement('div');
    block.className = 'thinking-block';
    block.id = 'thinking-' + tab.id + '-' + tab.messageCount;
    var line = document.createElement('div');
    line.className = 'thinking-line';
    var spinner = document.createElement('span');
    spinner.className = 'thinking-spinner';
    spinner.textContent = '|';
    var label = document.createElement('span');
    label.className = 'thinking-label';
    // Start on a RANDOM word so successive runs don't always open with
    // the same one; the cycle then continues from there.
    var startWordIdx = Math.floor(Math.random() * THINKING_WORDS.length);
    label.textContent = ' ' + THINKING_WORDS[startWordIdx];
    var dots = document.createElement('span');
    dots.className = 'thinking-dots';
    line.appendChild(spinner); line.appendChild(label); line.appendChild(dots);
    block.appendChild(line);
    var noise = document.createElement('div');
    noise.className = 'thinking-noise';
    block.appendChild(noise);
    tab.threadContainer().appendChild(block);
    tab.scrollToBottom();

    var spinIdx = 0; var dotCount = 0; var tick = 0; var wordIdx = startWordIdx;
    var hexChars = '0123456789ABCDEF';
    tab.thinkingInterval = setInterval(function () {
      if (tab !== getActiveTab()) { return; } // skip DOM work when tab hidden
      spinIdx = (spinIdx + 1) % SPIN_CHARS.length;
      spinner.textContent = SPIN_CHARS[spinIdx];
      dotCount = (dotCount + 1) % 4;
      dots.textContent = '.'.repeat(dotCount);
      // Every ~10 ticks (~800ms) blink to the next word in the loop.
      tick++;
      if (tick % 10 === 0) {
        // Brief blank "blink" then swap to the next word.
        label.textContent = '';
        wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
        setTimeout(function () {
          if (label.isConnected) { label.textContent = ' ' + THINKING_WORDS[wordIdx]; }
        }, 90);
      }
      var s = '';
      for (var i = 0; i < 24; i++) {
        s += hexChars[Math.floor(Math.random() * hexChars.length)];
        if (i % 4 === 3 && i < 23) { s += ' '; }
      }
      noise.textContent = s;
    }, 80);
    tab.thinkingBlock = block;
  }
  function hideThinking(tab) {
    if (tab.thinkingInterval) { clearInterval(tab.thinkingInterval); tab.thinkingInterval = null; }
    if (tab.thinkingBlock) { tab.thinkingBlock.remove(); tab.thinkingBlock = null; }
  }

  // Thoughts panel session lifecycle (per-tab)
  function showThoughtBubble(tab) {
    var host = tab.thoughtsContainer();
    var empty = host.querySelector('.thoughts-empty');
    if (empty) { empty.remove(); }
    tab.totalThoughtSessions++;
    var session = document.createElement('div');
    session.className = 'thoughts-session';
    var head = document.createElement('div');
    head.className = 'thoughts-session-head';
    var idx = document.createElement('span');
    idx.className = 'thoughts-session-idx';
    idx.textContent = '#' + tab.totalThoughtSessions;
    var ts = document.createElement('span');
    ts.className = 'thoughts-session-ts';
    var d = new Date();
    ts.textContent = ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
    head.appendChild(idx); head.appendChild(ts);
    var bodyEl = document.createElement('pre');
    bodyEl.className = 'thoughts-session-body';
    session.appendChild(head); session.appendChild(bodyEl);
    host.appendChild(session);
    if (tab === getActiveTab()) { thoughtsPanelBodyEl.scrollTop = thoughtsPanelBodyEl.scrollHeight; }
    tab.currentThoughtSessionEl = session;
    tab.currentThoughtSessionTextEl = bodyEl;
    tab.currentThoughtSessionText = '';
    tab.thoughtsStreaming = true;
    if (tab === getActiveTab()) { thoughtsPanelEl.classList.add('thoughts-streaming'); }
    tab.thoughtsStatus = '// session #' + tab.totalThoughtSessions + ' streaming...';
    if (tab === getActiveTab()) { updateThoughtsStatus(tab.thoughtsStatus); }
  }
  function appendThoughtChunk(tab, chunk) {
    if (!tab.currentThoughtSessionTextEl || !tab.currentThoughtSessionTextEl.isConnected) {
      // Connection lost (tab swapped) — re-create.
      showThoughtBubble(tab);
    }
    if (tab.currentThoughtSessionTextEl) {
      tab.currentThoughtSessionText += chunk;
      tab.currentThoughtSessionTextEl.textContent = tab.currentThoughtSessionText;
      if (tab === getActiveTab()) { thoughtsPanelBodyEl.scrollTop = thoughtsPanelBodyEl.scrollHeight; }
      var preview = summarizeForStatus(tab.currentThoughtSessionText);
      if (preview) {
        tab.thoughtsStatus = '// ' + preview;
        if (tab === getActiveTab()) { updateThoughtsStatus(tab.thoughtsStatus); }
      }
    }
  }
  function finalizeThoughtBubble(tab) {
    if (tab.currentThoughtSessionEl) { tab.currentThoughtSessionEl.classList.add('thoughts-session-done'); }
    tab.currentThoughtSessionEl = null;
    tab.currentThoughtSessionTextEl = null;
    tab.currentThoughtSessionText = '';
    tab.thoughtsStreaming = false;
    if (tab === getActiveTab()) { thoughtsPanelEl.classList.remove('thoughts-streaming'); }
    if (tab.totalThoughtSessions > 0) {
      tab.thoughtsStatus = '// ' + tab.totalThoughtSessions + ' session' + (tab.totalThoughtSessions === 1 ? '' : 's') + ' — click to expand';
    } else {
      tab.thoughtsStatus = '// idle';
    }
    if (tab === getActiveTab()) { updateThoughtsStatus(tab.thoughtsStatus); }
  }
  function summarizeForStatus(text) {
    if (!text) { return ''; }
    var lines = text.split('\n');
    var line = '';
    for (var i = lines.length - 1; i >= 0; i--) {
      var t = lines[i].trim();
      if (t) { line = t; break; }
    }
    if (line.length > 60) { line = line.substring(0, 57) + '...'; }
    return line;
  }
  function updateThoughtsStatus(text) {
    if (thoughtsPanelStatusEl) { thoughtsPanelStatusEl.textContent = text || ''; }
  }
  function isThoughtsPanelOpen() {
    return thoughtsPanelEl && thoughtsPanelEl.classList.contains('thoughts-open');
  }
  function setThoughtsPanelOpen(open) {
    if (!thoughtsPanelEl) { return; }
    if (open) {
      thoughtsPanelEl.classList.add('thoughts-open');
      if (thoughtsChevronEl) { thoughtsChevronEl.textContent = '[-]'; }
      if (thoughtsPanelBodyEl) { thoughtsPanelBodyEl.scrollTop = thoughtsPanelBodyEl.scrollHeight; }
    } else {
      thoughtsPanelEl.classList.remove('thoughts-open');
      if (thoughtsChevronEl) { thoughtsChevronEl.textContent = '[+]'; }
    }
  }
  if (thoughtsPanelHeaderEl) {
    thoughtsPanelHeaderEl.addEventListener('click', function () { setThoughtsPanelOpen(!isThoughtsPanelOpen()); });
  }
  if (thoughtsClearBtn) {
    thoughtsClearBtn.addEventListener('click', function () {
      var tab = getActiveTab();
      if (!tab) { return; }
      var host = tab.thoughtsContainer();
      host.innerHTML = '<div class="thoughts-empty">// no thoughts yet</div>';
      tab.currentThoughtSessionEl = null;
      tab.currentThoughtSessionTextEl = null;
      tab.currentThoughtSessionText = '';
      tab.totalThoughtSessions = 0;
      tab.thoughtsStatus = '// cleared';
      updateThoughtsStatus(tab.thoughtsStatus);
    });
  }

  // Writing/editing block
  function showWriting(tab, toolName) {
    if (tab.writingBlock) { updateWritingTool(tab, toolName); return; }
    hideThinking(tab);
    tab.writingToolName = toolName || 'write_file';
    tab.messageCount++;
    var block = document.createElement('div');
    block.className = 'writing-block' + ((tab.writingToolName === 'replace_in_file' || tab.writingToolName === 'insert_in_file') ? ' editing' : '');
    block.id = 'writing-' + tab.id + '-' + tab.messageCount;
    var line = document.createElement('div');
    line.className = 'writing-line';
    var spinner = document.createElement('span');
    spinner.className = 'writing-spinner';
    spinner.textContent = '|';
    var label = document.createElement('span');
    label.className = 'writing-label';
    var initialWords = (tab.writingToolName === 'replace_in_file' || tab.writingToolName === 'insert_in_file') ? PATCHING_WORDS : WRITING_WORDS;
    // Random starting word so writes/patches don't always open the same.
    var startWWordIdx = Math.floor(Math.random() * initialWords.length);
    label.textContent = ' ' + initialWords[startWWordIdx];
    var fileSpan = document.createElement('span');
    fileSpan.className = 'writing-file';
    fileSpan.textContent = '';
    var dots = document.createElement('span');
    dots.className = 'writing-dots';
    line.appendChild(spinner); line.appendChild(label); line.appendChild(fileSpan); line.appendChild(dots);
    block.appendChild(line);
    var bar = document.createElement('div');
    bar.className = 'writing-bar';
    block.appendChild(bar);
    tab.threadContainer().appendChild(block);
    tab.scrollToBottom();
    var spinIdx = 0; var dotCount = 0; var wtick = 0; var wWordIdx = startWWordIdx;
    tab.writingInterval = setInterval(function () {
      if (tab !== getActiveTab()) { return; } // skip DOM work when tab hidden
      spinIdx = (spinIdx + 1) % SPIN_CHARS.length;
      spinner.textContent = SPIN_CHARS[spinIdx];
      dotCount = (dotCount + 1) % 4;
      dots.textContent = '.'.repeat(dotCount);
      // Every ~8 ticks (~800ms) blink to the next word in the loop. Pick
      // the word list live so it follows write_file ↔ replace_in_file.
      wtick++;
      if (wtick % 8 === 0) {
        var words = (tab.writingToolName === 'replace_in_file' || tab.writingToolName === 'insert_in_file') ? PATCHING_WORDS : WRITING_WORDS;
        label.textContent = '';
        wWordIdx = (wWordIdx + 1) % words.length;
        setTimeout(function () {
          if (label.isConnected) {
            var w = (tab.writingToolName === 'replace_in_file' || tab.writingToolName === 'insert_in_file') ? PATCHING_WORDS : WRITING_WORDS;
            label.textContent = ' ' + w[wWordIdx % w.length];
          }
        }, 90);
      }
    }, 100);
    tab.writingBlock = block;

    tab.writingLabelEl = label;

    tab.writingFileEl = fileSpan;
  }
  function updateWritingTool(tab, toolName) {
    if (!tab.writingBlock || !tab.writingLabelEl) { return; }
    tab.writingToolName = toolName || tab.writingToolName;
    // The label text is driven by the animation loop now; just toggle
    // the editing class and let the next tick pick the right word list.
    if (tab.writingToolName === 'replace_in_file' || tab.writingToolName === 'insert_in_file') {
      tab.writingBlock.classList.add('editing');
      tab.writingLabelEl.textContent = ' ' + PATCHING_WORDS[Math.floor(Math.random() * PATCHING_WORDS.length)];
    } else {
      tab.writingBlock.classList.remove('editing');
      tab.writingLabelEl.textContent = ' ' + WRITING_WORDS[Math.floor(Math.random() * WRITING_WORDS.length)];
    }
  }
  function setWritingFile(tab, baseName) {
    if (!tab.writingFileEl) { return; }
    tab.writingFileEl.textContent = baseName ? ' ' + baseName : '';
  }
  function hideWriting(tab) {
    if (tab.writingInterval) { clearInterval(tab.writingInterval); tab.writingInterval = null; }
    if (tab.writingBlock) { tab.writingBlock.remove(); tab.writingBlock = null; }
    tab.writingFileEl = null; tab.writingLabelEl = null;
    tab.writingToolName = '';
  }

  function startAgentBlock(tab) {
    tab._removeEmptyState();
    tab.messageCount++;
    var block = document.createElement('div');
    block.className = 'agent-block';
    block.id = 'msg-' + tab.id + '-' + tab.messageCount;
    var streamSpan = document.createElement('span');
    streamSpan.className = 'streaming-text';
    block.appendChild(streamSpan);
    var cursor = document.createElement('span');
    cursor.className = 'blinking-cursor';
    cursor.textContent = '_';
    block.appendChild(cursor);
    tab.threadContainer().appendChild(block);
    tab.scrollToBottom();
    tab.currentAgentBlock = block;
    tab.currentAgentText = '';
    tab._streamingSpan = streamSpan;
    tab._echoSplitIdx = -1;
    tab.lastRenderedLength = 0;
    return block;
  }
  // The model sometimes ECHOES a tool result back as plain assistant
  // prose, literally typing "[tool <name> result]\n<dump>". Detect that
  // marker and split the message into the real prose before it and the
  // echoed dump after it. Returns { prose, dump } or null.
  function splitToolEcho(text) {
    if (!text) { return null; }
    var m = text.match(/\[tool\s+[\w-]+\s+result\]/i);
    if (m && m.index !== undefined) {
      return { prose: text.slice(0, m.index).trim(), dump: text.slice(m.index).trim() };
    }
    return null;
  }

  // The echoed dump is redundant (the real output is in the tool block),
  // so we drop it and leave a tiny dimmed note in its place.
  function appendHiddenEchoNote(container, dumpText) {
    var lineCount = dumpText.split('\n').length;
    var note = document.createElement('div');
    note.className = 'echo-hidden-note';
    note.textContent = '// tool output hidden (' + lineCount + ' lines) — see the tool block above';
    container.appendChild(note);
  }

  // Attach a [COPY] button to a completed assistant bubble. Stores the
  // raw message text on a data attribute so the delegated click handler
  // can copy the full message without re-deriving it from rendered HTML.
  function attachMessageCopyBtn(block, rawText) {
    if (!block || !rawText || !rawText.trim()) { return; }
    var btn = document.createElement('button');
    btn.className = 'msg-copy-btn';
    btn.type = 'button';
    btn.textContent = '[COPY]';
    btn.title = 'Copy full message';
    btn.dataset.copyText = rawText;
    block.appendChild(btn);
  }

  function finalizeAgentBlock(tab) {
    hideThinking(tab);
    if (!tab.currentAgentBlock) { return; }
    if (tab.currentAgentText && tab.currentAgentText.trim()) {
      var echo = splitToolEcho(tab.currentAgentText);
      if (echo) {
        tab.currentAgentBlock.innerHTML = '';
        if (echo.prose) {
          var proseDiv = document.createElement('div');
          proseDiv.innerHTML = renderMarkdown(stripEmojis(echo.prose));
          tab.currentAgentBlock.appendChild(proseDiv);
        }
        appendHiddenEchoNote(tab.currentAgentBlock, echo.dump);
        highlightLastStatement(tab.currentAgentBlock);
      } else {
        tab.currentAgentBlock.innerHTML = renderMarkdown(stripEmojis(tab.currentAgentText));
        highlightLastStatement(tab.currentAgentBlock);
      }
      attachMessageCopyBtn(tab.currentAgentBlock, tab.currentAgentText);
    } else {
      tab.currentAgentBlock.remove();
    }
    tab.currentAgentBlock = null;
    tab.currentAgentText = '';
    tab._streamingSpan = null;
    tab._echoSplitIdx = -1;
    tab.lastRenderedLength = 0;
  }

  function highlightLastStatement(block) {
    if (!block) { return; }
    if (_lastHighlightedEl) { _lastHighlightedEl.classList.remove('agent-last-statement'); _lastHighlightedEl = null; }
    var kids = block.children;
    var summaryIdx = -1;
    for (var i = kids.length - 1; i >= 0; i--) {
      var el = kids[i];
      if (!el || el.nodeType !== 1) { continue; }
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'h1' && tag !== 'h2' && tag !== 'h3') { continue; }
      var headText = (el.textContent || '').trim().toLowerCase();
      headText = headText.replace(/^[#\s]+/, '');
      if (headText === 'summary' || headText.indexOf('summary') === 0) { summaryIdx = i; break; }
    }
    if (summaryIdx >= 0) {
      var toWrap = [];
      for (var j = summaryIdx; j < kids.length; j++) { toWrap.push(kids[j]); }
      var wrapper = document.createElement('div');
      wrapper.className = 'agent-last-statement';
      _lastHighlightedEl = wrapper;
      block.appendChild(wrapper);
      for (var k = 0; k < toWrap.length; k++) { wrapper.appendChild(toWrap[k]); }
      return;
    }
    for (var ii = kids.length - 1; ii >= 0; ii--) {
      var elFb = kids[ii];
      if (!elFb || elFb.nodeType !== 1) { continue; }
      var tagFb = elFb.tagName ? elFb.tagName.toLowerCase() : '';
      if (tagFb === 'hr' || tagFb === 'br') { continue; }
      var txt = (elFb.textContent || '').trim();
      if (!txt) { continue; }
      elFb.classList.add('agent-last-statement');
      _lastHighlightedEl = elFb;
      return;
    }
  }

  var _emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}]/gu;
  function stripEmojis(text) {
    if (!stripEmojisEnabled) { return text; }
    return text.replace(_emojiRe, '');
  }

  var TOOL_LABELS = {
    read_file: '[SCAN]   ', write_file: '[COMPILE]', execute_command: '[EXEC]   ',
    list_files: '[LIST]   ', search_files: '[SCAN]   ', get_workspace_info: '[INFO]   ',
    read_active_editor: '[EDITOR] ', get_file_info: '[STAT]   ', replace_in_file: '[PATCH]  ',
  };

  /** Build a short one-line preview of a tool result for the collapsed header. */
  function summarizeToolResult(toolResult, isError) {
    if (!toolResult) { return ''; }
    var text = String(toolResult);
    var lineCount = text.split('\n').length;
    var firstLine = '';
    var parts = text.split('\n');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t) { firstLine = t; break; }
    }
    if (firstLine.length > 48) { firstLine = firstLine.substring(0, 47) + '…'; }
    var meta = lineCount > 1 ? (lineCount + ' lines') : (text.length + ' chars');
    return (isError ? firstLine : firstLine + ' · ' + meta);
  }

  function appendToolBlock(tab, toolName, toolInput, toolResult, isError, diffData) {
    tab._removeEmptyState();
    var label = TOOL_LABELS[toolName] || '[TOOL]   ';
    tab.messageCount++;
    // Use a native <details>/<summary> so the tool output is ALWAYS
    // collapsible even if a click handler ever fails to bind. It starts
    // collapsed; the user clicks the summary row to reveal the output.
    var block = document.createElement('details');
    block.className = 'tool-block' + (isError ? ' tool-block-error' : '');
    block.id = 'tool-' + tab.id + '-' + tab.messageCount;
    var summary = document.createElement('summary');
    summary.className = 'tool-summary';
    var left = document.createElement('span');
    left.className = 'tool-label';
    left.textContent = label + toolName;
    var preview = document.createElement('span');
    preview.className = 'tool-preview';
    if (!diffData) {
      var previewText = summarizeToolResult(toolResult, isError);
      if (previewText) { preview.textContent = previewText; }
    }
    var right = document.createElement('div');
    right.className = 'tool-right';
    var status = document.createElement('span');
    status.className = 'tool-status ' + (isError ? 'status-err' : 'status-ok');
    status.textContent = isError ? '[ERR]' : '[OK] ';
    right.appendChild(status);
    if (diffData) {
      var viewBtn = document.createElement('button');
      viewBtn.className = 'tool-view-btn';
      viewBtn.textContent = diffData.isNewFile ? '[OPEN]' : '[DIFF]';
      viewBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        vscode.postMessage({
          type: 'openDiff', filePath: diffData.filePath,
          oldContent: diffData.oldContent, newContent: diffData.newContent,
          isNewFile: diffData.isNewFile, sessionId: tab.id,
        });
      });
      right.appendChild(viewBtn);
    }
    var chevron = document.createElement('span');
    chevron.className = 'tool-chevron';
    chevron.textContent = '[+]';
    right.appendChild(chevron);
    summary.appendChild(left);
    if (preview.textContent) { summary.appendChild(preview); }
    summary.appendChild(right);
    var detail = document.createElement('div');
    detail.className = 'tool-detail';
    if (toolInput) {
      var inputDiv = document.createElement('div');
      inputDiv.className = 'tool-detail-section';
      inputDiv.innerHTML = '<div class="tool-detail-label">-- INPUT --</div>' +
        '<pre class="tool-pre">' + escHtml(typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2)) + '</pre>';
      detail.appendChild(inputDiv);
    }
    if (diffData) {
      var diffDiv = document.createElement('div');
      diffDiv.className = 'tool-detail-section';
      var fname = diffData.filePath.split('/').pop();
      diffDiv.innerHTML = '<div class="tool-detail-label">-- ' + (diffData.isNewFile ? 'NEW FILE' : 'DIFF') + ': ' + escHtml(fname) + ' --</div>';
      diffDiv.appendChild(buildInlineDiff(diffData.oldContent, diffData.newContent, diffData.isNewFile));
      detail.appendChild(diffDiv);
    } else if (toolResult) {
      var outputDiv = document.createElement('div');
      outputDiv.className = 'tool-detail-section';
      var truncated = toolResult.length > 4000 ? toolResult.substring(0, 4000) + '\n... [TRUNCATED]' : toolResult;
      outputDiv.innerHTML = '<div class="tool-detail-label">-- OUTPUT --</div>' +
        '<pre class="tool-pre' + (isError ? ' tool-pre-error' : '') + '">' + escHtml(truncated) + '</pre>';
      detail.appendChild(outputDiv);
    }
    summary.title = 'Click to expand/collapse output';
    // Keep the chevron in sync with the native <details> open state.
    block.addEventListener('toggle', function () {
      chevron.textContent = block.open ? '[-]' : '[+]';
    });
    // Prevent the default <summary> behavior from being swallowed by any
    // ancestor handlers; <details> handles the open/close natively.
    // All tool blocks start COLLAPSED (block.open is false by default).
    block.appendChild(summary); block.appendChild(detail);
    tab.threadContainer().appendChild(block);
    tab.scrollToBottom();
  }

  function buildInlineDiff(oldText, newText, isNewFile) {
    var container = document.createElement('div');
    container.className = 'diff-view';
    if (isNewFile) {
      var lines = (newText || '').split('\n');
      lines.slice(0, 120).forEach(function (line, i) {
        var row = document.createElement('div');
        row.className = 'diff-row diff-add';
        row.innerHTML = '<span class="diff-ln">' + pad(i + 1, 4) + '</span><span class="diff-ch">+</span><span class="diff-code">' + escHtml(line) + '</span>';
        container.appendChild(row);
      });
      if (lines.length > 120) { appendDiffMore(container, lines.length - 120); }
    } else {
      var diff = lineDiff(oldText, newText);
      var shown = diff.slice(0, 200);
      var ln = 0;
      shown.forEach(function (e) {
        var row = document.createElement('div');
        if (e.t === '+') { ln++; row.className = 'diff-row diff-add'; row.innerHTML = '<span class="diff-ln">' + pad(ln, 4) + '</span><span class="diff-ch">+</span><span class="diff-code">' + escHtml(e.l) + '</span>'; }
        else if (e.t === '-') { row.className = 'diff-row diff-del'; row.innerHTML = '<span class="diff-ln">    </span><span class="diff-ch">-</span><span class="diff-code">' + escHtml(e.l) + '</span>'; }
        else { ln++; row.className = 'diff-row diff-ctx'; row.innerHTML = '<span class="diff-ln">' + pad(ln, 4) + '</span><span class="diff-ch"> </span><span class="diff-code">' + escHtml(e.l) + '</span>'; }
        container.appendChild(row);
      });
      if (diff.length > 200) { appendDiffMore(container, diff.length - 200); }
    }
    return container;
  }
  function pad(n, w) { var s = String(n); while (s.length < w) { s = ' ' + s; } return s; }
  function appendDiffMore(container, count) {
    var row = document.createElement('div');
    row.className = 'diff-more';
    row.textContent = '... ' + count + ' more lines ...';
    container.appendChild(row);
  }
  function lineDiff(oldText, newText) {
    var a = (oldText || '').split('\n'), b = (newText || '').split('\n');
    var res = [], i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i >= a.length) { res.push({ t: '+', l: b[j++] }); }
      else if (j >= b.length) { res.push({ t: '-', l: a[i++] }); }
      else if (a[i] === b[j]) { res.push({ t: ' ', l: b[j] }); i++; j++; }
      else {
        var found = false;
        for (var k = 1; k <= 5 && !found; k++) {
          if (j + k < b.length && a[i] === b[j + k]) { for (var l = 0; l < k; l++) { res.push({ t: '+', l: b[j + l] }); } j += k; found = true; }
          else if (i + k < a.length && a[i + k] === b[j]) { for (var l2 = 0; l2 < k; l2++) { res.push({ t: '-', l: a[i + l2] }); } i += k; found = true; }
        }
        if (!found) { res.push({ t: '-', l: a[i++] }); res.push({ t: '+', l: b[j++] }); }
      }
    }
    return res;
  }

  // ─── Orchestration rendering ───────────────────────────────────────────

  function startOrchestrateBlock(tab, agents) {
    tab._removeEmptyState();
    tab.subAgents = {};
    var block = document.createElement('div');
    block.className = 'orchestrate-block';

    // NOTE: no ASCII banner here. The ORCHESTRATE art animation lives only on
    // the orchestrate tab's empty-state splash (see _appendEmptyState); we do
    // NOT show it while a delegate_task is actually in progress.
    var head = document.createElement('div');
    head.className = 'orchestrate-head';
    var title = document.createElement('span');
    title.textContent = '▣ DEPLOYING AGENTS';
    var count = document.createElement('span');
    count.className = 'orch-count';
    count.textContent = (agents ? agents.length : 0) + ' node' + ((agents && agents.length === 1) ? '' : 's') + ' in parallel';
    head.appendChild(title); head.appendChild(count);
    block.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'orchestrate-grid';
    block.appendChild(grid);
    tab.threadContainer().appendChild(block);
    tab.currentOrchestrateBlock = block;
    (agents || []).forEach(function (a) { createSubAgentCard(tab, grid, a.id, a.title, a.task); });
    tab.scrollToBottom();
  }

  function createSubAgentCard(tab, grid, agentId, title, task) {
    if (tab.subAgents[agentId]) { return tab.subAgents[agentId]; }
    var card = document.createElement('div');
    card.className = 'subagent-card';
    var headEl = document.createElement('div');
    headEl.className = 'subagent-card-head';
    var spinner = document.createElement('span');
    spinner.className = 'subagent-spinner';
    spinner.textContent = '|';
    var titleEl = document.createElement('span');
    titleEl.className = 'subagent-title';
    titleEl.textContent = title || 'agent';
    var statusEl = document.createElement('span');
    statusEl.className = 'subagent-status';
    statusEl.textContent = 'queued…';
    var toolCountEl = document.createElement('span');
    toolCountEl.className = 'subagent-toolcount';
    toolCountEl.textContent = '';
    var chevron = document.createElement('span');
    chevron.className = 'subagent-chevron';
    chevron.textContent = '[+]';
    headEl.appendChild(spinner); headEl.appendChild(titleEl); headEl.appendChild(statusEl);
    headEl.appendChild(toolCountEl); headEl.appendChild(chevron);
    var body = document.createElement('div');
    body.className = 'subagent-body';
    var taskEl = document.createElement('div');
    taskEl.className = 'subagent-task';
    taskEl.textContent = task || '';
    var streamEl = document.createElement('div');
    streamEl.className = 'subagent-stream';
    body.appendChild(taskEl); body.appendChild(streamEl);
    card.appendChild(headEl); card.appendChild(body);
    headEl.addEventListener('click', function () {
      var open = card.classList.toggle('sa-open');
      chevron.textContent = open ? '[-]' : '[+]';
    });
    grid.appendChild(card);

    var spinIdx = 0;
    spinner.classList.add('sa-spinning');
    var interval = setInterval(function () {
      if (tab !== getActiveTab()) { return; } // skip DOM work when tab hidden
      spinIdx = (spinIdx + 1) % SPIN_CHARS.length;
      spinner.textContent = SPIN_CHARS[spinIdx];
    }, 120);

    var ref = {
      card: card, spinnerEl: spinner, statusEl: statusEl, streamEl: streamEl,
      toolCountEl: toolCountEl, chevron: chevron, interval: interval,
      toolCount: 0, streamText: '', reportEl: null,
    };
    tab.subAgents[agentId] = ref;
    return ref;
  }

  function subAgentEnsure(tab, agentId, title, task) {
    var ref = tab.subAgents[agentId];
    if (ref) { return ref; }
    // Late-arriving agent (e.g. replay) — attach to current block grid.
    var grid = tab.currentOrchestrateBlock
      ? tab.currentOrchestrateBlock.querySelector('.orchestrate-grid')
      : null;
    if (!grid) { startOrchestrateBlock(tab, [{ id: agentId, title: title, task: task }]); return tab.subAgents[agentId]; }
    return createSubAgentCard(tab, grid, agentId, title, task);
  }

  function subAgentDelta(tab, agentId, delta) {
    var ref = tab.subAgents[agentId];
    if (!ref) { return; }
    ref.streamText += delta || '';
    ref.streamEl.textContent = ref.streamText;
    ref.statusEl.textContent = summarizeForStatus(ref.streamText) || 'working…';
    if (tab === getActiveTab()) { tab.scrollToBottom(); }
  }

  function subAgentTool(tab, agentId, toolName, toolInput, toolResult, isError) {
    var ref = tab.subAgents[agentId];
    if (!ref) { return; }
    ref.toolCount++;
    ref.toolCountEl.textContent = ref.toolCount + '⚙';
    var tag = document.createElement('span');
    tag.className = 'subagent-tooltag' + (isError ? ' sa-tool-err' : '');
    tag.textContent = (TOOL_LABELS[toolName] || '[TOOL]').trim() + (isError ? ' ✗' : '');
    tag.title = (toolInput || '') + '\n\n' + (toolResult || '');
    ref.streamEl.appendChild(tag);
    ref.statusEl.textContent = 'ran ' + toolName + '…';
  }

  function subAgentDone(tab, agentId, finalText, ok) {
    var ref = tab.subAgents[agentId];
    if (!ref) { return; }
    if (ref.interval) { clearInterval(ref.interval); ref.interval = null; }
    ref.card.classList.add(ok ? 'sa-done' : 'sa-failed');
    ref.spinnerEl.textContent = ok ? '✓' : '✗';
    ref.statusEl.textContent = ok ? 'done · ' + ref.toolCount + ' tool calls' : 'failed';
    if (finalText) {
      var report = document.createElement('div');
      report.className = 'subagent-report';
      report.innerHTML = renderMarkdown(stripEmojis(finalText));
      ref.streamEl.appendChild(report);
      ref.reportEl = report;
    }
    if (tab === getActiveTab()) { tab.scrollToBottom(); }
  }

  function orchestrateDone(tab) {
    tab.currentOrchestrateBlock = null;
  }

  function appendSysNote(tab, text, isError) {
    tab._removeEmptyState();
    var div = document.createElement('div');
    div.className = 'sys-note' + (isError ? ' sys-note-error' : '');
    div.textContent = (isError ? '[ERR] ' : '[SYS] ') + text;
    tab.threadContainer().appendChild(div);
    tab.scrollToBottom();
  }
  function appendContextNote(tab, label, preview) {
    tab._removeEmptyState();
    var div = document.createElement('div');
    div.className = 'ctx-note';
    div.textContent = '[ATTACH] ' + (label || '').split('/').pop();
    if (preview) {
      var pre = document.createElement('pre');
      pre.className = 'ctx-preview';
      pre.textContent = preview.length > 200 ? preview.substring(0, 200) + '...' : preview;
      div.appendChild(pre);
    }
    tab.threadContainer().appendChild(div);
    tab.scrollToBottom();
  }

  function renderMarkdown(text) {
    var codeBlocks = [];
    var html = text.replace(/\x60\x60\x60([\w]*)\n([\s\S]*?)\x60\x60\x60/g, function (_, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push('<div class="code-block">' + (lang ? '<div class="code-lang">' + escHtml(lang.toUpperCase()) + '</div>' : '') + '<pre><code>' + escHtml(code.trimEnd()) + '</code></pre><button class="copy-btn">[COPY]</button></div>');
      return '\x00CB' + idx + '\x00';
    });
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/\x60([^\x60\n]+)\x60/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^[ \t]*[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, function (m) { return '<ul>' + m + '</ul>'; });
    html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
    html = html.replace(/(<oli>[\s\S]*?<\/oli>\n?)+/g, function (m) { return '<ol>' + m.replace(/<\/?oli>/g, function (t) { return t === '<oli>' ? '<li>' : '</li>'; }) + '</ol>'; });
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/\x00CB(\d+)\x00/g, function (_, i) { return codeBlocks[parseInt(i, 10)]; });
    return '<p>' + html + '</p>';
  }
  // Delegated click handler for copy buttons: code-block [COPY]
  // (.copy-btn) AND whole-message [COPY] (.msg-copy-btn). stopPropagation
  // so the click never bubbles to a parent bubble/summary handler.
  // Uses navigator.clipboard with an execCommand fallback (clipboard may
  // be unavailable in some VS Code webview contexts).
  document.addEventListener('click', function (e) {
    var btn = e.target;
    if (!btn || !btn.classList) { return; }
    var text = null;
    if (btn.classList.contains('copy-btn')) {
      var pre = btn.parentElement && btn.parentElement.querySelector('pre');
      if (!pre) { return; }
      text = pre.textContent || '';
    } else if (btn.classList.contains('msg-copy-btn')) {
      text = btn.dataset.copyText || '';
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Try navigator.clipboard first, fall back to execCommand. Label
    // flips to [COPIED] for ~1.2s then reverts.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = '[COPIED]';
        setTimeout(function () { btn.textContent = '[COPY]'; }, 1200);
      }, function () {
        fallbackCopy(text, btn);
      });
    } else {
      fallbackCopy(text, btn);
    }
  });
  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      btn.textContent = '[COPIED]';
      setTimeout(function () { btn.textContent = '[COPY]'; }, 1200);
    } catch (err) {
      btn.textContent = '[FAILED]';
      setTimeout(function () { btn.textContent = '[COPY]'; }, 1200);
    }
    document.body.removeChild(ta);
  }

  // ─── Files-changed-this-turn summary card ──────────────────────────────
  // Host posts { type: 'filesChanged', files: [{ path, baseName, action }],
  // sessionId }. We render a compact card at the END of the relevant
  // session's transcript. Gated by session via the `tab` lookup in the
  // message dispatcher (only the matching TabState's thread receives it).
  var FILE_ACTION_GLYPH = {
    created: '+', modified: '~', deleted: '-', renamed: '»',
  };
  function renderFilesChanged(tab, files) {
    if (!tab || !Array.isArray(files) || files.length === 0) { return; }
    tab._removeEmptyState();
    var card = document.createElement('div');
    card.className = 'files-changed-card';
    var head = document.createElement('div');
    head.className = 'fc-head';
    head.textContent = '[~] CHANGED ' + files.length + ' FILE' + (files.length === 1 ? '' : 'S');
    card.appendChild(head);
    var list = document.createElement('div');
    list.className = 'fc-list';
    files.forEach(function (f) {
      if (!f) { return; }
      var action = (f.action || 'modified').toLowerCase();
      var glyph = FILE_ACTION_GLYPH[action] || '~';
      var row = document.createElement('div');
      row.className = 'fc-row fc-' + action;
      row.title = f.path || f.baseName || '';
      var g = document.createElement('span');
      g.className = 'fc-glyph';
      g.textContent = glyph;
      var a = document.createElement('span');
      a.className = 'fc-action';
      a.textContent = action;
      var nm = document.createElement('span');
      nm.className = 'fc-name';
      nm.textContent = f.baseName || (f.path ? f.path.split('/').pop() : '');
      row.appendChild(g); row.appendChild(a); row.appendChild(nm);
      // Clicking a row reuses the existing openDiff host handler to open
      // the file (as a new-file diff against empty so it just opens).
      (function (filePath) {
        row.addEventListener('click', function (e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'openDiff', filePath: filePath, isNewFile: true, oldContent: '' });
        });
      })(f.path || '');
      list.appendChild(row);
    });
    card.appendChild(list);
    tab.threadContainer().appendChild(card);
    tab.scrollToBottom();
  }
  function setStreaming(streaming) {
    sendBtn.style.display = streaming ? 'none' : 'flex';
    stopBtn.style.display = streaming ? 'flex' : 'none';
    inputEl.disabled = streaming;
    // Only re-focus the input when streaming ENDS and the user isn't
    // currently interacting with the thread / a button. Stealing focus
    // (and thus scroll position) while they're reading earlier output
    // is exactly what made the execute_command scroll feel "trapped".
    if (!streaming) {
      var ae = document.activeElement;
      var inThread = ae && threadEl && threadEl.contains(ae);
      var isButton = ae && ae.tagName === 'BUTTON';
      if (!inThread && !isButton) { inputEl.focus(); }
    }
  }
  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function updateTokenBarFromTab(tab) {
    if (!tab) { return; }
    var total = (tab.promptTokens || 0) + (tab.completionTokens || 0);
    var tokenCountEl = document.getElementById('token-count');
    var tokenFillEl = document.getElementById('token-fill');
    var CONTEXT_CAP = 200000;
    var used = total > 999 ? (total / 1000).toFixed(1) + 'k' : String(total);
    if (tokenCountEl) {
      tokenCountEl.textContent = '';
      var usedSpan = document.createElement('span');
      usedSpan.textContent = used;
      var capSpan = document.createElement('span');
      capSpan.className = 'tok-cap';
      capSpan.textContent = ' / ' + (CONTEXT_CAP / 1000) + 'k';
      tokenCountEl.appendChild(usedSpan);
      tokenCountEl.appendChild(capSpan);
    }
    if (tokenFillEl) {
      var pct = Math.min(100, (total / CONTEXT_CAP) * 100);
      tokenFillEl.style.width = pct + '%';
      var level = pct > 80 ? 'tok-high' : pct > 50 ? 'tok-mid' : 'tok-low';
      tokenFillEl.classList.remove('tok-low', 'tok-mid', 'tok-high');
      tokenFillEl.classList.add(level);
    }
  }

  function showHistoryOverlay() {
    if (historyOverlay) { historyOverlay.classList.add('active'); }
    renderHistoryOverlay();
  }
  function hideHistoryOverlay() {
    if (historyOverlay) { historyOverlay.classList.remove('active'); }
  }
  function formatHistoryTime(ms) {
    if (!ms) { return ''; }
    var d = new Date(ms);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) { return hh + ':' + mm; }
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var dy = String(d.getDate()).padStart(2, '0');
    return mo + '-' + dy + ' ' + hh + ':' + mm;
  }
  function renderHistoryOverlay() {
    if (!historyPanelBody) { return; }
    historyPanelBody.innerHTML = '';
    if (!lastHistorySessions || lastHistorySessions.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '// no saved chats yet';
      historyPanelBody.appendChild(empty);
      return;
    }
    lastHistorySessions.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'history-row';
      if (s.id === lastCurrentSessionId) { row.classList.add('history-row-current'); }
      var main = document.createElement('div');
      main.className = 'history-row-main';
      var title = document.createElement('div');
      title.className = 'history-row-title';
      title.textContent = s.title || 'Untitled chat';
      title.title = s.title || '';
      main.appendChild(title);
      var meta = document.createElement('div');
      meta.className = 'history-row-meta';
      var t = document.createElement('span');
      t.className = 'h-meta-tag';
      t.textContent = formatHistoryTime(s.updatedAt || s.createdAt);
      meta.appendChild(t);
      var n = document.createElement('span');
      n.className = 'h-meta-tag';
      n.textContent = (s.messageCount || 0) + ' msg';
      meta.appendChild(n);
      if (s.model) {
        var mTag = document.createElement('span');
        mTag.className = 'h-meta-tag';
        var modelShort = String(s.model);
        var pp = modelShort.split('::');
        if (pp.length > 1) { modelShort = pp[1]; }
        mTag.textContent = modelShort;
        mTag.title = s.model;
        meta.appendChild(mTag);
      }
      if (s.skillName) {
        var sk = document.createElement('span');
        sk.className = 'h-meta-tag h-meta-skill';
        sk.textContent = s.skillName;
        meta.appendChild(sk);
      }
      var tok = (s.promptTokens || 0) + (s.completionTokens || 0);
      if (tok > 0) {
        var tk = document.createElement('span');
        tk.className = 'h-meta-tag';
        tk.textContent = (tok > 999 ? (tok / 1000).toFixed(1) + 'k' : String(tok)) + ' tok';
        meta.appendChild(tk);
      }
      main.appendChild(meta);
      main.addEventListener('click', function () {
        vscode.postMessage({ type: 'loadHistorySession', id: s.id });
        hideHistoryOverlay();
      });
      var actions = document.createElement('div');
      actions.className = 'history-row-actions';
      var del = document.createElement('button');
      del.className = 'history-del-btn';
      del.textContent = '[DEL]';
      del.title = 'Click once to arm, click again to confirm delete';
      (function (delBtn, sessId) {
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          armTwoClickConfirm(delBtn, '[DEL]', function () {
            vscode.postMessage({ type: 'deleteHistorySession', id: sessId });
          });
        });
      })(del, s.id);
      actions.appendChild(del);
      row.appendChild(main); row.appendChild(actions);
      historyPanelBody.appendChild(row);
    });
  }

  function replayHistorySession(payload) {
    var tab = getActiveTab();
    if (!tab) { return; }
    clearHostDOM();
    resetTabRenderState(tab);
    tab.hasMessages = true;
    inputEl.value = '';
    thoughtsPanelEl.classList.remove('thoughts-streaming');
    updateThoughtsStatus(tab.thoughtsStatus);
    setStreaming(false);

    if (payload.model && modelSelect) {
      var hasModel = Array.prototype.some.call(modelSelect.options, function (o) { return o.value === payload.model; });
      if (hasModel) { modelSelect.value = payload.model; tab.model = payload.model; }
    }
    if (skillSelect) { skillSelect.value = payload.skillName || ''; tab.skillName = payload.skillName || ''; }
    tab.promptTokens = payload.promptTokens || 0;
    tab.completionTokens = payload.completionTokens || 0;
    updateTokenBarFromTab(tab);
    lastCurrentSessionId = payload.sessionId || null;

    var banner = document.createElement('div');
    banner.className = 'sys-note';
    banner.textContent = '[HISTORY] Loaded: ' + (payload.title || payload.sessionId || 'session');
    tab.threadContainer().appendChild(banner);

    var events = Array.isArray(payload.events) ? payload.events : [];
    if (events.length === 0) {
      var empty2 = document.createElement('div');
      empty2.className = 'sys-note';
      empty2.textContent = '[HISTORY] (no recorded events — continue chatting to add to this session)';
      tab.threadContainer().appendChild(empty2);
    }
    for (var i2 = 0; i2 < events.length; i2++) {
      var ev = events[i2];
      switch (ev.kind) {
        case 'user': appendUserMessage(tab, ev.text || '', ev.images || []); break;
        case 'assistant': renderAgentText(tab, ev.text || ''); break;
        case 'thinking': showThoughtBubble(tab); appendThoughtChunk(tab, ev.text || ''); finalizeThoughtBubble(tab); break;
        case 'tool': appendToolBlock(tab, ev.toolName, ev.toolInput, ev.toolResult, ev.isError, null); break;
        case 'attach': appendContextNote(tab, ev.label || '', ev.preview || ''); break;
        case 'sys': appendSysNote(tab, ev.text || '', ev.isError); break;
        case 'orchestrate': {
          var ags = ev.agents || [];
          startOrchestrateBlock(tab, ags.map(function (a) { return { id: a.id, title: a.title, task: a.task }; }));
          for (var ai = 0; ai < ags.length; ai++) {
            var ag = ags[ai];
            var tls = ag.tools || [];
            for (var ti = 0; ti < tls.length; ti++) {
              var tl = tls[ti];
              subAgentTool(tab, ag.id, tl.toolName, tl.toolInput, tl.toolResult, tl.isError);
            }
            subAgentDone(tab, ag.id, ag.finalText || '', !!ag.ok);
          }
          orchestrateDone(tab);
          break;
        }
      }
    }
    tab.scrollToBottom();
  }

  function renderAgentText(tab, text) {
    if (!text || !text.trim()) { return; }
    tab.messageCount++;
    var block = document.createElement('div');
    block.className = 'agent-block';
    block.id = 'msg-' + tab.id + '-' + tab.messageCount;
    var echo = splitToolEcho(text);
    if (echo) {
      if (echo.prose) {
        var proseDiv = document.createElement('div');
        proseDiv.innerHTML = renderMarkdown(stripEmojis(echo.prose));
        block.appendChild(proseDiv);
      }
      appendHiddenEchoNote(block, echo.dump);
    } else {
      block.innerHTML = renderMarkdown(stripEmojis(text));
    }
    tab.threadContainer().appendChild(block);
    highlightLastStatement(block);
  }

  // ─── Incoming message dispatcher ───────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    var sid = msg && typeof msg.sessionId === 'string' ? msg.sessionId : null;
    var tab = sid ? tabs.get(sid) : (sid ? null : getActiveTab());

    switch (msg.type) {
      case 'init': {
        if (msg.models && modelSelect) {
          modelSelect.innerHTML = '';
          msg.models.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            var labelText = m.label || m.id;
            if (m.vision) { labelText = '[V] ' + labelText; }
            opt.textContent = labelText;
            opt.title = m.id + (m.vision ? ' (vision)' : '');
            if (m.id === msg.currentModel) { opt.selected = true; }
            modelSelect.appendChild(opt);
          });
        }
        if (msg.skills && skillSelect) {
          skillSelect.innerHTML = '<option value="">-- none --</option>';
          msg.skills.forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s.name; opt.textContent = s.name;
            skillSelect.appendChild(opt);
          });
        }
        // CRITICAL: clear the host elements BEFORE mounting the active
        // tab's content. The HTML template seeds #thread with a static
        // <div id="empty-state"> and #thoughts-panel-body with a
        // .thoughts-empty placeholder; we must remove those so they
        // don't double up with the tab's own empty-state splash.
        clearHostDOM();

        if (Array.isArray(msg.sessions) && msg.sessions.length > 0) {
          tabs.clear();
          msg.sessions.forEach(function (s) {
            var t = new TabState(s.id, s.title);
            t.running = s.running;
            t.orchestrator = !!s.orchestrator;
            t._refreshEmptyStateArt();
            t.model = s.model || msg.currentModel || '';
            t.skillName = s.skillName || '';
            tabs.set(s.id, t);
          });
          activeSessionId = msg.activeSessionId || msg.sessions[0].id;
          var act = getActiveTab();
          if (act) {
            act.promptTokens = msg.promptTokens || 0;
            act.completionTokens = msg.completionTokens || 0;
            while (act.threadFrag.firstChild) { threadEl.appendChild(act.threadFrag.firstChild); }
            while (act.thoughtsFrag.firstChild) { thoughtsPanelBodyEl.appendChild(act.thoughtsFrag.firstChild); }
            while (act.imagesFrag.firstChild) { pendingImagesEl.appendChild(act.imagesFrag.firstChild); }
          }
        } else {
          tabs.clear();
          var defaultTab = new TabState('default', 'New chat');
          tabs.set('default', defaultTab);
          activeSessionId = 'default';
          while (defaultTab.threadFrag.firstChild) { threadEl.appendChild(defaultTab.threadFrag.firstChild); }
          while (defaultTab.thoughtsFrag.firstChild) { thoughtsPanelBodyEl.appendChild(defaultTab.thoughtsFrag.firstChild); }
        }
        if (msg.history) {
          lastHistorySessions = msg.history;
          lastCurrentSessionId = msg.currentSessionId || null;
        }
        if (msg.autoApprove) {
          var aa = msg.autoApprove;
          // Auto-approve gates (default false).
          autoApprove.write_file = !!aa.write_file;
          autoApprove.execute_command = !!aa.execute_command;
          // UI/behavior settings (default true except compact_tool).
          autoApprove.auto_scroll = aa.auto_scroll !== false;
          autoApprove.show_thinking = aa.show_thinking !== false;
          autoApprove.strip_emojis = aa.strip_emojis !== false;
          autoApprove.compact_tool = !!aa.compact_tool;
          // Derived runtime flags.
          autoScrollEnabled = autoApprove.auto_scroll;
          stripEmojisEnabled = autoApprove.strip_emojis;
          // Reflect into the toggle checkboxes (guard each — the host
          // may render a subset of toggles).
          if (autoApproveWriteToggle) { autoApproveWriteToggle.checked = autoApprove.write_file; }
          if (autoApproveExecToggle) { autoApproveExecToggle.checked = autoApprove.execute_command; }
          if (autoScrollToggle) { autoScrollToggle.checked = autoApprove.auto_scroll; }
          if (showThinkingToggle) { showThinkingToggle.checked = autoApprove.show_thinking; }
          if (stripEmojisToggle) { stripEmojisToggle.checked = autoApprove.strip_emojis; }
          if (compactToolToggle) { compactToolToggle.checked = autoApprove.compact_tool; }
          // Apply body-class side-effects.
          document.body.classList.toggle('hide-thinking', !autoApprove.show_thinking);
          document.body.classList.toggle('compact-tool-output', autoApprove.compact_tool);
        }
        var initActive = getActiveTab();
        if (initActive) { updateTokenBarFromTab(initActive); }
        renderTabStrip();

        // If the provider sent events for the active session, replay them
        // so the conversation is restored (e.g. after switching to another
        // extension panel and coming back).
        var initEvents = Array.isArray(msg.activeSessionEvents) ? msg.activeSessionEvents : [];
        if (initEvents.length > 0 && initActive) {
          replayHistorySession({
            sessionId: initActive.id,
            title: msg.activeSessionTitle || initActive.title,
            model: msg.currentModel || initActive.model,
            skillName: msg.activeSessionSkillName || initActive.skillName,
            events: initEvents,
            promptTokens: msg.promptTokens || 0,
            completionTokens: msg.completionTokens || 0,
          });
        }
        break;
      }
      case 'indexStatus': {
        indexState = (typeof msg.state === 'string') ? msg.state : 'unknown';
        indexFileCount = (typeof msg.fileCount === 'number') ? msg.fileCount : 0;
        paintIndexBtn(indexState, indexFileCount, 0);
        break;
      }
      case 'indexProgress': {
        indexState = 'building';
        var pct = (typeof msg.percent === 'number') ? msg.percent : 0;
        paintIndexBtn('building', indexFileCount, pct);
        break;
      }
      case 'sessionsState': {
        if (Array.isArray(msg.sessions)) {
          var seen = new Set();
          msg.sessions.forEach(function (s) {
            seen.add(s.id);
            var t = getOrCreateTab(s.id, s.title);
            t.title = s.title || t.title;
            t.running = s.running;
            t.orchestrator = !!s.orchestrator;
            t._refreshEmptyStateArt();
            t.model = s.model || t.model;
            t.skillName = s.skillName || t.skillName;
          });
          var toDelete = [];
          tabs.forEach(function (_, k) { if (!seen.has(k)) { toDelete.push(k); } });
          toDelete.forEach(function (k) { tabs.delete(k); });
        }
        if (msg.activeSessionId && msg.activeSessionId !== activeSessionId) {
          switchTab(msg.activeSessionId);
        } else {
          renderTabStrip();
        }
        break;
      }
      case 'historyList':
        lastHistorySessions = msg.sessions || [];
        lastCurrentSessionId = msg.currentSessionId || null;
        if (historyOverlay && historyOverlay.classList.contains('active')) { renderHistoryOverlay(); }
        break;
      case 'historyRestore': {
        // The provider DELETES the old session and spawns a BRAND-NEW
        // session (with a new sessionId) when a history row is loaded.
        // The webview's active tab, however, still carries the OLD id.
        // If we don't re-key it, the tab map + activeSessionId stay
        // pinned to the dead id: outgoing 'sendMessage' carries the old
        // id (provider drops it -> "stops thinking"), and inbound events
        // for the new id fail the tabs.get(sid) lookup (-> no UI render).
        //
        // So: re-key the active tab to the new sessionId BEFORE replay.
        if (sid && sid !== activeSessionId) {
          if (tabs.has(sid)) {
            // A tab with this id already exists -- just switch to it.
            switchTab(sid);
          } else {
            rekeyActiveTab(sid, msg.title);
          }
        }
        replayHistorySession(msg);
        renderTabStrip();
        break;
      }
      case 'sessionRunning':
        if (tab) {
          tab.running = !!msg.running;
          renderTabStrip();
          // The Stop button must remain visible for the WHOLE turn, not
          // just while the model is mid-stream. Otherwise during a long-
          // running tool call (especially `delegate_task` fanning work
          // out to parallel sub-agents that may run for minutes), the
          // button hides — making the user unable to interrupt. Drive
          // visibility off `running` (master flag for "the agent loop
          // owns the turn") rather than only `isStreaming` (true only
          // while the LLM is actively producing tokens).
          if (tab === getActiveTab()) {
            if (tab.running) { setStreaming(true); }
            else { setStreaming(false); }
          }
        }
        break;
      case 'assistantStart':
        if (!tab) { break; }
        tab.hasMessages = true; tab._removeEmptyState();
        tab.isStreaming = true;
        if (tab === getActiveTab()) { setStreaming(true); }
        finalizeThoughtBubble(tab);
        showThinking(tab);
        break;
      case 'assistantDelta':
        if (!tab) { break; }
        finalizeThoughtBubble(tab);
        if (!tab.currentAgentBlock) { hideThinking(tab); startAgentBlock(tab); }
        tab.currentAgentText += msg.delta || '';
        // Throttle expensive render + scroll to once per animation frame.
        // Text accumulation above is immediate; the DOM work below is
        // deferred so multiple deltas arriving within one frame batch
        // into a single render pass (eliminates O(n²) re-rendering).
        if (!tab._renderPending) {
          tab._renderPending = true;
          requestAnimationFrame(function () {
            tab._renderPending = false;
            if (!tab.currentAgentBlock) { return; } // block finalized while waiting
            // If the model is echoing a tool result inline, hide the dump
            // live so it doesn't flood the chat while streaming.
            // Cache splitToolEcho: once found, skip re-scanning on future frames.
            if (tab._echoSplitIdx === -1) {
              var liveEcho = splitToolEcho(tab.currentAgentText);
              if (liveEcho) {
                tab._echoSplitIdx = tab.currentAgentText.indexOf(liveEcho.dump);
              }
            }
            if (tab._echoSplitIdx >= 0) {
              var prose = tab.currentAgentText.slice(0, tab._echoSplitIdx).trim();
              var dump = tab.currentAgentText.slice(tab._echoSplitIdx).trim();
              tab.currentAgentBlock.innerHTML = '';
              if (prose) {
                var lp = document.createElement('div');
                lp.innerHTML = renderMarkdown(stripEmojis(prose));
                tab.currentAgentBlock.appendChild(lp);
              }
              appendHiddenEchoNote(tab.currentAgentBlock, dump);
              var lc = document.createElement('span');
              lc.className = 'blinking-cursor';
              lc.textContent = '_';
              tab.currentAgentBlock.appendChild(lc);
            } else {
              // Incremental MARKDOWN render during streaming so the
              // message prettifies AS tokens arrive rather than
              // showing raw `**foo**` / `# bar` / ``` fences until
              // the turn ends. The outer requestAnimationFrame above
              // already coalesces bursts of deltas into one render
              // per frame (~60 Hz max), and renderMarkdown is a
              // pure-regex pass with no DOM diffing, so cost stays
              // bounded even on long messages. Partial markdown
              // (an unclosed fence, an unclosed **bold**) naturally
              // falls through as literal text until its closing
              // token arrives — that's the intended "chunk by
              // chunk" prettification effect.
              var liveHtml = renderMarkdown(stripEmojis(tab.currentAgentText));
              tab.currentAgentBlock.innerHTML = liveHtml;
              var lc2 = document.createElement('span');
              lc2.className = 'blinking-cursor';
              lc2.textContent = '_';
              tab.currentAgentBlock.appendChild(lc2);
              // The original <span class="streaming-text"> element
              // created by startAgentBlock has now been replaced;
              // drop the stale reference so any later code path
              // can't write to a detached node.
              tab._streamingSpan = null;
            }
            tab.scrollToBottom();
          });
        }
        break;
      case 'thinkingStart': if (tab) { showThoughtBubble(tab); } break;
      case 'thinkingDelta': if (tab) { appendThoughtChunk(tab, msg.delta || ''); } break;
      case 'thinkingEnd': if (tab) { finalizeThoughtBubble(tab); } break;
      case 'assistantDone':
        if (!tab) { break; }
        hideThinking(tab); hideWriting(tab); finalizeThoughtBubble(tab); finalizeAgentBlock(tab);
        tab.isStreaming = false;
        // NOTE: do NOT call setStreaming(false) here unconditionally —
        // `assistantDone` fires after every LLM round, but the agent
        // loop may immediately dispatch a tool (incl. `delegate_task`
        // which can run for minutes). Hiding the Stop button between
        // rounds left the user with no way to interrupt long tool
        // calls. Visibility is now driven by the `sessionRunning`
        // event which fires once per whole turn. We only hide here if
        // the session is NOT running (defensive — covers any path
        // where assistantDone arrives after sessionRunning:false).
        if (tab === getActiveTab() && !tab.running) { setStreaming(false); }
        break;
      case 'writingStart': if (tab) { showWriting(tab, msg.toolName); } break;
      case 'writingPath':
        if (tab) {
          if (msg.toolName) { updateWritingTool(tab, msg.toolName); }
          setWritingFile(tab, msg.baseName || '');
        }
        break;
      case 'writingEnd': if (tab) { hideWriting(tab); } break;
      case 'toolUse':
        if (tab) {
          hideWriting(tab);
          appendToolBlock(tab, msg.toolName, msg.toolInput, msg.toolResult, msg.isError, msg.diffData);
        }
        break;
      case 'orchestrateStart':
        if (tab) { hideThinking(tab); startOrchestrateBlock(tab, msg.agents || []); }
        break;
      case 'subAgentStart':
        if (tab) { subAgentEnsure(tab, msg.agentId, msg.title, msg.task); }
        break;
      case 'subAgentDelta':
        if (tab) { subAgentDelta(tab, msg.agentId, msg.delta || ''); }
        break;
      case 'subAgentTool':
        if (tab) { subAgentTool(tab, msg.agentId, msg.toolName, msg.toolInput, msg.toolResult, msg.isError); }
        break;
      case 'subAgentDone':
        if (tab) { subAgentDone(tab, msg.agentId, msg.finalText || '', !!msg.ok); }
        break;
      case 'orchestrateDone':
        if (tab) { orchestrateDone(tab); }
        break;
      case 'approvalRequired':
        showApprovalBar(msg.id, msg.toolName, msg.toolInput, msg.sessionTitle, msg.queueDepth);
        break;
      case 'filesChanged':
        if (tab) { renderFilesChanged(tab, msg.files); }
        break;
      case 'contextAttached':
        if (tab) { appendContextNote(tab, msg.label, msg.preview); }
        break;
      case 'systemMessage':
        if (tab) { appendSysNote(tab, msg.text, msg.isError); }
        else if (getActiveTab()) { appendSysNote(getActiveTab(), msg.text, msg.isError); }
        break;
      case 'chatCleared':
        if (sid && tabs.has(sid)) {
          var ct = tabs.get(sid);
          if (ct === getActiveTab()) {
            clearHostDOM();
          } else {
            clearChildren(ct.threadFrag);
            clearChildren(ct.thoughtsFrag);
            clearChildren(ct.imagesFrag);
          }
          resetTabRenderState(ct);
          ct.hasMessages = false;
          ct._appendEmptyState();
          if (ct === getActiveTab()) {
            updateThoughtsStatus(ct.thoughtsStatus);
            inputEl.value = '';
            setStreaming(false);
            while (ct.threadFrag.firstChild) { threadEl.appendChild(ct.threadFrag.firstChild); }
            while (ct.thoughtsFrag.firstChild) { thoughtsPanelBodyEl.appendChild(ct.thoughtsFrag.firstChild); }
          }
        }
        break;
      case 'skillChanged':
        if (tab) {
          tab.skillName = msg.skill || '';
          if (tab === getActiveTab() && skillSelect) { skillSelect.value = tab.skillName; }
        }
        break;
      case 'modelChanged':
        if (tab) {
          tab.model = msg.model;
          if (tab === getActiveTab() && modelSelect) { modelSelect.value = tab.model; }
        }
        break;
      case 'modelsRefreshed':
        if (msg.models && modelSelect) {
          var prev = modelSelect.value;
          modelSelect.innerHTML = '';
          msg.models.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label || m.id;
            opt.title = m.id + (m.vision ? ' (vision)' : '');
            modelSelect.appendChild(opt);
          });
          var want = msg.currentModel || prev;
          if (want) {
            var base = baseModelId(want);
            var exact = Array.prototype.some.call(modelSelect.options, function (o) { return o.value === want; });
            if (exact) {
              modelSelect.value = want;
            } else {
              // The wanted id (e.g. "...:1M") may be absent from the live list;
              // fall back to its base id so we don't silently jump to option 0.
              var match = Array.prototype.find.call(modelSelect.options, function (o) { return baseModelId(o.value) === base; });
              if (match) { modelSelect.value = match.value; }
            }
          }
        }
        break;
      case 'tokenUsage':
        if (tab) {
          tab.promptTokens = msg.promptTokens || 0;
          tab.completionTokens = msg.completionTokens || 0;
          if (tab === getActiveTab()) { updateTokenBarFromTab(tab); }
        }
        break;
      case 'error':
        if (tab) {
          finalizeAgentBlock(tab);
          tab.isStreaming = false;
          if (tab === getActiveTab()) { setStreaming(false); }
          appendSysNote(tab, msg.message || 'UNKNOWN ERROR', true);
        }
        break;
    }
  });

  window.quickSend = function (text) {
    var tab = getActiveTab();
    if (!tab || tab.isStreaming) { return; }
    inputEl.value = text;
    inputEl.dispatchEvent(new Event('input'));
    sendMessage();
  };

  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'requestIndexStatus' });
  inputEl.focus();
}());
