import * as vscode from 'vscode';
import {
  Skill,
  SkillDetails,
  SkillComponents,
  loadSkillDetails,
  parseSkillComponents,
} from './skillManager';
import { esc } from './webviewUtils';

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 20px 24px;
  line-height: 1.6;
  max-width: 860px;
}
h1 { font-size: 1.3em; font-weight: 700; margin-bottom: 4px; }
h2 { font-size: 0.82em; font-weight: 600; text-transform: uppercase;
     letter-spacing: 0.08em; color: var(--vscode-descriptionForeground);
     margin-bottom: 8px; margin-top: 20px; }
h3 { font-size: 1em; font-weight: 600; margin-bottom: 8px; }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-bottom: 20px; }
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 20px 0; }
label { display: block; font-weight: 600; font-size: 0.85em; margin-bottom: 4px; }
.hint { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 5px; font-style: italic; }
input, textarea, select {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 7px 10px;
  font-family: var(--vscode-font-family);
  font-size: 0.9em;
}
input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
textarea { resize: vertical; }
.form-group { margin-bottom: 16px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
button { padding: 6px 18px; border: none; border-radius: 4px; cursor: pointer;
         font-size: 0.9em; font-family: var(--vscode-font-family); }
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn-ghost { background: none; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
.btn-ghost:hover { background: var(--vscode-list-hoverBackground); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; font-weight: 500; margin-right: 4px; }
.badge-user { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge-sys { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.badge-mono { font-family: monospace; }
.error { color: var(--vscode-errorForeground); font-size: 0.82em; margin-top: 3px; display: none; }
.card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
.component-label { font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
                   color: var(--vscode-button-background); margin-bottom: 4px; }
.component-desc { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
`;



export class SkillDetailPanel {
  public static currentPanel: SkillDetailPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static show(
    skill: Skill,
    callbacks: {
      onUse: (skill: Skill, task: string) => void;
      onCustomize: (skill: Skill) => void;
    }
  ): void {
    const col = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SkillDetailPanel.currentPanel) {
      SkillDetailPanel.currentPanel._panel.reveal(col);
      SkillDetailPanel.currentPanel._update(skill, callbacks);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'qgenieSkillDetail', `Skill: ${skill.displayName || skill.name}`,
      col, { enableScripts: true, retainContextWhenHidden: true }
    );
    SkillDetailPanel.currentPanel = new SkillDetailPanel(panel, skill, callbacks);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    skill: Skill,
    callbacks: { onUse: (skill: Skill, task: string) => void; onCustomize: (skill: Skill) => void }
  ) {
    this._panel = panel;
    this._update(skill, callbacks);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private _update(
    skill: Skill,
    callbacks: { onUse: (skill: Skill, task: string) => void; onCustomize: (skill: Skill) => void }
  ): void {
    const details = loadSkillDetails(skill);
    this._panel.title = `Skill: ${details.displayName || details.name}`;
    this._panel.webview.html = this._html(details);
    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'use') { callbacks.onUse(skill, msg.task || ''); }
      else if (msg.command === 'customize') { callbacks.onCustomize(skill); }
      else if (msg.command === 'chat') {
        vscode.commands.executeCommand('qgenieSkills.chatWithSkill', skill);
      }
      else if (msg.command === 'openFile') {
        vscode.workspace.openTextDocument(msg.path).then(d => vscode.window.showTextDocument(d));
      }
    }, null, this._disposables);
  }

  private _html(d: SkillDetails): string {
    const refs = d.references.length
      ? d.references.map(r => `<li><a class="file-link" data-path="${esc(d.skillPath + '/references/' + r)}">${esc(r)}</a></li>`).join('')
      : '<li class="empty">None</li>';
    const scripts = d.scripts.length
      ? d.scripts.map(s => `<li><a class="file-link" data-path="${esc(d.skillPath + '/scripts/' + s)}">${esc(s)}</a></li>`).join('')
      : '<li class="empty">None</li>';
    const preview = esc(d.body.substring(0, 800));

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
${BASE_CSS}
.header { display:flex; gap:14px; align-items:flex-start; padding-bottom:16px; border-bottom:1px solid var(--vscode-panel-border); margin-bottom:20px; }
.icon { font-size:38px; flex-shrink:0; }
.desc-box { background:var(--vscode-textBlockQuote-background); border-left:3px solid var(--vscode-textBlockQuote-border);
            padding:10px 14px; border-radius:0 4px 4px 0; font-size:0.88em; white-space:pre-wrap; word-break:break-word; }
.preview { background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); border-radius:4px;
           padding:12px; font-family:var(--vscode-editor-font-family); font-size:0.82em; white-space:pre-wrap;
           max-height:220px; overflow-y:auto; }
.file-list { list-style:none; display:flex; flex-wrap:wrap; gap:6px; }
.file-list li a.file-link { display:inline-block; padding:3px 10px; background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground); border-radius:4px; text-decoration:none; font-size:0.82em; cursor:pointer; }
.file-list li a.file-link:hover { background:var(--vscode-button-secondaryHoverBackground); }
.file-list li.empty { color:var(--vscode-descriptionForeground); font-size:0.82em; font-style:italic; }
.use-card { background:var(--vscode-sideBar-background); border:1px solid var(--vscode-panel-border); border-radius:6px; padding:16px; margin-top:24px; }
.use-card textarea { min-height:72px; margin-bottom:10px; }
.tip { font-size:0.78em; color:var(--vscode-descriptionForeground); margin-top:8px; font-style:italic; }
</style></head><body>

<div class="header">
  <div class="icon">${d.isSystem ? '⚙️' : '🧠'}</div>
  <div>
    <h1>${esc(d.displayName || d.name)}</h1>
    <span class="badge ${d.isSystem ? 'badge-sys' : 'badge-user'}">${d.isSystem ? 'System' : 'My Skill'}</span>
    <span class="badge badge-user badge-mono">$${esc(d.name)}</span>
    <div style="margin-top:5px;color:var(--vscode-descriptionForeground);font-size:0.88em">${esc(d.shortDescription || '')}</div>
  </div>
</div>

<h2>Trigger Description</h2>
<div class="desc-box">${esc(d.description)}</div>

<h2>Instructions Preview</h2>
<div class="preview">${preview}${d.body.length > 800 ? '\n\n… (open SKILL.md for full content)' : ''}</div>
<div style="margin-top:8px;display:flex;gap:8px">
  <button class="btn-ghost" style="font-size:0.82em" onclick="openFile('${esc(d.skillMdPath)}')">📄 Open SKILL.md</button>
  ${!d.isSystem ? `<button class="btn-ghost" style="font-size:0.82em" onclick="customize()">✏️ Customize Skill</button>` : ''}
</div>

<h2>Reference Files</h2>
<ul class="file-list">${refs}</ul>

<h2>Scripts</h2>
<ul class="file-list">${scripts}</ul>

  <div class="use-card">
  <h3>🚀 Invoke in QGenie Agent</h3>
  <p style="font-size:0.85em;color:var(--vscode-descriptionForeground);margin:8px 0 10px">
    Describe your task. The skill instructions will be sent directly to QGenie agent as a new task.
  </p>
  <textarea id="taskInput" placeholder="e.g. Review the CMD_DB driver port from QTEE to OP-TEE. Reference: /path/qtee  Target: /path/optee  (top 9 commits)"></textarea>
  <div class="btn-row">
    <button class="btn-primary" onclick="invoke()">⚡ Send to QGenie Agent</button>
    <button class="btn-secondary" onclick="copyOnly()">📋 Copy to Clipboard</button>
    <button class="btn-ghost" onclick="openChat()" style="display:flex;align-items:center;gap:5px">💬 Chat with this Skill</button>
  </div>
  <div class="tip">Tip: You can also type <strong>$${esc(d.name)}</strong> directly in QGenie chat to trigger this skill.</div>
</div>

<script>
const vscode = acquireVsCodeApi();
function invoke() {
  const task = document.getElementById('taskInput').value.trim();
  vscode.postMessage({ command: 'use', task, mode: 'invoke' });
}
function copyOnly() {
  const task = document.getElementById('taskInput').value.trim();
  vscode.postMessage({ command: 'use', task, mode: 'copy' });
}
function openChat() { vscode.postMessage({ command: 'chat' }); }
function customize() { vscode.postMessage({ command: 'customize' }); }
function openFile(p) { vscode.postMessage({ command: 'openFile', path: p }); }
document.querySelectorAll('.file-link').forEach(l => {
  l.addEventListener('click', e => { e.preventDefault(); openFile(l.dataset.path); });
});
document.getElementById('taskInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) invoke();
});
</script></body></html>`;
  }

  public dispose(): void {
    SkillDetailPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }
}

export class CreateSkillWizard {
  public static currentPanel: CreateSkillWizard | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static show(
    onCreate: (
      name: string, description: string, displayName: string,
      shortDescription: string, components: SkillComponents
    ) => void
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'qgenieCreateSkill', '🧠 New Skill — Guided Wizard',
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: false }
    );
    CreateSkillWizard.currentPanel = new CreateSkillWizard(panel, onCreate);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    onCreate: (name: string, description: string, displayName: string,
      shortDescription: string, components: SkillComponents) => void
  ) {
    this._panel = panel;
    this._panel.webview.html = this._html();
    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'create') {
        onCreate(msg.name, msg.description, msg.displayName, msg.shortDescription, {
          persona: msg.persona || '',
          methodology: msg.methodology || '',
          outputFormat: msg.outputFormat || '',
          rules: msg.rules || '',
          extraSections: '',
        });
        this._panel.dispose();
      } else if (msg.command === 'cancel') {
        this._panel.dispose();
      }
    }, null, this._disposables);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private _html(): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
${BASE_CSS}
.wizard-steps { display:flex; gap:0; margin-bottom:28px; }
.step { flex:1; text-align:center; padding:8px 4px; font-size:0.78em;
        color:var(--vscode-descriptionForeground); border-bottom:2px solid var(--vscode-panel-border); cursor:pointer; }
.step.active { color:var(--vscode-button-background); border-bottom-color:var(--vscode-button-background); font-weight:600; }
.step.done { color:var(--vscode-charts-green,#4caf50); border-bottom-color:var(--vscode-charts-green,#4caf50); }
.step-num { display:inline-flex; align-items:center; justify-content:center;
            width:22px; height:22px; border-radius:50%; font-size:0.85em; margin-bottom:3px;
            background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
.step.active .step-num { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.step.done .step-num { background:var(--vscode-charts-green,#4caf50); color:#fff; }
.page { display:none; }
.page.active { display:block; }
.component-box { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:14px; margin-bottom:16px; }
.component-box:focus-within { border-color:var(--vscode-focusBorder); }
.nav-row { display:flex; justify-content:space-between; align-items:center; margin-top:24px; }
.preview-box { background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border);
               border-radius:4px; padding:12px; font-family:var(--vscode-editor-font-family);
               font-size:0.8em; white-space:pre-wrap; max-height:300px; overflow-y:auto; }
.required { color:var(--vscode-errorForeground); }
</style></head><body>

<h1>🧠 Create New Skill</h1>
<p class="subtitle">A guided wizard to build a reusable QGenie agent skill — step by step.</p>

<!-- Step indicators -->
<div class="wizard-steps">
  <div class="step active" id="tab-1" onclick="goTo(1)"><div class="step-num">1</div><br>Identity</div>
  <div class="step" id="tab-2" onclick="goTo(2)"><div class="step-num">2</div><br>Trigger</div>
  <div class="step" id="tab-3" onclick="goTo(3)"><div class="step-num">3</div><br>Persona</div>
  <div class="step" id="tab-4" onclick="goTo(4)"><div class="step-num">4</div><br>Methodology</div>
  <div class="step" id="tab-5" onclick="goTo(5)"><div class="step-num">5</div><br>Output</div>
  <div class="step" id="tab-6" onclick="goTo(6)"><div class="step-num">6</div><br>Rules</div>
  <div class="step" id="tab-7" onclick="goTo(7)"><div class="step-num">7</div><br>Review</div>
</div>

<!-- Page 1: Identity -->
<div class="page active" id="page-1">
  <div class="card">
    <div class="component-label">📛 Identity</div>
    <div class="component-desc">How the skill is identified and displayed in the UI.</div>
    <div class="form-group">
      <label>Skill Name <span class="required">*</span></label>
      <div class="hint">Lowercase letters, digits, hyphens only. e.g. <code>driver-port-review</code></div>
      <input id="name" type="text" placeholder="my-skill-name" />
      <div class="error" id="nameErr">Name must be lowercase letters, digits, and hyphens only.</div>
    </div>
    <div class="row2">
      <div class="form-group">
        <label>Display Name</label>
        <div class="hint">Human-readable title shown in the UI</div>
        <input id="displayName" type="text" placeholder="My Skill" />
      </div>
      <div class="form-group">
        <label>Short Description</label>
        <div class="hint">25–64 chars for quick scanning</div>
        <input id="shortDescription" type="text" maxlength="64" placeholder="What this skill does in brief" />
      </div>
    </div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="cancel()">Cancel</button>
    <button class="btn-primary" onclick="next(1)">Next: Trigger →</button>
  </div>
</div>

<!-- Page 2: Trigger -->
<div class="page" id="page-2">
  <div class="card">
    <div class="component-label">🎯 Trigger Description</div>
    <div class="component-desc">
      This is the most important field — it tells the AI <strong>when to automatically invoke this skill</strong>.
      Include: what the skill does, specific trigger phrases, and use-case contexts.
    </div>
    <div class="form-group">
      <label>Trigger Description <span class="required">*</span></label>
      <div class="hint">Be specific. Include trigger phrases like "review driver port", "compare QTEE vs OP-TEE", etc.</div>
      <textarea id="description" style="min-height:140px"
        placeholder="e.g. Senior firmware/security engineer skill for reviewing driver ports between two implementations. Use when asked to compare, review, or validate a driver porting effort. Triggers on: 'review driver port', 'compare QTEE vs OP-TEE', 'validate ported driver'..."></textarea>
      <div class="error" id="descErr">Trigger description is required.</div>
    </div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="goTo(1)">← Back</button>
    <button class="btn-primary" onclick="next(2)">Next: Persona →</button>
  </div>
</div>

<!-- Page 3: Persona -->
<div class="page" id="page-3">
  <div class="card">
    <div class="component-label">🎭 Persona & Role</div>
    <div class="component-desc">
      Define <strong>who the AI acts as</strong> when this skill is active.
      A strong persona gives the AI the right mindset, expertise level, and authority.
    </div>
    <div class="form-group">
      <label>Persona</label>
      <div class="hint">Describe the expert role. e.g. "You are acting as a senior firmware/security engineer with deep upstreaming experience."</div>
      <textarea id="persona" style="min-height:120px"
        placeholder="You are acting as a [role] with [expertise]. Your job is to [primary responsibility]..."></textarea>
    </div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="goTo(2)">← Back</button>
    <button class="btn-primary" onclick="next(3)">Next: Methodology →</button>
  </div>
</div>

<!-- Page 4: Methodology -->
<div class="page" id="page-4">
  <div class="card">
    <div class="component-label">🔬 Methodology</div>
    <div class="component-desc">
      Define the <strong>step-by-step approach</strong> the AI should follow.
      This is the core workflow — what to do, in what order, and how to think about the problem.
    </div>
    <div class="form-group">
      <label>Methodology / Steps</label>
      <div class="hint">Use numbered steps, checklists, or structured phases. Be specific about the process.</div>
      <textarea id="methodology" style="min-height:180px"
        placeholder="1. DECOMPOSE — Break into sub-problems&#10;2. SOLVE — Address each with explicit confidence (0.0–1.0)&#10;3. VERIFY — Check logic, facts, completeness&#10;4. SYNTHESIZE — Combine findings&#10;5. REFLECT — If confidence &lt;0.8, retry&#10;&#10;For each [item], check:&#10;- [criterion 1]&#10;- [criterion 2]"></textarea>
    </div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="goTo(3)">← Back</button>
    <button class="btn-primary" onclick="next(4)">Next: Output Format →</button>
  </div>
</div>

<!-- Page 5: Output Format -->
<div class="page" id="page-5">
  <div class="card">
    <div class="component-label">📊 Output Format</div>
    <div class="component-desc">
      Define <strong>how the AI should structure its response</strong>.
      Clear output format ensures consistent, actionable results every time.
    </div>
    <div class="form-group">
      <label>Output Format</label>
      <div class="hint">Specify tables, sections, confidence levels, verdict format, etc.</div>
      <textarea id="outputFormat" style="min-height:160px"
        placeholder="Structure your response as:&#10;&#10;### 1. Summary Table&#10;| Item | Reference | Target | Match | Notes |&#10;|---|---|---|---|---|&#10;&#10;### 2. Detailed Analysis&#10;[Per-item analysis]&#10;&#10;### Verdict&#10;- CONFIDENCE: X.X&#10;- ISSUES: [list]&#10;- APPROVED: Yes / No / Conditional"></textarea>
    </div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="goTo(4)">← Back</button>
    <button class="btn-primary" onclick="next(5)">Next: Rules →</button>
  </div>
</div>

<!-- Page 6: Rules -->
<div class="page" id="page-6">
  <div class="card">
    <div class="component-label">⚖️ Key Rules & Constraints</div>
    <div class="component-desc">
      Define <strong>non-negotiable rules</strong> the AI must always follow.
      These are the guardrails that ensure quality and correctness.
    </div>
    <div class="form-group">
      <label>Rules & Constraints</label>
      <div class="hint">Use bullet points. Include what to always do, what to never do, and critical flags.</div>
      <textarea id="rules" style="min-height:160px"
        placeholder="- Never assume — always verify with evidence&#10;- Never skip a [item] — every [item] must be accounted for&#10;- Flag CRITICAL for [condition] — these cause [consequence]&#10;- Flag WARNING for [condition]&#10;- The core logic must be 100% identical unless explicitly justified"></textarea>
    </div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="goTo(5)">← Back</button>
    <button class="btn-primary" onclick="next(6)">Review →</button>
  </div>
</div>

<!-- Page 7: Review -->
<div class="page" id="page-7">
  <div class="card">
    <div class="component-label">✅ Review & Create</div>
    <div class="component-desc">Review the assembled skill before creating it.</div>
    <div id="previewBox" class="preview-box" style="margin-top:8px"></div>
  </div>
  <div class="nav-row">
    <button class="btn-secondary" onclick="goTo(6)">← Back</button>
    <button class="btn-primary" onclick="submit()">✅ Create Skill</button>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentPage = 1;

function goTo(n) {
  document.getElementById('page-' + currentPage).classList.remove('active');
  document.getElementById('tab-' + currentPage).classList.remove('active');
  if (currentPage < n) document.getElementById('tab-' + currentPage).classList.add('done');
  currentPage = n;
  document.getElementById('page-' + n).classList.add('active');
  document.getElementById('tab-' + n).classList.add('active');
  if (n === 7) buildPreview();
}

function next(from) {
  if (from === 1) {
    const name = document.getElementById('name').value.trim();
    const err = document.getElementById('nameErr');
    if (!name || !/^[a-z0-9-]+$/.test(name)) { err.style.display='block'; return; }
    err.style.display='none';
    // Auto-fill display name
    const dn = document.getElementById('displayName');
    if (!dn.value) dn.value = name.split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ');
  }
  if (from === 2) {
    const desc = document.getElementById('description').value.trim();
    const err = document.getElementById('descErr');
    if (!desc) { err.style.display='block'; return; }
    err.style.display='none';
  }
  goTo(from + 1);
}

function buildPreview() {
  const name = document.getElementById('displayName').value || document.getElementById('name').value;
  const persona = document.getElementById('persona').value.trim();
  const methodology = document.getElementById('methodology').value.trim();
  const outputFormat = document.getElementById('outputFormat').value.trim();
  const rules = document.getElementById('rules').value.trim();
  let md = '# ' + name + '\\n\\n';
  if (persona) md += '## Persona & Role\\n' + persona + '\\n\\n';
  if (methodology) md += '## Methodology\\n' + methodology + '\\n\\n';
  if (outputFormat) md += '## Output Format\\n' + outputFormat + '\\n\\n';
  if (rules) md += '## Key Rules\\n' + rules;
  document.getElementById('previewBox').textContent = md;
}

function submit() {
  vscode.postMessage({
    command: 'create',
    name: document.getElementById('name').value.trim(),
    displayName: document.getElementById('displayName').value.trim(),
    shortDescription: document.getElementById('shortDescription').value.trim(),
    description: document.getElementById('description').value.trim(),
    persona: document.getElementById('persona').value.trim(),
    methodology: document.getElementById('methodology').value.trim(),
    outputFormat: document.getElementById('outputFormat').value.trim(),
    rules: document.getElementById('rules').value.trim(),
  });
}

function cancel() { vscode.postMessage({ command: 'cancel' }); }
</script></body></html>`;
  }

  public dispose(): void {
    CreateSkillWizard.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }
}

export class CustomizeSkillPanel {
  public static currentPanel: CustomizeSkillPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static show(
    skill: Skill,
    onSave: (
      skill: Skill, description: string, displayName: string,
      shortDescription: string, components: SkillComponents
    ) => void
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'qgenieCustomizeSkill', `✏️ Customize: ${skill.displayName || skill.name}`,
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: false }
    );
    CustomizeSkillPanel.currentPanel = new CustomizeSkillPanel(panel, skill, onSave);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    skill: Skill,
    onSave: (skill: Skill, description: string, displayName: string,
      shortDescription: string, components: SkillComponents) => void
  ) {
    this._panel = panel;
    const details = loadSkillDetails(skill);
    const components = parseSkillComponents(details.body);
    this._panel.webview.html = this._html(details, components);

    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'save') {
        onSave(skill, msg.description, msg.displayName, msg.shortDescription, {
          persona: msg.persona || '',
          methodology: msg.methodology || '',
          outputFormat: msg.outputFormat || '',
          rules: msg.rules || '',
          extraSections: components.extraSections,
        });
        this._panel.dispose();
      } else if (msg.command === 'openRaw') {
        vscode.workspace.openTextDocument(skill.skillMdPath)
          .then(d => vscode.window.showTextDocument(d));
      } else if (msg.command === 'cancel') {
        this._panel.dispose();
      }
    }, null, this._disposables);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private _html(d: SkillDetails, c: SkillComponents): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
${BASE_CSS}
.section-header { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.section-icon { font-size:1.2em; }
</style></head><body>

<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
  <div>
    <h1>✏️ Customize Skill</h1>
    <p class="subtitle">Edit each component of <strong>${esc(d.displayName || d.name)}</strong> (<code>$${esc(d.name)}</code>)</p>
  </div>
  <button class="btn-ghost" style="font-size:0.82em" onclick="openRaw()">📄 Open Raw SKILL.md</button>
</div>

<!-- Identity -->
<div class="card">
  <div class="section-header">
    <span class="section-icon">📛</span>
    <div>
      <div class="component-label">Identity</div>
      <div class="component-desc">How the skill is identified and displayed</div>
    </div>
  </div>
  <div class="row2">
    <div class="form-group">
      <label>Display Name</label>
      <input id="displayName" value="${esc(d.displayName || d.name)}" />
    </div>
    <div class="form-group">
      <label>Short Description</label>
      <input id="shortDescription" maxlength="64" value="${esc(d.shortDescription || '')}" />
    </div>
  </div>
</div>

<!-- Trigger -->
<div class="card">
  <div class="section-header">
    <span class="section-icon">🎯</span>
    <div>
      <div class="component-label">Trigger Description</div>
      <div class="component-desc">When the AI automatically invokes this skill — be specific about trigger phrases</div>
    </div>
  </div>
  <textarea id="description" style="min-height:120px">${esc(d.description)}</textarea>
</div>

<!-- Persona -->
<div class="card">
  <div class="section-header">
    <span class="section-icon">🎭</span>
    <div>
      <div class="component-label">Persona & Role</div>
      <div class="component-desc">Who the AI acts as — expertise, mindset, authority</div>
    </div>
  </div>
  <textarea id="persona" style="min-height:100px">${esc(c.persona)}</textarea>
</div>

<!-- Methodology -->
<div class="card">
  <div class="section-header">
    <span class="section-icon">🔬</span>
    <div>
      <div class="component-label">Methodology</div>
      <div class="component-desc">Step-by-step approach, workflow, process</div>
    </div>
  </div>
  <textarea id="methodology" style="min-height:160px">${esc(c.methodology)}</textarea>
</div>

<!-- Output Format -->
<div class="card">
  <div class="section-header">
    <span class="section-icon">📊</span>
    <div>
      <div class="component-label">Output Format</div>
      <div class="component-desc">How to structure the response — tables, sections, verdict</div>
    </div>
  </div>
  <textarea id="outputFormat" style="min-height:140px">${esc(c.outputFormat)}</textarea>
</div>

<!-- Rules -->
<div class="card">
  <div class="section-header">
    <span class="section-icon">⚖️</span>
    <div>
      <div class="component-label">Key Rules & Constraints</div>
      <div class="component-desc">Non-negotiable guardrails — what to always/never do</div>
    </div>
  </div>
  <textarea id="rules" style="min-height:140px">${esc(c.rules)}</textarea>
</div>

<div class="btn-row">
  <button class="btn-primary" onclick="save()">💾 Save Changes</button>
  <button class="btn-secondary" onclick="cancel()">Cancel</button>
</div>

<script>
const vscode = acquireVsCodeApi();
function save() {
  vscode.postMessage({
    command: 'save',
    displayName: document.getElementById('displayName').value.trim(),
    shortDescription: document.getElementById('shortDescription').value.trim(),
    description: document.getElementById('description').value.trim(),
    persona: document.getElementById('persona').value.trim(),
    methodology: document.getElementById('methodology').value.trim(),
    outputFormat: document.getElementById('outputFormat').value.trim(),
    rules: document.getElementById('rules').value.trim(),
  });
}
function openRaw() { vscode.postMessage({ command: 'openRaw' }); }
function cancel() { vscode.postMessage({ command: 'cancel' }); }
</script></body></html>`;
  }

  public dispose(): void {
    CustomizeSkillPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }
}
