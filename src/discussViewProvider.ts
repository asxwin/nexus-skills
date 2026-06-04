// DiscussViewProvider — webview host for the "Discuss" tab.
// Hosts a panel where several role-specialised AI agents (Planner, Coder,
// Reviewer, Researcher) debate the user's problem over multiple rounds via the
// real LLM and converge on a final solution. The actual multi-agent loop lives
// in DiscussEngine; this provider only owns the webview, builds its HTML shell,
// bridges webview<->engine messages, and manages the model list + cancellation.

import * as vscode from 'vscode';
import {
  loadQGenieConfig,
  fetchAvailableModels,
  AvailableModel,
  AVAILABLE_MODELS,
} from './qgenieApi';
import { DiscussEngine, DiscussEvent, DiscussConfig } from './discussEngine';
import { getNonce } from './webviewUtils';

export class DiscussViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nexusDiscussView';

  private _view?: vscode.WebviewView;
  private _abort: AbortController | null = null;
  private _engine: DiscussEngine | null = null;
  private _liveModels: AvailableModel[] | null = null;
  private _liveModelsFetching = false;
  private _lastTask = '';
  private _lastSolution = '';
  private _onExecutePlan: ((task: string, plan: string) => void) | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Wire a handler that hands the agreed discussion plan to the chat agent. */
  public set onExecutePlan(cb: (task: string, plan: string) => void) {
    this._onExecutePlan = cb;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    try {
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
      };
      webviewView.webview.html = this._buildHtml(webviewView.webview);
      webviewView.webview.onDidReceiveMessage((msg) => {
        Promise.resolve(this._handleMessage(msg)).catch((err) => {
          this._post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        });
      });
      webviewView.onDidDispose(() => {
        this._abort?.abort();
        this._abort = null;
      });
    } catch (err) {
      webviewView.webview.html =
        '<!DOCTYPE html><html><body style="font-family:monospace;padding:12px;color:#ccc">' +
        '// DISCUSS failed to load: ' + String(err instanceof Error ? err.message : err) +
        '</body></html>';
    }
  }

  public focus(): void { this._view?.show(true); }

  private _post(msg: Record<string, unknown>): void {
    try { this._view?.webview.postMessage(msg); } catch { /* webview disposed */ }
  }

  private async _handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this._sendInit();
        break;

      case 'startDiscuss': {
        // One debate at a time — cancel any prior run first.
        this._abort?.abort();
        this._abort = new AbortController();

        const task = String(msg['task'] || '').trim();
        if (!task) {
          this._post({ type: 'error', message: 'Enter a problem to discuss first.' });
          this._post({ type: 'done' });
          return;
        }
        // Remember this run so the agreed plan can be handed to the chat agent.
        this._lastTask = task;
        this._lastSolution = '';
        const cfg = loadQGenieConfig();
        const model = String(msg['model'] || '') || cfg.model;
        const roundsRaw = Number(msg['rounds']);
        const maxRounds = Number.isFinite(roundsRaw) && roundsRaw > 0
          ? Math.min(12, Math.floor(roundsRaw))
          : 4;
        const rawAgents = msg['agents'];
        const agents = Array.isArray(rawAgents)
          ? rawAgents.filter((a): a is string => typeof a === 'string')
          : ['planner', 'coder', 'reviewer'];

        // Live inter-agent chatter (broadcast thinking + interjections) is on by
        // default; the webview may send liveChat:false to disable it.
        const liveChat = msg['liveChat'] !== false;
        const discussConfig: DiscussConfig = { task, model, maxRounds, agents, liveChat };
        const engine = new DiscussEngine((e: DiscussEvent) => {
          const ev = e as unknown as Record<string, unknown>;
          // Capture the converged solution so we can offer to execute it, and
          // tell the webview the plan is ready (reveals the EXECUTE PLAN button).
          if (ev['type'] === 'final' && typeof ev['solution'] === 'string') {
            this._lastSolution = ev['solution'] as string;
            this._post(ev);
            this._post({ type: 'planReady' });
            return;
          }
          this._post(ev);
        });
        this._engine = engine;
        try {
          await engine.run(discussConfig, this._abort.signal);
        } catch (err: unknown) {
          this._post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        } finally {
          this._post({ type: 'done' });
          this._abort = null;
          this._engine = null;
        }
        break;
      }

      case 'userMessage': {
        const text = String(msg['text'] || '').trim();
        if (!text) { break; }
        this._engine?.injectUserMessage(text);
        this._post({ type: 'userMessage', from: 'You', text });
        break;
      }

      case 'executePlan': {
        // Hand the team's agreed plan to the main chat agent to actually do it.
        if (this._lastSolution && this._onExecutePlan) {
          this._onExecutePlan(this._lastTask, this._lastSolution);
          this._post({ type: 'executingPlan' });
        } else {
          this._post({ type: 'error', message: 'No agreed plan to execute yet.' });
        }
        break;
      }

      case 'stopDiscuss':
        this._abort?.abort();
        this._abort = null;
        this._post({ type: 'done' });
        break;
    }
  }

  private async _sendInit(): Promise<void> {
    let cfg: ReturnType<typeof loadQGenieConfig>;
    try {
      cfg = loadQGenieConfig();
    } catch {
      cfg = { apiKey: '', model: AVAILABLE_MODELS[0]?.id || '', maxTokens: 4096 } as ReturnType<typeof loadQGenieConfig>;
    }
    const models = (this._liveModels || AVAILABLE_MODELS).map((m) => ({ id: m.id, label: m.label }));
    this._post({ type: 'init', models, currentModel: cfg.model });

    // Background live-model refresh (best-effort).
    if (!this._liveModels && !this._liveModelsFetching && cfg.apiKey) {
      this._liveModelsFetching = true;
      fetchAvailableModels(cfg)
        .then((live) => {
          this._liveModels = live;
          this._liveModelsFetching = false;
          this._post({
            type: 'init',
            models: live.map((m) => ({ id: m.id, label: m.label })),
            currentModel: cfg.model,
          });
        })
        .catch(() => { this._liveModelsFetching = false; });
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'discuss.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'discuss.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DISCUSS</title>
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-sideBar-background, #1e1e1e);
  }
</style>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="discuss-root">
  <div id="discuss-header">
    <span id="discuss-title">// DISCUSS — MULTI-AGENT DEBATE</span>
  </div>

  <div id="discuss-controls">
    <label class="discuss-field">
      <span class="discuss-label">PROBLEM</span>
      <textarea id="discuss-task" rows="3" placeholder="> describe the problem for the agents to debate..."></textarea>
    </label>

    <div class="discuss-row">
      <label class="discuss-field discuss-field-inline">
        <span class="discuss-label">MODEL</span>
        <select id="discuss-model"></select>
      </label>
      <label class="discuss-field discuss-field-inline discuss-field-rounds">
        <span class="discuss-label">ROUNDS</span>
        <input id="discuss-rounds" type="number" min="1" max="12" value="4">
      </label>
    </div>

    <div class="discuss-field">
      <span class="discuss-label">AGENTS</span>
      <div id="discuss-agents">
        <label class="agent-chk"><input type="checkbox" value="planner" checked> planner</label>
        <label class="agent-chk"><input type="checkbox" value="coder" checked> coder</label>
        <label class="agent-chk"><input type="checkbox" value="reviewer" checked> reviewer</label>
        <label class="agent-chk"><input type="checkbox" value="researcher"> researcher</label>
      </div>
    </div>

    <div class="discuss-row discuss-btn-row">
      <button id="discuss-run-btn" title="Start the debate">[RUN]</button>
      <button id="discuss-stop-btn" title="Stop">[STOP]</button>
      <span id="discuss-status">// idle</span>
    </div>
  </div>

  <div id="discuss-director-log"></div>
  <div id="discuss-lanes"></div>
  <div id="discuss-chat-bar">
    <input id="discuss-chat-input" type="text" placeholder="> direct the agents live… (Enter to send)" />
    <button id="discuss-chat-send">[SEND]</button>
  </div>

  <div id="discuss-final"></div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
