// ChatViewProvider — webview host shell; per-session state lives in AgentSession.
// Owns the webview, history store, diff provider, and a Map<id, AgentSession>.

import * as vscode from 'vscode';
import * as path from 'path';
import {
  loadQGenieConfig,
  fetchAvailableModels,
  AvailableModel,
  AVAILABLE_MODELS,
  baseModelId,
} from './qgenieApi';
import { loadSkills, loadSystemSkills } from './skillManager';
import { approvalGateKey } from './agentTools';
import { QGenieDiffProvider } from './diffProvider';
import { ChatHistoryStore } from './chatHistory';
import { AgentSession, SessionHost } from './agentSession';
import { Skill } from './skillManager';
import { getNonce } from './webviewUtils';
import type { IndexController } from './codebaseIndexer/IndexController';

export class ChatViewProvider implements vscode.WebviewViewProvider, SessionHost {
  public static readonly viewType = 'nexusChatView';

  private _view?: vscode.WebviewView;

  private _sessions = new Map<string, AgentSession>();
  private _activeSessionId: string | null = null;
  private _sessionCounter = 0;

  public readonly diffProvider: QGenieDiffProvider;
  public readonly historyStore: ChatHistoryStore;

  private _approvalQueue: Array<{
    id: string;
    sessionId: string;
    sessionTitle: string;
    toolName: string;
    args: Record<string, unknown>;
    resolve: (approved: boolean) => void;
  }> = [];
  private _approvalShowing: { id: string } | null = null;
  private _approvalCounter = 0;

  private _liveModels: AvailableModel[] | null = null;
  private _liveModelsFetching = false;

  private _context: vscode.ExtensionContext;
  private _autoApprove: Record<string, boolean>;

  /** Local codebase indexer controller (set from extension.ts). Drives the
   *  in-chat Index button and its up-to-date / re-index state. */
  private _indexController?: IndexController;

  setIndexController(controller: IndexController): void {
    this._indexController = controller;
  }

  /** Push the current index status to the webview so the in-chat button can
   *  repaint (none → "Index", fresh → "Index up to date", stale → "Re-index",
   *  building → spinner). */
  refreshIndexStatus(): void {
    if (!this._view) { return; }
    const c = this._indexController;
    const status = c ? c.getStatus() : { state: 'none' as const, fileCount: 0, lastIndexed: 0 };
    this._view.webview.postMessage({
      type: 'indexStatus',
      state: c?.isBusy ? 'building' : status.state,
      fileCount: status.fileCount,
      lastIndexed: status.lastIndexed,
    });
  }

  /** Push the live indexing percentage (0–100) to the in-chat Index button. */
  reportIndexProgress(percent: number): void {
    this._view?.webview.postMessage({ type: 'indexProgress', percent });
  }

  private _configCache: { data: ReturnType<typeof loadQGenieConfig>; timestamp: number } | undefined;

  private _getCachedConfig(): ReturnType<typeof loadQGenieConfig> {
    const now = Date.now();
    if (this._configCache && (now - this._configCache.timestamp) < 5000) {
      return this._configCache.data;
    }
    const data = loadQGenieConfig();
    this._configCache = { data, timestamp: now };
    return data;
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    diffProvider: QGenieDiffProvider,
    context: vscode.ExtensionContext
  ) {
    this.diffProvider = diffProvider;
    this.historyStore = new ChatHistoryStore(context);
    this._context = context;
    // Persisted across reloads via globalState.
    this._autoApprove = {
      write_file: context.globalState.get<boolean>('autoApprove.write_file', false),
      execute_command: context.globalState.get<boolean>('autoApprove.execute_command', false),
      auto_scroll: context.globalState.get<boolean>('autoApprove.auto_scroll', true),
      show_thinking: context.globalState.get<boolean>('autoApprove.show_thinking', true),
      strip_emojis: context.globalState.get<boolean>('autoApprove.strip_emojis', true),
      compact_tool: context.globalState.get<boolean>('autoApprove.compact_tool', false),
    };

    // Always have one session to route into; live model fetch may later auto-correct the id.
    const cfg = this._getCachedConfig();
    this._spawnSession(cfg.model, 'New chat');
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    webviewView.webview.html = this._buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // With retainContextWhenHidden the webview JS stays alive, so we
        // only need a lightweight sync to refresh anything that may have
        // changed while the panel was hidden (e.g. model list updates).
        this._view?.webview.postMessage({ type: 'visibility-restored' });
      }
    });
  }

  public loadSkillContext(skill: Skill): void {
    const sess = this._activeSession();
    if (!sess) { return; }
    sess.loadSkillContext(skill);
  }

  public focus(): void { this._view?.show(true); }

  /** Hand a plan agreed by the Discuss team to a fresh chat session and run the agent on it. */
  public executeDiscussionPlan(task: string, plan: string): void {
    const cfg = this._getCachedConfig();
    const sess = this._spawnSession(this._currentModelOr(cfg.model), 'Execute plan');
    this._activeSessionId = sess.id;
    this._sendSessionsState();
    this.focus();
    const prompt =
      'A team of specialist agents discussed the following task and converged on a plan. ' +
      'Implement it end-to-end using your tools (read/edit files, run commands, etc.). ' +
      'Follow the plan but use your own judgement where it is underspecified.\n\n' +
      '=== ORIGINAL TASK ===\n' + task + '\n\n' +
      '=== AGREED PLAN / SUMMARY ===\n' + plan + '\n\n' +
      '=== YOUR JOB ===\nExecute the plan now. Begin.';
    void sess.runAgentLoop(prompt);
  }

  // Per-session coalescing buffers for streaming deltas. Without this every
  // single token from the LLM produces an immediate postMessage (one IPC +
  // structured-clone round-trip per token). For a 50 tok/sec stream that is
  // 50 IPC messages/second, most of which the webview's own rAF then folds
  // into a single frame. Coalescing on the host within ONE event-loop tick
  // (setImmediate fires after the current microtask drain) lets a burst of
  // deltas merge into a single combined message without adding perceptible
  // latency — the webview rAF already caps render rate at ~60Hz anyway.
  private _deltaBuffers = new Map<string, {
    assistantDelta: string;
    thinkingDelta: string;
    timer: NodeJS.Immediate | null;
  }>();

  /** Forward a message to the webview, tagged with its sessionId.
   *  Streaming deltas are coalesced per-session within one event-loop tick
   *  to minimise IPC; non-delta messages force a flush first so ordering
   *  with subsequent events (toolCall, assistantDone, sessionRunning, …) is
   *  preserved. */
  public postToWebview(sessionId: string, msg: Record<string, unknown>): void {
    if (!this._view) { return; }
    const t = msg.type;
    if ((t === 'assistantDelta' || t === 'thinkingDelta') && typeof msg.delta === 'string') {
      let buf = this._deltaBuffers.get(sessionId);
      if (!buf) {
        buf = { assistantDelta: '', thinkingDelta: '', timer: null };
        this._deltaBuffers.set(sessionId, buf);
      }
      if (t === 'assistantDelta') { buf.assistantDelta += msg.delta as string; }
      else { buf.thinkingDelta += msg.delta as string; }
      if (!buf.timer) {
        buf.timer = setImmediate(() => this._flushDeltas(sessionId));
      }
      return;
    }
    // Non-delta message must arrive after all preceding deltas — flush first.
    this._flushDeltas(sessionId);
    try {
      this._view.webview.postMessage({ ...msg, sessionId });
    } catch { /* webview may have been disposed */ }
  }

  /** Drain a session's coalesced delta buffer as ONE postMessage per type.
   *  Called from the setImmediate timer (the natural coalesce tick) and
   *  synchronously by postToWebview when a non-delta event must preserve
   *  ordering. No-op when the buffer is empty. */
  private _flushDeltas(sessionId: string): void {
    const buf = this._deltaBuffers.get(sessionId);
    if (!buf) { return; }
    this._deltaBuffers.delete(sessionId);
    if (buf.timer) { clearImmediate(buf.timer); }
    if (!this._view) { return; }
    try {
      if (buf.assistantDelta) {
        this._view.webview.postMessage({ type: 'assistantDelta', delta: buf.assistantDelta, sessionId });
      }
      if (buf.thinkingDelta) {
        this._view.webview.postMessage({ type: 'thinkingDelta', delta: buf.thinkingDelta, sessionId });
      }
    } catch { /* webview disposed */ }
  }

  /** Request approval for a tool call; serialized FIFO via _approvalQueue.
   *  If signal aborts, resolves false and cleans up the queue entry. */
  public requestApproval(
    sessionId: string,
    sessionTitle: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<boolean> {
    // Honor persisted auto-approve server-side so headless sub-agent paths don't hang.
    // replace_in_file shares the write_file gate via approvalGateKey().
    const gateKey = approvalGateKey(toolName);
    if (this._autoApprove[gateKey]) {
      return Promise.resolve(true);
    }
    // Already-aborted: short-circuit before queuing.
    if (signal?.aborted) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const id = String(++this._approvalCounter);
      const entry = { id, sessionId, sessionTitle, toolName, args, resolve };
      this._approvalQueue.push(entry);
      // Wire abort: if signal fires while queued or showing, resolve denied and
      // clean up so the next pending approval can show.
      if (signal) {
        const onAbort = (): void => {
          // Case 1: currently showing — drop its resolver and let
          // _maybeShowNextApproval pick up the next pending entry.
          if (this._approvalShowing?.id === id) {
            this._pendingResolvers.delete(id);
            this._approvalShowing = null;
            resolve(false);
            this._maybeShowNextApproval();
            return;
          }
          // Case 2: still queued behind others — remove from queue and resolve denied.
          const idx = this._approvalQueue.indexOf(entry);
          if (idx >= 0) { this._approvalQueue.splice(idx, 1); }
          resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this._maybeShowNextApproval();
    });
  }

  private _maybeShowNextApproval(): void {
    if (this._approvalShowing) { return; }
    const next = this._approvalQueue.shift();
    if (!next) { return; }
    this._approvalShowing = { id: next.id };
    this._pendingResolvers.set(next.id, (approved) => {
      next.resolve(approved);
      this._approvalShowing = null;
      this._maybeShowNextApproval();
    });
    this._view?.webview.postMessage({
      type: 'approvalRequired',
      id: next.id,
      sessionId: next.sessionId,
      sessionTitle: next.sessionTitle,
      toolName: next.toolName,
      toolInput: next.args,
      queueDepth: this._approvalQueue.length,
    });
  }

  private _pendingResolvers = new Map<string, (approved: boolean) => void>();

  private async _handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    const targetId = (typeof msg['sessionId'] === 'string' && msg['sessionId'])
      ? String(msg['sessionId'])
      : this._activeSessionId;
    const session = targetId ? this._sessions.get(targetId) : undefined;

    switch (msg.type) {
      case 'ready':
        this._sendInit();
        break;

      case 'sendMessage': {
        if (!session) { return; }
        const text = String(msg['text'] || '');
        const rawImages = msg['images'];
        const images: string[] = Array.isArray(rawImages)
          ? rawImages.filter((u: unknown): u is string =>
              typeof u === 'string' && u.startsWith('data:'))
          : [];
        if (text || images.length > 0) {
          // Don't await — runAgentLoop is long-running; it emits its own events.
          void session.runAgentLoop(text, images);
        }
        break;
      }

      case 'stopGeneration':
        if (session) { session.stopGeneration(); }
        break;

      case 'setModel': {
        if (!session) { return; }
        const model = String(msg['model'] || '');
        if (model) { session.setModel(model); }
        break;
      }

      case 'setSkill': {
        if (!session) { return; }
        const skillName = String(msg['skill'] || '');
        session.setSkill(skillName);
        break;
      }

      case 'attachActiveEditor':
        if (session) { await session.attachActiveEditor(); }
        break;



      case 'openDiff': {
        const fp = String(msg['filePath'] || '');
        if (fp) { await this._openDiffInEditor(fp, Boolean(msg['isNewFile']), String(msg['oldContent'] || '')); }
        break;
      }

      case 'approvalResponse': {
        const id = String(msg['id'] || '');
        const approved = Boolean(msg['approved']);
        const resolver = this._pendingResolvers.get(id);
        if (resolver) {
          this._pendingResolvers.delete(id);
          resolver(approved);
        }
        break;
      }

      case 'approvalResponseAll': {
        const approved = Boolean(msg['approved']);
        // Snapshot + clear the queue FIRST so the showing resolver's call to
        // _maybeShowNextApproval finds nothing to display.
        const drained = this._approvalQueue.splice(0, this._approvalQueue.length);
        // Resolve the currently-showing approval (mirrors abort-cleanup: drop
        // resolver, clear _approvalShowing, then resolve). We clear _approvalShowing
        // before invoking so the pending resolver's _maybeShowNextApproval is a no-op
        // because the queue is already empty.
        const showingId = this._approvalShowing?.id;
        if (showingId) {
          const resolver = this._pendingResolvers.get(showingId);
          if (resolver) {
            this._pendingResolvers.delete(showingId);
            this._approvalShowing = null;
            resolver(approved);
          }
        }
        // Drain every entry that was queued behind the showing one.
        for (const entry of drained) {
          entry.resolve(approved);
        }
        break;
      }

      case 'requestHistory':
        this._sendHistoryList();
        break;

      case 'loadHistorySession': {
        const sid = String(msg['id'] || '');
        if (sid) { this._loadHistorySession(sid); }
        break;
      }

      case 'deleteHistorySession': {
        const sid = String(msg['id'] || '');
        if (sid) {
          await this.historyStore.delete(sid);
          if (session && session.persistedId === sid) {
            this._sessions.delete(session.id);
            const cfg = this._getCachedConfig();
            const next = this._spawnSession(this._currentModelOr(cfg.model), 'New chat');
            this._activeSessionId = next.id;
            this._view?.webview.postMessage({ type: 'chatCleared', sessionId: next.id });
          }
          this._sendHistoryList();
        }
        break;
      }

      case 'clearHistory':
        this.historyStore.clearAll();
        this._sendHistoryList();
        break;

      case 'newTab': {
        const cfg = this._getCachedConfig();
        const sess = this._spawnSession(this._currentModelOr(cfg.model), 'New chat');
        this._activeSessionId = sess.id;
        this._sendSessionsState();
        break;
      }
      case 'newOrchestratorTab': {
        const cfg = this._getCachedConfig();
        const sess = this._spawnSession(this._currentModelOr(cfg.model), 'Orchestrate', true);
        this._activeSessionId = sess.id;
        sess.saveToHistory();
        this._sendSessionsState();
        break;
      }
      case 'switchTab': {
        const sid = String(msg['sessionId'] || '');
        if (sid && this._sessions.has(sid)) {
          this._activeSessionId = sid;
          this._sendSessionsState();
        }
        break;
      }
      case 'closeTab': {
        const sid = String(msg['sessionId'] || '');
        const sess = sid ? this._sessions.get(sid) : undefined;
        if (sess) {
          sess.saveToHistory();
          sess.stopGeneration();
          this._sessions.delete(sid);
          if (this._activeSessionId === sid) {
            const next = this._sessions.values().next().value as AgentSession | undefined;
            if (next) { this._activeSessionId = next.id; }
            else {
              const cfg = this._getCachedConfig();
              const fresh = this._spawnSession(this._currentModelOr(cfg.model), 'New chat');
              this._activeSessionId = fresh.id;
            }
          }
          this._sendSessionsState();
        }
        break;
      }
      case 'requestIndexStatus':
        this.refreshIndexStatus();
        break;

      case 'indexCodebase':
        void vscode.commands.executeCommand('qgenieSkills.indexCodebase');
        break;

      case 'reindexCodebase':
        void vscode.commands.executeCommand('qgenieSkills.reindexCodebase');
        break;

      case 'setAutoApprove': {
        const key = String(msg['key'] || '');
        const value = Boolean(msg['value']);
        // Persisted under autoApprove.<key>; only persist keys already on
        // the in-memory _autoApprove map (seeded by the constructor).
        if (Object.prototype.hasOwnProperty.call(this._autoApprove, key)) {
          this._autoApprove[key] = value;
          this._context.globalState.update(`autoApprove.${key}`, value);
        }
        break;
      }
    }
  }

  private _spawnSession(initialModel: string, title: string, orchestrator = false): AgentSession {
    const id = `s${++this._sessionCounter}-${Date.now().toString(36)}`;
    const sess = new AgentSession(id, title, this, initialModel, orchestrator);
    this._sessions.set(id, sess);
    if (!this._activeSessionId) { this._activeSessionId = id; }
    return sess;
  }

  private _activeSession(): AgentSession | undefined {
    if (!this._activeSessionId) { return undefined; }
    return this._sessions.get(this._activeSessionId);
  }

  /** Seed a new session with the active session's model, else fallback. */
  private _currentModelOr(fallback: string): string {
    const cur = this._activeSession();
    return cur ? cur.currentModel : fallback;
  }

  private async _sendHistoryList(): Promise<void> {
    this._view?.webview.postMessage({
      type: 'historyList',
      sessions: await this.historyStore.list(),
      currentSessionId: this._activeSession()?.persistedId || null,
    });
  }

  /** Load a session from disk, replacing the active session in place. */
  private async _loadHistorySession(id: string): Promise<void> {
    const cur = this._activeSession();
    if (cur) {
      cur.saveToHistory();
      this._sessions.delete(cur.id);
    }
    const sess = await this.historyStore.load(id);
    if (!sess) {
      this._view?.webview.postMessage({
        type: 'systemMessage',
        text: `History session not found: ${id}`,
        isError: true,
      });
      return;
    }
    const cfg = this._getCachedConfig();
    const newSess = this._spawnSession(sess.model || cfg.model, sess.title || 'Restored chat', sess.skillName === '__orchestrator__');
    newSess.restoreFromHistory(sess);
    this._activeSessionId = newSess.id;
    this._view?.webview.postMessage({
      type: 'historyRestore',
      sessionId: newSess.id,
      title: sess.title,
      model: newSess.currentModel,
      skillName: newSess.currentSkill?.name || '',
      events: newSess.eventsLog,
      promptTokens: newSess.totalPromptTokens,
      completionTokens: newSess.totalCompletionTokens,
    });
  }

  private async _sendInit(): Promise<void> {
    const cfg = this._getCachedConfig();
    const allSkills = [...loadSkills(), ...loadSystemSkills()];
    const initialModels = this._liveModels || AVAILABLE_MODELS;
    const active = this._activeSession();
    this._view?.webview.postMessage({
      type: 'init',
      models: initialModels,
      currentModel: active?.currentModel || cfg.model,
      skills: allSkills.map(s => ({ name: s.name, displayName: s.displayName || s.name })),
      currentSkill: active?.currentSkill?.name || '',
      promptTokens: active?.totalPromptTokens || 0,
      completionTokens: active?.totalCompletionTokens || 0,
      history: await this.historyStore.list(),
      currentSessionId: active?.persistedId || null,
      sessions: this._sessionsSnapshot(),
      activeSessionId: this._activeSessionId,
      activeSessionEvents: active?.eventsLog || [],
      activeSessionTitle: active?.title || '',
      activeSessionSkillName: active?.currentSkill?.name || '',
      autoApprove: this._autoApprove,
    });

    // Live model refresh (background).
    if (!this._liveModels && !this._liveModelsFetching) {
      this._liveModelsFetching = true;
      const config = cfg;
      if (!config.apiKey) {
        this._liveModelsFetching = false;
        return;
      }
      fetchAvailableModels(config)
        .then((models) => {
          this._liveModels = models;
          this._liveModelsFetching = false;
          const cur = this._activeSession();
          if (cur) {
            // Match on base id so a ":1M" (or other capability-suffixed) selection
            // is NOT discarded just because the live list only carries the base id.
            const stillValid = models.some(m =>
              m.id === cur.currentModel || baseModelId(m.id) === baseModelId(cur.currentModel));
            if (!stillValid && models.length > 0) {
              cur.setModel(models[0].id);
              this._view?.webview.postMessage({
                type: 'systemMessage',
                text: `Model "${cur.currentModel}" auto-selected (your config's default isn't available with this API key).`,
                isError: false,
              });
            }
          }
          this._view?.webview.postMessage({
            type: 'modelsRefreshed',
            models,
            currentModel: cur?.currentModel,
          });
        })
        .catch((err: Error) => {
          this._liveModelsFetching = false;
          this._view?.webview.postMessage({
            type: 'systemMessage',
            text: `Could not fetch live model list (${err.message}). Showing cached fallback.`,
            isError: true,
          });
        });
    }
  }

  private _sessionsSnapshot(): Array<{ id: string; title: string; running: boolean; model: string; skillName?: string; orchestrator: boolean }> {
    return [...this._sessions.values()].map(s => ({
      id: s.id,
      title: s.title,
      running: s.running,
      model: s.currentModel,
      skillName: s.currentSkill?.name,
      orchestrator: s.orchestrator,
    }));
  }

  /** Push the full sessions snapshot to the webview for tab-strip repaint. */
  private _sendSessionsState(): void {
    this._view?.webview.postMessage({
      type: 'sessionsState',
      sessions: this._sessionsSnapshot(),
      activeSessionId: this._activeSessionId,
    });
  }

  private async _openDiffInEditor(filePath: string, isNewFile: boolean, oldContent: string): Promise<void> {
    try {
      if (isNewFile) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
      } else {
        const beforeUri = this.diffProvider.setBeforeContent(filePath, oldContent);
        await vscode.commands.executeCommand('vscode.diff', beforeUri, vscode.Uri.file(filePath), `[DIFF] ${path.basename(filePath)}`, { preview: false });
      }
    } catch (err: unknown) {
      vscode.window.setStatusBarMessage(`NEXUS: diff error: ${err instanceof Error ? err.message : String(err)}`, 5000);
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NEXUS</title>
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-sideBar-background, #1e1e1e);
  }
  body.nexus-booting { visibility: hidden; }
  body.nexus-ready { animation: nexus-fade-in 0.18s ease-out; }
  @keyframes nexus-fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
<link rel="stylesheet" href="${cssUri}">
</head>
<body class="nexus-booting">
<div id="drop-overlay">
  <div id="drop-overlay-text">[ DROP TO ATTACH ]</div>
</div>
<input type="file" id="image-file-input" accept="image/*" multiple style="display:none;">

<div id="header">
  <span id="header-title">NEXUS</span>
  <button class="hdr-btn" id="index-btn" title="Index this codebase locally (no AI) so the agent sends only relevant snippets">[INDEX]</button>

  <button class="hdr-btn" id="history-btn" title="Chat History">[HIST]</button>
  <button class="hdr-btn" id="settings-btn" title="Settings">[CFG]</button>
</div>
<div id="token-bar">
  <span id="token-label">TOKENS</span>
  <div id="token-track"><div id="token-fill"></div></div>
  <span id="token-count">0</span>
</div>
<div id="tab-strip">
  <button class="tab-new-btn" id="tab-new-btn" title="New chat tab">[+]</button>
  <button class="tab-orch-btn" id="tab-orch-btn" title="Deploy parallel agent nodes — coordinate them from one tab">[▣ DEPLOY]</button>
</div>
<div id="selectors">
  <div class="sel-group"><span class="sel-label">MODEL:</span><select id="model-select"></select></div>
  <div class="sel-group"><span class="sel-label">SKILL:</span><select id="skill-select"><option value="">-- none --</option></select></div>
</div>
<div id="settings-panel">
  <div class="settings-title">// AUTO-APPROVE CONFIG</div>
  <div class="settings-row">
    <div class="settings-row-label"><span class="settings-row-name">write_file</span><span class="settings-row-desc">skip approval for file writes</span></div>
    <label class="toggle-wrap"><input type="checkbox" id="auto-approve-write"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>
  </div>
  <div class="settings-row">
    <div class="settings-row-label"><span class="settings-row-name">execute_command</span><span class="settings-row-desc">skip approval for shell commands</span></div>
    <label class="toggle-wrap"><input type="checkbox" id="auto-approve-exec"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>
  </div>
  <div class="settings-title" style="margin-top:7px;">// UI CONFIG</div>
  <div class="settings-row">
    <div class="settings-row-label"><span class="settings-row-name">auto-scroll</span><span class="settings-row-desc">follow output while streaming</span></div>
    <label class="toggle-wrap"><input type="checkbox" id="auto-scroll-toggle"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>
  </div>
  <div class="settings-row">
    <div class="settings-row-label"><span class="settings-row-name">show thinking</span><span class="settings-row-desc">show the reasoning / thinking panel</span></div>
    <label class="toggle-wrap"><input type="checkbox" id="show-thinking-toggle"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>
  </div>
  <div class="settings-row">
    <div class="settings-row-label"><span class="settings-row-name">strip emojis</span><span class="settings-row-desc">remove emoji from agent output</span></div>
    <label class="toggle-wrap"><input type="checkbox" id="strip-emojis-toggle"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>
  </div>
  <div class="settings-row">
    <div class="settings-row-label"><span class="settings-row-name">compact output</span><span class="settings-row-desc">condense tool output blocks</span></div>
    <label class="toggle-wrap"><input type="checkbox" id="compact-tool-toggle"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>
  </div>
</div>
<div id="thread">
  <div id="empty-state">
    <!-- The Nexus ASCII splash is intentionally rendered EMPTY in the
         initial HTML. The webview JS bundle replaces this whole #empty-state
         with a per-tab empty-state and runs the Matrix-cascade decode on
         its own freshly-created splash element. Baking the static ASCII in
         here just made the user stare at a frozen frame for ~1s while the
         JS bundle parsed, before the animation finally kicked in. Empty +
         reserved CSS height means: blank-where-the-art-will-be → cascade
         decode is the FIRST animation the user sees. -->
    <pre class="splash splash-empty"></pre>
    <div class="empty-sub">NEXUS v0.5 // READY</div>
    <div class="empty-chips">
      <button class="chip" onclick="quickSend('list workspace files')">list workspace</button>
      <button class="chip" onclick="quickSend('read the active editor file and explain it')">read active file</button>
      <button class="chip" onclick="quickSend('git status')">git status</button>
      <button class="chip" onclick="quickSend('find all TODO comments in the codebase')">find TODOs</button>
    </div>
  </div>
</div>
<div id="approval-bar">
  <div class="approval-top-row"><span class="approval-badge">[!] APPROVAL REQUIRED</span><span id="approval-bar-title"></span><span id="approval-queue-count"></span></div>
  <div id="approval-bar-preview"></div>
  <div class="approval-btns"><button id="approval-allow-btn">[Y] ALLOW</button><button id="approval-deny-btn">[N] DENY</button><button id="approval-allow-all-btn">[YY] ALLOW ALL</button><button id="approval-deny-all-btn">[NN] DENY ALL</button></div>
</div>
<div id="thoughts-panel">
  <div id="thoughts-panel-header" title="Click to expand / collapse the agent's reasoning log">
    <span id="thoughts-panel-title">[~] THINKING</span>
    <span id="thoughts-panel-status">// idle</span>
    <button id="thoughts-clear-btn" title="Clear all thoughts" onclick="event.stopPropagation()">[CLEAR]</button>
    <span id="thoughts-chevron">[+]</span>
  </div>
  <div id="thoughts-panel-body">
    <div class="thoughts-empty">// no thoughts yet — they'll appear here as the agent reasons</div>
  </div>
</div>
<div id="input-area">
  <div id="pending-images"></div>
  <div id="input-row">
    <textarea id="chat-input" placeholder="> enter command (or paste/drop an image)..." rows="1"></textarea>
    <button id="send-btn" title="Send (Enter)">[&gt;]</button>
    <button id="stop-btn" title="Stop">[.]</button>
  </div>
  <div id="action-row">
    <button class="action-btn" id="attach-editor-btn" title="Attach the active editor file">[EDITOR]</button>

    <button class="action-btn" id="attach-image-btn" title="Attach an image (or paste / drag-and-drop)">[IMAGE]</button>
    <span class="input-hint">SHIFT+ENTER = NEWLINE</span>
  </div>
</div>

<div id="history-overlay">
  <div id="history-panel">
    <div id="history-panel-head">
      <span id="history-panel-title">[~] CHAT HISTORY</span>
      <button id="history-panel-close" title="Close">[X]</button>
    </div>
    <div id="history-panel-body">
      <div class="history-empty">// no chats yet</div>
    </div>
    <div id="history-panel-foot">
      <button id="history-clear-all-btn" title="Delete every saved chat">[CLEAR ALL]</button>
      <span id="history-foot-hint">click a row to load &middot; [DEL] to remove</span>
    </div>
  </div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}


