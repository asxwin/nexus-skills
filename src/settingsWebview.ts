
import * as vscode from 'vscode';
import {
  loadQGenieConfig,
  saveQGenieConfig,
  maskApiKey,
  validateApiKey,
  fetchAvailableModels,
  AvailableModel,
  QGENIE_CONFIG_PATH,
  API_BASE,
} from './qgenieApi';
import { ChatHistoryStore, ChatHistorySummary } from './chatHistory';
import { SkillsTreeProvider } from './skillsTreeProvider';
import { esc, getNonce } from './webviewUtils';

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 20px 24px;
  line-height: 1.6;
  max-width: 760px;
}
h1 { font-size: 1.3em; font-weight: 700; margin-bottom: 4px; }
h2 { font-size: 0.82em; font-weight: 600; text-transform: uppercase;
     letter-spacing: 0.08em; color: var(--vscode-descriptionForeground);
     margin-bottom: 8px; margin-top: 24px; }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-bottom: 20px; }
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 20px 0; }
label { display: block; font-weight: 600; font-size: 0.85em; margin-bottom: 4px; }
.hint { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
input, select {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 7px 10px;
  font-family: var(--vscode-font-family);
  font-size: 0.9em;
}
input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
.form-group { margin-bottom: 16px; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 18px; }
button { padding: 6px 18px; border: none; border-radius: 4px; cursor: pointer;
         font-size: 0.9em; font-family: var(--vscode-font-family); }
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-ghost { background: none; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
.btn-ghost:hover { background: var(--vscode-list-hoverBackground); }
.card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border);
        border-radius: 6px; padding: 16px; margin-bottom: 16px; }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; font-size: 0.9em; }
.kv .k { color: var(--vscode-descriptionForeground); }
.kv .v { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.status { font-size: 0.85em; margin-top: 10px; min-height: 1.2em; }
.status.ok { color: var(--vscode-testing-iconPassed, #4caf50); }
.status.err { color: var(--vscode-errorForeground); }
.status.muted { color: var(--vscode-descriptionForeground); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.72em; font-weight: 600;
        background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.pill.vision { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.model-group { margin-bottom: 14px; }
.model-group .vendor { font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--vscode-button-background); margin-bottom: 6px; }
.model-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 0.88em; }
.model-row .id { font-family: var(--vscode-editor-font-family, monospace); flex: 1; word-break: break-all; }
.spin { color: var(--vscode-descriptionForeground); font-size: 0.88em; }

/* ── Upgraded Insights styles ──────────────────────────────────────── */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 4px; }
.stat-tile { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border);
             border-radius: 6px; padding: 10px 12px; }
.stat-tile .num { font-size: 1.4em; font-weight: 700; color: var(--vscode-foreground);
                  font-family: var(--vscode-editor-font-family, monospace); line-height: 1.2; }
.stat-tile .lbl { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em;
                  color: var(--vscode-descriptionForeground); margin-top: 2px; }
.stat-tile.accent .num { color: var(--vscode-button-background); }

.bar-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.bar-row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 8px;
           font-size: 0.86em; }
.bar-row .nm { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground);
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-row .vl { color: var(--vscode-descriptionForeground); font-size: 0.82em; }
.bar-row .track { grid-column: 1 / span 2; height: 4px; background: var(--vscode-panel-border);
                  border-radius: 2px; overflow: hidden; }
.bar-row .fill { height: 100%; background: var(--vscode-button-background); border-radius: 2px; }

.feature-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
                gap: 6px 12px; margin-top: 4px; }
.feature-list .feat { font-size: 0.86em; padding: 3px 0; color: var(--vscode-foreground); }
.feature-list .feat::before { content: '✓ '; color: var(--vscode-testing-iconPassed, #4caf50); font-weight: 700; }

.link-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.link-list a { color: var(--vscode-textLink-foreground); text-decoration: none; font-size: 0.88em;
               font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.link-list a:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground); }
.link-list .lbl { color: var(--vscode-descriptionForeground); font-size: 0.78em;
                  font-family: var(--vscode-font-family); }

.sess-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.sess-row { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: baseline;
            font-size: 0.86em; padding: 4px 6px; border-radius: 4px; }
.sess-row:hover { background: var(--vscode-list-hoverBackground); }
.sess-row .ttl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-row .meta { font-size: 0.78em; color: var(--vscode-descriptionForeground);
                  font-family: var(--vscode-editor-font-family, monospace); }
.sess-row .when { font-size: 0.78em; color: var(--vscode-descriptionForeground); }

.empty { color: var(--vscode-descriptionForeground); font-size: 0.86em; font-style: italic; padding: 6px 0; }

.model-row.is-default { background: var(--vscode-editor-selectionBackground); border-radius: 3px;
                        margin: 0 -4px; padding: 3px 4px; }
.model-row.is-default .id::after { content: ' (default)'; color: var(--vscode-button-background);
                                   font-weight: 600; font-size: 0.78em; }

.tabs-container { background: var(--vscode-button-secondaryBackground);
                  color: var(--vscode-button-secondaryForeground); border-radius: 4px;
                  padding: 1px 7px; font-size: 0.72em; font-weight: 600; }
`;

function htmlShell(nonce: string, title: string, body: string, script: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style></head><body>
${body}
<script nonce="${nonce}">${script}</script>
</body></html>`;
}

export class ApiKeyPanel {
  public static currentPanel: ApiKeyPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static show(): void {
    const col = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ApiKeyPanel.currentPanel) {
      ApiKeyPanel.currentPanel._panel.reveal(col);
      ApiKeyPanel.currentPanel._render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nexusApiKey',
      'NEXUS: API Key',
      col,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ApiKeyPanel.currentPanel = new ApiKeyPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._render();
    this._panel.webview.onDidReceiveMessage((msg) => this._onMessage(msg), null, this._disposables);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private async _onMessage(msg: { command: string; value?: string }): Promise<void> {
    if (msg.command === 'save') {
      const key = (msg.value || '').trim();
      if (!key) {
        this._post({ type: 'status', kind: 'err', text: 'API key cannot be empty.' });
        return;
      }
      try {
        saveQGenieConfig({ apiKey: key });
        this._post({ type: 'status', kind: 'ok', text: '✓ Saved to ' + QGENIE_CONFIG_PATH });
        this._post({ type: 'masked', text: maskApiKey(loadQGenieConfig().apiKey) });
        vscode.window.setStatusBarMessage('NEXUS: API key updated', 2500);
      } catch (e) {
        this._post({ type: 'status', kind: 'err', text: 'Save failed: ' + (e as Error).message });
      }
    } else if (msg.command === 'test') {
      const key = (msg.value || '').trim() || loadQGenieConfig().apiKey;
      if (!key) {
        this._post({ type: 'status', kind: 'err', text: 'No key to test.' });
        return;
      }
      this._post({ type: 'status', kind: 'muted', text: 'Testing key against ' + API_BASE + ' …' });
      try {
        const n = await validateApiKey(key);
        this._post({ type: 'status', kind: 'ok', text: `✓ Key works — ${n} chat model(s) available.` });
      } catch (e) {
        this._post({ type: 'status', kind: 'err', text: '✗ Key rejected: ' + (e as Error).message });
      }
    } else if (msg.command === 'openInsights') {
      vscode.commands.executeCommand('qgenieSkills.openInsights');
    }
  }

  private _post(m: unknown): void { this._panel.webview.postMessage(m); }

  private _render(): void {
    const nonce = getNonce();
    const cfg = loadQGenieConfig();
    const masked = maskApiKey(cfg.apiKey);
    const body = `
<h1>API Key</h1>
<p class="subtitle">Stored in <code>${esc(QGENIE_CONFIG_PATH)}</code></p>
<div class="card">
  <div class="form-group">
    <label>Current key</label>
    <div class="kv"><span class="v" id="masked">${esc(masked)}</span></div>
  </div>
  <div class="form-group">
    <label for="key">New API key</label>
    <div class="hint">Paste your QGenie API key. It is written to the config file with 0600 permissions.</div>
    <input type="password" id="key" placeholder="qg_..." autocomplete="off" spellcheck="false" />
  </div>
  <div class="btn-row">
    <button class="btn-primary" id="saveBtn">Save</button>
    <button class="btn-ghost" id="testBtn">Test connection</button>
    <button class="btn-ghost" id="showBtn">Show/Hide</button>
    <button class="btn-ghost" id="insightsBtn">View Insights →</button>
  </div>
  <div class="status muted" id="status"></div>
</div>`;
    const script = `
const vscode = acquireVsCodeApi();
const keyEl = document.getElementById('key');
const statusEl = document.getElementById('status');
function setStatus(kind, text){ statusEl.className = 'status ' + kind; statusEl.textContent = text; }
document.getElementById('saveBtn').addEventListener('click', () => vscode.postMessage({ command:'save', value: keyEl.value }));
document.getElementById('testBtn').addEventListener('click', () => vscode.postMessage({ command:'test', value: keyEl.value }));
document.getElementById('insightsBtn').addEventListener('click', () => vscode.postMessage({ command:'openInsights' }));
document.getElementById('showBtn').addEventListener('click', () => { keyEl.type = keyEl.type === 'password' ? 'text' : 'password'; });
keyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') vscode.postMessage({ command:'save', value: keyEl.value }); });
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'status') setStatus(m.kind, m.text);
  else if (m.type === 'masked') document.getElementById('masked').textContent = m.text;
});`;
    this._panel.webview.html = htmlShell(nonce, 'API Key', body, script);
  }

  public dispose(): void {
    ApiKeyPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }
}

function vendorOf(id: string): string {
  if (id.startsWith('anthropic::')) { return 'Anthropic'; }
  if (id.startsWith('azure::') || id.startsWith('openai::')) { return 'OpenAI / Azure'; }
  if (id.startsWith('vertexai::') || id.startsWith('google::')) { return 'Google Gemini'; }
  return 'Self-hosted / Open-weights';
}

/** Curated set of NEXUS capability statements — what this extension can do. */
const NEXUS_FEATURES: string[] = [
  'Streaming chat with full conversation history',
  'Multimodal input (vision-capable models)',
  'File read/write/edit with diff preview',
  'Shell command execution (with approval)',
  'Multi-tab parallel chat sessions',
  'Reusable Skills (system + user)',
  'Multi-agent orchestration (delegate_task)',
  'Tool calling (XML-style, batched)',
  'Persistent chat history (last 100 sessions)',
  'Live model catalog from /v1/models',
  'Workspace-aware context injection',
  'VS Code language-server diagnostics',
];


/** Local-only usage snapshot built from on-disk ChatHistorySummary entries
 *  (the QGenie gateway exposes no remote quota endpoint). */
interface UsageSnapshot {
  sessionCount: number;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastActivity: number | null;
  firstActivity: number | null;
  modelBreakdown: Array<{ id: string; tokens: number; sessions: number }>;
  skillBreakdown: Array<{ name: string; sessions: number }>;
  recentSessions: Array<{
    id: string;
    title: string;
    model: string;
    skillName: string | null;
    tokens: number;
    messageCount: number;
    updatedAt: number;
  }>;
}

function buildUsageSnapshot(sessions: ChatHistorySummary[]): UsageSnapshot {
  const snap: UsageSnapshot = {
    sessionCount: sessions.length,
    messageCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastActivity: null,
    firstActivity: null,
    modelBreakdown: [],
    skillBreakdown: [],
    recentSessions: [],
  };
  const byModel = new Map<string, { tokens: number; sessions: number }>();
  const bySkill = new Map<string, { sessions: number }>();
  for (const s of sessions) {
    const tok = (s.promptTokens || 0) + (s.completionTokens || 0);
    snap.messageCount += s.messageCount || 0;
    snap.promptTokens += s.promptTokens || 0;
    snap.completionTokens += s.completionTokens || 0;
    snap.totalTokens += tok;
    if (snap.lastActivity === null || s.updatedAt > snap.lastActivity) { snap.lastActivity = s.updatedAt; }
    if (snap.firstActivity === null || s.createdAt < snap.firstActivity) { snap.firstActivity = s.createdAt; }
    const mid = s.model || '(unknown)';
    const me = byModel.get(mid) || { tokens: 0, sessions: 0 };
    me.tokens += tok; me.sessions += 1;
    byModel.set(mid, me);
    if (s.skillName) {
      const se = bySkill.get(s.skillName) || { sessions: 0 };
      se.sessions += 1;
      bySkill.set(s.skillName, se);
    }
  }
  snap.modelBreakdown = Array.from(byModel.entries())
    .map(([id, v]) => ({ id, tokens: v.tokens, sessions: v.sessions }))
    .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions);
  snap.skillBreakdown = Array.from(bySkill.entries())
    .map(([name, v]) => ({ name, sessions: v.sessions }))
    .sort((a, b) => b.sessions - a.sessions);
  snap.recentSessions = sessions.slice(0, 8).map((s) => ({
    id: s.id,
    title: s.title || '(untitled)',
    model: s.model || '(unknown)',
    skillName: s.skillName || null,
    tokens: (s.promptTokens || 0) + (s.completionTokens || 0),
    messageCount: s.messageCount || 0,
    updatedAt: s.updatedAt,
  }));
  return snap;
}

export class InsightsPanel {
  public static currentPanel: InsightsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _history?: ChatHistoryStore;
  private _tree?: SkillsTreeProvider;
  private _modelsCache: { models: AvailableModel[]; timestamp: number } | undefined;
  private _usageCache: { snap: UsageSnapshot; sessionCount: number; timestamp: number } | undefined;

  /** Open (or focus) the Insights panel. Missing historyStore/skillsTree
   *  cause the corresponding section to degrade to "no data". */
  public static show(historyStore?: ChatHistoryStore, skillsTree?: SkillsTreeProvider): void {
    const col = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (InsightsPanel.currentPanel) {
      // Update plumbing on every show — caller may have just become available.
      if (historyStore) { InsightsPanel.currentPanel._history = historyStore; }
      if (skillsTree)   { InsightsPanel.currentPanel._tree    = skillsTree; }
      InsightsPanel.currentPanel._panel.reveal(col);
      InsightsPanel.currentPanel._refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nexusInsights',
      'NEXUS: Insights',
      col,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    InsightsPanel.currentPanel = new InsightsPanel(panel, historyStore, skillsTree);
  }

  private constructor(panel: vscode.WebviewPanel, history?: ChatHistoryStore, tree?: SkillsTreeProvider) {
    this._panel = panel;
    this._history = history;
    this._tree = tree;
    this._panel.webview.html = this._html();
    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'refresh') { this._refresh(); }
      else if (msg.command === 'editKey') { vscode.commands.executeCommand('qgenieSkills.updateApiKey'); }
      else if (msg.command === 'openChat') { vscode.commands.executeCommand('qgenieSkills.openChat'); }
      else if (msg.command === 'createSkill') { vscode.commands.executeCommand('qgenieSkills.createSkill'); }
    }, null, this._disposables);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._refresh();
  }

  private _post(m: unknown): void { this._panel.webview.postMessage(m); }

  private async _refresh(): Promise<void> {
    const cfg = loadQGenieConfig();
    this._post({
      type: 'config',
      masked: maskApiKey(cfg.apiKey),
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      configPath: QGENIE_CONFIG_PATH,
      apiBase: API_BASE,
    });

    if (this._history) {
      // Local on-disk history (max 100 sessions); no remote quota call.
      // Cache the usage snapshot; invalidate when session count changes.
      const sessions = await this._history.list();
      const now = Date.now();
      if (this._usageCache && this._usageCache.sessionCount === sessions.length) {
        this._post({ type: 'usage', snap: this._usageCache.snap });
      } else {
        const snap = buildUsageSnapshot(sessions);
        this._usageCache = { snap, sessionCount: sessions.length, timestamp: now };
        this._post({ type: 'usage', snap });
      }
    } else {
      this._post({ type: 'usage', snap: null });
    }

    if (this._tree) {
      this._post({
        type: 'skills',
        userCount: this._tree.getUserSkills().length,
        systemCount: this._tree.getSystemSkills().length,
      });
    } else {
      this._post({ type: 'skills', userCount: 0, systemCount: 0 });
    }

    // Models cache: reuse if fetched within the last 60 seconds.
    const now = Date.now();
    if (this._modelsCache && (now - this._modelsCache.timestamp) < 60_000) {
      const models = this._modelsCache.models;
      const groups: Record<string, AvailableModel[]> = {};
      for (const m of models) {
        const v = vendorOf(m.id);
        (groups[v] = groups[v] || []).push(m);
      }
      this._post({
        type: 'models', ok: true, count: models.length, groups,
        defaultModel: cfg.model,
      });
    } else {
      this._post({ type: 'modelsLoading' });
      try {
        const models = await fetchAvailableModels(cfg);
        this._modelsCache = { models, timestamp: Date.now() };
        const groups: Record<string, AvailableModel[]> = {};
        for (const m of models) {
          const v = vendorOf(m.id);
          (groups[v] = groups[v] || []).push(m);
        }
        this._post({
          type: 'models', ok: true, count: models.length, groups,
          defaultModel: cfg.model,
        });
      } catch (e) {
        this._post({ type: 'models', ok: false, error: (e as Error).message });
      }
    }
  }

  private _html(): string {
    const nonce = getNonce();
    const featureHtml = NEXUS_FEATURES.map((f) => `<div class="feat">${esc(f)}</div>`).join('');
    const body = `
<h1>NEXUS Insights</h1>
<p class="subtitle">A live snapshot of your gateway access, local activity, and what NEXUS can do.</p>

<h2>Connection</h2>
<div class="card">
  <div class="kv">
    <span class="k">API key</span><span class="v" id="masked">…</span>
    <span class="k">Gateway</span><span class="v" id="apiBase">…</span>
    <span class="k">Default model</span><span class="v" id="model">…</span>
    <span class="k">Max tokens</span><span class="v" id="maxTokens">…</span>
    <span class="k">Config file</span><span class="v" id="configPath">…</span>
  </div>
  <div class="status muted" id="keyStatus">Checking access…</div>
  <div class="btn-row">
    <button class="btn-primary" id="refreshBtn">Refresh</button>
    <button class="btn-ghost" id="editBtn">Update API key</button>
    <button class="btn-ghost" id="chatBtn">Open Chat</button>
  </div>
</div>

<h2>Local usage <span class="spin" id="usageRange"></span></h2>
<div class="card" id="usageCard">
  <div class="stat-grid" id="usageTiles"><div class="spin">Loading…</div></div>
  <div id="usageBreakdowns"></div>
  <div class="hint" style="margin-top:10px">
    Counted from your on-disk chat history (max 100 sessions). The QGenie gateway does
    not expose a public quota endpoint, so this is local activity only.
  </div>
</div>

<h2>Recent sessions</h2>
<div class="card" id="recentCard"><div class="spin">Loading…</div></div>

<h2>Skills</h2>
<div class="card" id="skillsCard">
  <div class="stat-grid">
    <div class="stat-tile"><div class="num" id="userSkills">…</div><div class="lbl">My skills</div></div>
    <div class="stat-tile"><div class="num" id="sysSkills">…</div><div class="lbl">System skills</div></div>
    <div class="stat-tile"><div class="num" id="totalSkills">…</div><div class="lbl">Total available</div></div>
  </div>
  <div class="btn-row">
    <button class="btn-ghost" id="newSkillBtn">+ New skill</button>
  </div>
</div>

<h2>NEXUS capabilities</h2>
<div class="card">
  <div class="feature-list">${featureHtml}</div>
</div>

<h2>Available models <span class="spin" id="modelCount"></span></h2>
<div class="card" id="modelsCard"><div class="spin">Loading…</div></div>`;
    const script = `
const vscode = acquireVsCodeApi();
function setText(id, t){ const el = document.getElementById(id); if (el) el.textContent = t; }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ command:'refresh' }));
document.getElementById('editBtn').addEventListener('click', () => vscode.postMessage({ command:'editKey' }));
document.getElementById('chatBtn').addEventListener('click', () => vscode.postMessage({ command:'openChat' }));
document.getElementById('newSkillBtn').addEventListener('click', () => vscode.postMessage({ command:'createSkill' }));


function fmtNum(n){
  if (n === null || n === undefined) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\\.0$/, '') + 'k';
  return String(n);
}
function fmtDate(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const ago = now - ts;
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return Math.floor(ago / 60_000) + 'm ago';
  if (ago < 86_400_000) return Math.floor(ago / 3_600_000) + 'h ago';
  if (ago < 7 * 86_400_000) return Math.floor(ago / 86_400_000) + 'd ago';
  return d.toISOString().slice(0, 10);
}
function shortModel(id){
  if (!id) return '(unknown)';
  const i = id.indexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

function renderUsage(snap){
  const tiles = document.getElementById('usageTiles');
  const breakdowns = document.getElementById('usageBreakdowns');
  const range = document.getElementById('usageRange');
  if (!snap || snap.sessionCount === 0) {
    tiles.innerHTML = '<div class="empty">No chat sessions yet — start a conversation to see usage stats.</div>';
    breakdowns.innerHTML = '';
    range.textContent = '';
    return;
  }
  range.textContent = '(' + (snap.firstActivity ? 'since ' + new Date(snap.firstActivity).toISOString().slice(0,10) : '') + ')';
  tiles.innerHTML = ''
    + tile(snap.sessionCount, 'Sessions')
    + tile(snap.messageCount, 'Messages')
    + tile(fmtNum(snap.promptTokens), 'Prompt tokens')
    + tile(fmtNum(snap.completionTokens), 'Completion tokens')
    + tile(fmtNum(snap.totalTokens), 'Total tokens', true)
    + tile(fmtDate(snap.lastActivity), 'Last activity');

  let bd = '';
  if (snap.modelBreakdown.length > 0) {
    const max = snap.modelBreakdown[0].tokens || 1;
    bd += '<h2 style="margin-top:18px">Top models by tokens</h2>';
    bd += '<div class="bar-list">';
    for (const m of snap.modelBreakdown.slice(0, 6)) {
      const pct = Math.round((m.tokens / max) * 100);
      bd += '<div class="bar-row">'
         + '<span class="nm">' + esc(shortModel(m.id)) + '</span>'
         + '<span class="vl">' + fmtNum(m.tokens) + ' tok · ' + m.sessions + ' sess</span>'
         + '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>'
         + '</div>';
    }
    bd += '</div>';
  }
  if (snap.skillBreakdown.length > 0) {
    const max = snap.skillBreakdown[0].sessions || 1;
    bd += '<h2 style="margin-top:18px">Top skills by sessions</h2>';
    bd += '<div class="bar-list">';
    for (const s of snap.skillBreakdown.slice(0, 6)) {
      const pct = Math.round((s.sessions / max) * 100);
      bd += '<div class="bar-row">'
         + '<span class="nm">$' + esc(s.name) + '</span>'
         + '<span class="vl">' + s.sessions + ' sessions</span>'
         + '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>'
         + '</div>';
    }
    bd += '</div>';
  }
  breakdowns.innerHTML = bd;
}

function tile(num, label, accent){
  return '<div class="stat-tile' + (accent ? ' accent' : '') + '">'
       + '<div class="num">' + esc(String(num)) + '</div>'
       + '<div class="lbl">' + esc(label) + '</div>'
       + '</div>';
}

function renderRecent(recent){
  const card = document.getElementById('recentCard');
  if (!recent || recent.length === 0) {
    card.innerHTML = '<div class="empty">No sessions yet.</div>';
    return;
  }
  let html = '<div class="sess-list">';
  for (const s of recent) {
    const skillBadge = s.skillName ? ' · $' + esc(s.skillName) : '';
    html += '<div class="sess-row">'
         + '<span class="ttl">' + esc(s.title) + '</span>'
         + '<span class="meta">' + esc(shortModel(s.model)) + skillBadge + ' · ' + s.messageCount + ' msg · ' + fmtNum(s.tokens) + ' tok</span>'
         + '<span class="when">' + fmtDate(s.updatedAt) + '</span>'
         + '</div>';
  }
  html += '</div>';
  card.innerHTML = html;
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'config') {
    setText('masked', m.masked);
    setText('apiBase', m.apiBase);
    setText('model', m.model);
    setText('maxTokens', String(m.maxTokens));
    setText('configPath', m.configPath);
  } else if (m.type === 'usage') {
    renderUsage(m.snap);
    renderRecent(m.snap ? m.snap.recentSessions : []);
  } else if (m.type === 'skills') {
    setText('userSkills', String(m.userCount));
    setText('sysSkills', String(m.systemCount));
    setText('totalSkills', String(m.userCount + m.systemCount));
  } else if (m.type === 'modelsLoading') {
    document.getElementById('modelsCard').innerHTML = '<div class="spin">Loading…</div>';
    setText('modelCount', '');
    const ks = document.getElementById('keyStatus'); ks.className = 'status muted'; ks.textContent = 'Checking access…';
  } else if (m.type === 'models') {
    const ks = document.getElementById('keyStatus');
    const card = document.getElementById('modelsCard');
    if (!m.ok) {
      ks.className = 'status err'; ks.textContent = '✗ Could not reach gateway: ' + m.error;
      card.innerHTML = '<div class="status err">' + esc(m.error) + '</div>';
      setText('modelCount', '');
      return;
    }
    ks.className = 'status ok'; ks.textContent = '✓ Key valid — ' + m.count + ' chat model(s) reachable.';
    setText('modelCount', '(' + m.count + ')');
    let html = '';
    const vendors = Object.keys(m.groups);
    for (const vendor of vendors) {
      html += '<div class="model-group"><div class="vendor">' + esc(vendor)
           + ' <span style="color:var(--vscode-descriptionForeground);font-weight:400">('
           + m.groups[vendor].length + ')</span></div>';
      for (const mod of m.groups[vendor]) {
        const isDef = mod.id === m.defaultModel;
        html += '<div class="model-row' + (isDef ? ' is-default' : '') + '">'
             + '<span class="id">' + esc(mod.id) + '</span>'
             + (mod.vision ? '<span class="pill vision">vision</span>' : '')
             + '</div>';
      }
      html += '</div>';
    }
    card.innerHTML = html || '<div class="spin">No chat models returned.</div>';
  }
});`;
    return htmlShell(nonce, 'Insights', body, script);
  }

  public dispose(): void {
    InsightsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }
}
