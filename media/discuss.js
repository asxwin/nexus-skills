
// File: media/discuss.js
// QGenie — "Discuss" tab front-end.
//
// Drives a multi-agent debate UI: several AI roles (Planner, Coder,
// Reviewer, Researcher, Synthesizer) argue a problem over a number of
// rounds and converge on a final solution. The HTML shell (built by the
// extension host) provides the element IDs this script reaches for; we
// only DRIVE them. All host<->webview messaging mirrors chat.js
// conventions: acquireVsCodeApi(), vscode.postMessage(...), and a single
// window 'message' listener that switches on msg.type.

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  // ─── Host DOM references ────────────────────────────────────────────────
  var taskEl = document.getElementById('discuss-task');
  var modelSelect = document.getElementById('discuss-model');
  var roundsEl = document.getElementById('discuss-rounds');
  var runBtn = document.getElementById('discuss-run-btn');
  var stopBtn = document.getElementById('discuss-stop-btn');
  var agentsEl = document.getElementById('discuss-agents');
  var lanesEl = document.getElementById('discuss-lanes');
  var directorLogEl = document.getElementById('discuss-director-log');
  var chatInputEl = document.getElementById('discuss-chat-input');
  var chatSendEl = document.getElementById('discuss-chat-send');
  var finalEl = document.getElementById('discuss-final');
  var statusEl = document.getElementById('discuss-status');

  // Tracks which turn ids we've already drawn a "— turn N —" divider for,
  // per agent, so multiple turns by the same agent in the concurrent
  // discussion are visually separated. Keyed by `${agent}:${round}`.
  var turnSeen = {};
  // Set once the host signals the final summary exists & is executable.
  var planReady = false;
  var planHandedOff = false;

  // Per-agent "thinking" placeholder bubbles, keyed by `${round}:${agent}`
  // so an 'agentMessage' can replace the matching 'agentStart' bubble.
  var thinkingBubbles = {};
  // Per-agent lane elements, keyed by agent name. Each value is the
  // scrollable body div for that agent's lane (where cards are appended).
  var lanes = {};
  var running = false;

  // ─── Helpers ─────────────────────────────────────────────────────────────
  // Escape user/agent text before it ever touches innerHTML.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Normalize a role string to one of the known accent classes. Falls back
  // to the agent name lowercased so unknown roles still get a stable class.
  var KNOWN_ROLES = ['planner', 'coder', 'reviewer', 'researcher', 'synthesizer'];
  function roleClass(role, agent) {
    var r = String(role || agent || '').toLowerCase().trim();
    return KNOWN_ROLES.indexOf(r) !== -1 ? ('role-' + r) : 'role-default';
  }

  // Auto-scroll a single lane body to its own bottom as new cards arrive.
  function scrollLaneToBottom(bodyEl) {
    if (bodyEl) { bodyEl.scrollTop = bodyEl.scrollHeight; }
  }

  // Auto-scroll the director log strip to its bottom.
  function scrollDirectorToBottom() {
    if (directorLogEl) { directorLogEl.scrollTop = directorLogEl.scrollHeight; }
  }

  // Lazily create (or fetch) the per-agent lane. Returns the lane's
  // scrollable BODY element; new cards/deltas for that agent go there.
  function getLane(agent, role) {
    var name = String(agent || role || 'AGENT');
    if (lanes[name]) { return lanes[name]; }
    var lane = document.createElement('div');
    lane.className = 'discuss-lane ' + roleClass(role, agent);
    var header = document.createElement('div');
    header.className = 'discuss-lane-header';
    header.textContent = name.toUpperCase();
    var body = document.createElement('div');
    body.className = 'discuss-lane-body';
    lane.appendChild(header);
    lane.appendChild(body);
    if (lanesEl) { lanesEl.appendChild(lane); }
    lanes[name] = body;
    return body;
  }

  function setStatus(text) {
    if (statusEl) { statusEl.textContent = text || ''; }
  }

  // Toggle RUN/STOP button visibility + input disabled state.
  function setRunning(isRunning) {
    running = isRunning;
    if (runBtn) {
      runBtn.style.display = isRunning ? 'none' : 'inline-flex';
      runBtn.disabled = isRunning;
    }
    if (stopBtn) { stopBtn.style.display = isRunning ? 'inline-flex' : 'none'; }
    if (taskEl) { taskEl.disabled = isRunning; }
    if (roundsEl) { roundsEl.disabled = isRunning; }
    if (modelSelect) { modelSelect.disabled = isRunning; }
    if (agentsEl) {
      agentsEl.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        cb.disabled = isRunning;
      });
    }
  }

  // Apply lightweight INLINE markdown to a RAW (unescaped) string. We escape
  // first, then layer formatting on the escaped text so it stays XSS-safe:
  //   `code`  **bold** / __bold__  *italic* / _italic_  [text](http…)
  function inlineMd(s) {
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, function (_m, c) {
      return '<code class="discuss-inline-code">' + c + '</code>';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
    return out;
  }

  // Render content with a small but real markdown subset so agent output and
  // the final summary are READABLE rather than a raw monospace dump. Handles:
  // fenced code blocks, headings (#…######), unordered & ordered lists,
  // blockquotes (>), horizontal rules (---), paragraphs, and inline marks.
  // Everything is escaped before it touches innerHTML.
  function renderContent(content) {
    var lines = String(content == null ? '' : content).split('\n');
    var html = '';
    var inCode = false;
    var codeBuf = [];
    var listType = null; // 'ul' | 'ol' | null
    var para = [];

    function flushPara() {
      if (!para.length) { return; }
      html += '<p class="discuss-p">' + para.map(inlineMd).join('<br>') + '</p>';
      para = [];
    }
    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }
    function flushBlock() { flushPara(); closeList(); }
    function flushCode() {
      html += '<pre class="discuss-code"><code>' + esc(codeBuf.join('\n')) + '</code></pre>';
      codeBuf = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Fenced code block toggle.
      if (/^\s*```/.test(line)) {
        if (inCode) { flushCode(); inCode = false; }
        else { flushBlock(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      // Blank line ends the current paragraph.
      if (/^\s*$/.test(line)) { flushPara(); continue; }

      // Heading.
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushBlock();
        var lvl = h[1].length;
        html += '<div class="discuss-h discuss-h' + lvl + '">' + inlineMd(h[2]) + '</div>';
        continue;
      }
      // Horizontal rule.
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushBlock();
        html += '<hr class="discuss-hr">';
        continue;
      }
      // Blockquote.
      var bq = line.match(/^\s*>\s?(.*)$/);
      if (bq) {
        flushPara(); closeList();
        html += '<blockquote class="discuss-bq">' + inlineMd(bq[1]) + '</blockquote>';
        continue;
      }
      // Unordered list item.
      var ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== 'ul') { closeList(); html += '<ul class="discuss-ul">'; listType = 'ul'; }
        html += '<li>' + inlineMd(ul[1]) + '</li>';
        continue;
      }
      // Ordered list item.
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== 'ol') { closeList(); html += '<ol class="discuss-ol">'; listType = 'ol'; }
        html += '<li>' + inlineMd(ol[1]) + '</li>';
        continue;
      }

      // Plain paragraph text (closes any open list first).
      if (listType) { closeList(); }
      para.push(line);
    }

    // Flush trailing buffers (an unterminated code fence still renders).
    if (inCode) { flushCode(); }
    flushBlock();
    return html;
  }

  // Collect the checked role values from the agents container.
  function collectAgents() {
    var out = [];
    if (!agentsEl) { return out; }
    agentsEl.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      if (cb.checked && cb.value) { out.push(cb.value); }
    });
    return out;
  }

  // ─── Lane rendering ───────────────────────────────────────────────────────
  function bubbleKey(round, agent) {
    return String(round) + ':' + String(agent);
  }

  // Draw a faint "— turn N —" divider inside an agent's lane body the first
  // time a given turn id (the `round` field) is seen for that agent, so
  // multiple turns by the same agent in the concurrent discussion are
  // visually separated and the back-and-forth is easy to follow.
  function ensureTurnDivider(laneBody, agent, round) {
    if (!laneBody || round == null) { return; }
    var seenKey = String(agent) + ':' + String(round);
    if (turnSeen[seenKey]) { return; }
    turnSeen[seenKey] = true;
    var sep = document.createElement('div');
    sep.className = 'discuss-turn-sep';
    sep.textContent = '\u2014 turn ' + round + ' \u2014';
    laneBody.appendChild(sep);
  }

  // A 'thinking' placeholder for an agent that has started but not yet
  // produced its message. Later replaced in-place by the real card.
  function appendThinking(round, agent, role) {
    var key = bubbleKey(round, agent);
    if (thinkingBubbles[key]) { return; }
    var laneBody = getLane(agent, role);
    ensureTurnDivider(laneBody, agent, round);
    var card = document.createElement('div');
    card.className = 'discuss-card discuss-thinking ' + roleClass(role, agent);
    var header = document.createElement('div');
    header.className = 'discuss-card-header';
    header.textContent = '┌─ ' + String(agent || role || 'AGENT').toUpperCase() +
      ' ─ r' + round;
    var body = document.createElement('div');
    body.className = 'discuss-card-body';
    body.innerHTML =
      '<div class="discuss-live-think" style="display:none">' +
      '<span class="discuss-thinking-label">THINKING (live)</span>' +
      '<pre class="discuss-text discuss-live-think-body"></pre></div>' +
      '<pre class="discuss-text discuss-live-answer"></pre>' +
      '<span class="discuss-spinner">…</span>';
    card.appendChild(header);
    card.appendChild(body);
    laneBody.appendChild(card);
    thinkingBubbles[key] = card;
    scrollLaneToBottom(laneBody);
  }
  // Append a live streaming delta (thinking or answer) into an agent's bubble,
  // creating the bubble first if 'agentStart' hasn't been seen yet.
  function appendAgentDelta(round, agent, role, channel, delta) {
    var key = bubbleKey(round, agent);
    if (!thinkingBubbles[key]) { appendThinking(round, agent, role); }
    var card = thinkingBubbles[key];
    if (!card) { return; }
    if (channel === 'thinking') {
      var box = card.querySelector('.discuss-live-think');
      var tb = card.querySelector('.discuss-live-think-body');
      if (box) { box.style.display = ''; }
      if (tb) { tb.textContent += String(delta == null ? '' : delta); }
    } else {
      var ab = card.querySelector('.discuss-live-answer');
      if (ab) { ab.textContent += String(delta == null ? '' : delta); }
    }
    scrollLaneToBottom(card.parentNode);
  }

  // A short live "interjection" from one agent reacting to another's thinking.
  // Route into the target agent's lane body if 'to' maps to an existing
  // lane; otherwise fall back to the full-width director log.
  function appendInterjection(round, from, to, content) {
    var div = document.createElement('div');
    div.className = 'discuss-interjection';
    div.innerHTML =
      '<span class="discuss-interject-from">\u00bb ' + esc(from) + '</span>' +
      '<span class="discuss-interject-arrow"> \u2192 ' + esc(to || 'team') + '</span> ' +
      '<span class="discuss-interject-body">' + esc(content) + '</span>';
    var target = to && lanes[String(to)] ? lanes[String(to)] : null;
    if (target) {
      target.appendChild(div);
      scrollLaneToBottom(target);
    } else if (directorLogEl) {
      directorLogEl.appendChild(div);
      scrollDirectorToBottom();
    }
  }



  // Render (or fill-in a thinking placeholder for) an agent's message card.
  function appendAgentMessage(round, agent, role, content) {
    var key = bubbleKey(round, agent);
    var card = thinkingBubbles[key];
    var laneBody;
    if (card) {
      // Reuse the placeholder element.
      laneBody = card.parentNode;
      card.classList.remove('discuss-thinking');
      delete thinkingBubbles[key];
    } else {
      laneBody = getLane(agent, role);
      ensureTurnDivider(laneBody, agent, round);
      card = document.createElement('div');
      laneBody.appendChild(card);
    }
    card.className = 'discuss-card ' + roleClass(role, agent);
    card.innerHTML =
      '<div class="discuss-card-header">┌─ ' +
      esc(String(agent || role || 'AGENT').toUpperCase()) + ' ─ r' + esc(round) +
      '</div>' +
      '<div class="discuss-card-body">' + renderContent(content) + '</div>';
    scrollLaneToBottom(laneBody);
  }

  // Converged + error banners are full-width — render them into the
  // director log so they don't distort the column layout.
  function appendConverged(round, reason) {
    var div = document.createElement('div');
    div.className = 'converged-banner';
    div.textContent = '✓ CONVERGED' + (reason ? ' (' + reason + ')' : '') +
      (round != null ? ' @ round ' + round : '');
    if (directorLogEl) {
      directorLogEl.appendChild(div);
      scrollDirectorToBottom();
    }
  }

  function appendError(message) {
    var div = document.createElement('div');
    div.className = 'discuss-error';
    div.textContent = '[ERR] ' + (message || 'UNKNOWN ERROR');
    if (directorLogEl) {
      directorLogEl.appendChild(div);
      scrollDirectorToBottom();
    }
  }

  // Render an echoed live user-direction message into the director log.
  function appendUserMessage(from, text) {
    if (!directorLogEl) { return; }
    var div = document.createElement('div');
    div.className = 'discuss-director-entry';
    div.innerHTML =
      '<span class="discuss-director-prefix">\u00bb ' + esc(from || 'You') +
      ' \u2192 all:</span> ' +
      '<span class="discuss-director-text">' + esc(text) + '</span>';
    directorLogEl.appendChild(div);
    scrollDirectorToBottom();
  }

  // Send the current chat-input value as a live direction to all agents.
  function sendUserMessage() {
    if (!chatInputEl) { return; }
    var text = chatInputEl.value.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'userMessage', text: text });
    chatInputEl.value = '';
  }

  function renderFinal(solution) {
    if (!finalEl) { return; }
    // FLAW FIX: the user reported the FINAL SUMMARY box covers the agent
    // lanes when the round finishes and they "can't see the discussion
    // tab as it doesn't have a click to minimise or a minimise arrow".
    // The header WAS clickable and there WAS a tiny caret, but neither
    // looked like a control.  Add an explicit, button-shaped minimise
    // toggle on the right side of the header (with title="Minimise"),
    // clearly visible against the panel background, that toggles the
    // same .final-collapsed class.  Stopping propagation on its click
    // keeps the whole-header click affordance working too, so users
    // can collapse either way.
    finalEl.innerHTML =
      '<div class="final-box">' +
      '<div class="final-header" title="Click to collapse / expand">' +
        '<span class="final-caret">\u25be</span>' +
        '<span class="final-title">FINAL SUMMARY</span>' +
        '<button type="button" class="final-min-btn" ' +
                'title="Minimise / restore the summary" ' +
                'aria-label="Minimise summary">' +
          '<span class="final-min-icon-expanded">\u2013</span>' +   // \u2013 = en-dash, used as a "minimise" glyph
          '<span class="final-min-icon-collapsed">+</span>' +
        '</button>' +
      '</div>' +
      '<div class="final-body">' + renderContent(solution) + '</div>' +
      '</div>';
    // Make the summary collapsible so it never hides the agent lanes.
    var box = finalEl.querySelector('.final-box');
    var hdr = finalEl.querySelector('.final-header');
    var minBtn = finalEl.querySelector('.final-min-btn');
    function toggle() { if (box) { box.classList.toggle('final-collapsed'); } }
    if (hdr) { hdr.addEventListener('click', toggle); }
    if (minBtn) {
      // Stop the bubbled click from re-toggling via the header handler.
      minBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggle();
      });
    }
    // Bring the freshly-rendered summary into view without stealing the lanes.
    finalEl.scrollTop = 0;
    // The summary now exists; allow the EXECUTE PLAN handoff button.
    showExecPlanButton();
  }

  // Create (once) the "EXECUTE PLAN →" handoff button inside #discuss-final,
  // as a dedicated bar at the top of the .final-box. Clicking it asks the
  // host to hand the agreed plan to the main chat agent.
  function showExecPlanButton() {
    if (!finalEl || planHandedOff) { return; }
    if (document.getElementById('discuss-exec-plan')) { return; }
    var box = finalEl.querySelector('.final-box');
    if (!box) { return; }
    var bar = document.createElement('div');
    bar.className = 'discuss-exec-bar';
    var btn = document.createElement('button');
    btn.id = 'discuss-exec-plan';
    btn.type = 'button';
    btn.className = 'discuss-exec-plan';
    btn.textContent = 'EXECUTE PLAN \u2192';
    btn.title = 'Hand the agreed plan to the main chat agent to do the work';
    btn.addEventListener('click', function () {
      if (planHandedOff) { return; }
      vscode.postMessage({ type: 'executePlan' });
    });
    bar.appendChild(btn);
    // Insert the bar as the first child of the box (above the header/body).
    box.insertBefore(bar, box.firstChild);
  }

  // Flip the exec button into its disabled "handed off" state and note that
  // the agent is now working in the Chat tab.
  function markPlanHandedOff() {
    planHandedOff = true;
    var btn = document.getElementById('discuss-exec-plan');
    if (btn) {
      btn.textContent = '\u2713 Handed to agent \u2014 see Chat tab';
      btn.classList.add('discuss-exec-done');
      btn.disabled = true;
    }
    if (directorLogEl) {
      var div = document.createElement('div');
      div.className = 'discuss-director-entry';
      div.innerHTML =
        '<span class="discuss-director-prefix">\u00bb plan \u2192 agent:</span> ' +
        '<span class="discuss-director-text">Now executing in the Chat tab.</span>';
      directorLogEl.appendChild(div);
      scrollDirectorToBottom();
    }
    setStatus('// plan handed to agent — see Chat tab');
  }

  function clearOutput() {
    if (lanesEl) { lanesEl.innerHTML = ''; }
    if (directorLogEl) { directorLogEl.innerHTML = ''; }
    if (finalEl) { finalEl.innerHTML = ''; }
    lanes = {};
    thinkingBubbles = {};
    turnSeen = {};
    planReady = false;
    planHandedOff = false;
    var oldBtn = document.getElementById('discuss-exec-plan');
    if (oldBtn && oldBtn.parentNode) { oldBtn.parentNode.remove(); }
  }

  // ─── Controls ──────────────────────────────────────────────────────────
  if (runBtn) {
    runBtn.addEventListener('click', function () {
      if (running) { return; }
      var task = taskEl ? taskEl.value.trim() : '';
      if (!task) {
        appendError('Enter a problem to discuss first.');
        return;
      }
      var model = modelSelect ? modelSelect.value : '';
      var rounds = parseInt(roundsEl ? roundsEl.value : '4', 10);
      if (!isFinite(rounds) || rounds < 1) { rounds = 4; }
      var agents = collectAgents();
      clearOutput();
      setRunning(true);
      setStatus('// starting…');
      vscode.postMessage({
        type: 'startDiscuss',
        task: task,
        model: model,
        rounds: rounds,
        agents: agents,
      });
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'stopDiscuss' });
      setStatus('// stopping…');
    });
  }

  // ─── Live chat bar (direct all agents while they work) ──────────────────
  if (chatSendEl) {
    chatSendEl.addEventListener('click', function () { sendUserMessage(); });
  }
  if (chatInputEl) {
    chatInputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendUserMessage();
      }
    });
  }

  // ─── Incoming message dispatcher (host -> webview) ──────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg.type !== 'string') { return; }

    switch (msg.type) {
      case 'init': {
        if (msg.models && modelSelect) {
          modelSelect.innerHTML = '';
          msg.models.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label || m.id;
            opt.title = m.id;
            if (m.id === msg.currentModel) { opt.selected = true; }
            modelSelect.appendChild(opt);
          });
        }
        break;
      }
      case 'roundStart':
        // Agents run concurrently — no full-width round divider (it would
        // break the column layout). Just update the status line.
        setStatus('// round ' + msg.round + ' of ' + msg.total);
        break;
      case 'userMessage':
        appendUserMessage(msg.from, msg.text);
        break;
      case 'agentStart':
        appendThinking(msg.round, msg.agent, msg.role);
        break;
      case 'agentDelta':
        appendAgentDelta(msg.round, msg.agent, msg.role, msg.channel, msg.delta);
        break;
      case 'interjection':
        appendInterjection(msg.round, msg.from, msg.to, msg.content);
        break;
      case 'agentMessage':
        appendAgentMessage(msg.round, msg.agent, msg.role, msg.content);
        break;
      case 'converged':
        appendConverged(msg.round, msg.reason);
        break;
      case 'final':
        renderFinal(msg.solution);
        break;
      case 'planReady':
        planReady = true;
        showExecPlanButton();
        break;
      case 'executingPlan':
        markPlanHandedOff();
        break;
      case 'usage': {
        var pt = msg.promptTokens || 0;
        var ct = msg.completionTokens || 0;
        var tot = pt + ct;
        if (tot > 0) {
          var used = tot > 999 ? (tot / 1000).toFixed(1) + 'k' : String(tot);
          setStatus((statusEl && statusEl.textContent ? statusEl.textContent : '// running') +
            '  ·  ' + used + ' tok');
        }
        break;
      }
      case 'error':
        appendError(msg.message);
        break;
      case 'done':
        setRunning(false);
        setStatus((statusEl && statusEl.textContent ? statusEl.textContent : '') + '  // done');
        break;
    }
  });

  // Announce readiness so the host can send the 'init' message.
  setRunning(false);
  setStatus('// idle');
  vscode.postMessage({ type: 'ready' });
}());
