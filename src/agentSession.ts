// AgentSession — one concurrent chat session (one UI tab). Owns its message
// history, abort controller, streaming state, tokens, eventsLog, persistence id.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  loadQGenieConfig,
  streamChatCompletion,
  ChatMessage,
  ChatContentPart,
} from './qgenieApi';
import {
  APPROVAL_REQUIRED_TOOLS,
  buildToolPrompt,
  buildWorkspaceContext,
  executeTool,
  resolveWorkspacePath,
  parseSearchReplaceBlocks,
  applySearchReplaceBlocks,
  XML_TOOL_SCHEMA,
  NO_ECHO_TOOLS,
  coerceToolArgs,
} from './agentTools';
import { loadSkills, loadSystemSkills, loadSkillDetails, Skill } from './skillManager';
import { QGenieDiffProvider } from './diffProvider';
import { XmlToolParser } from './xmlToolParser';
import {
  buildOrchestratorSystemPrompt,
  buildDelegateToolPrompt,
  parseDelegatedTasks,
  runDelegatedTasks,
  SubAgentProgress,
} from './orchestrator';
import {
  ChatHistoryStore,
  ChatHistorySession,
  ChatHistoryEvent,
} from './chatHistory';
import { CodebaseIndexer } from './codebaseIndexer/CodebaseIndexer';

// ORCHESTRATOR mode adds the `delegate_task` tool (see orchestrator.ts).
const ORCHESTRATOR_TOOL_SCHEMA: Record<string, string[]> = {
  ...XML_TOOL_SCHEMA,
  delegate_task: ['tasks'],
};

// ── Performance: cached buildToolPrompt() ─────────────────────
let _cachedToolPrompt: string | undefined;
function getCachedToolPrompt(): string {
  if (!_cachedToolPrompt) { _cachedToolPrompt = buildToolPrompt(); }
  return _cachedToolPrompt;
}

// ── Performance: cached loadQGenieConfig() with 5s TTL ────────
let _configCache: { data: ReturnType<typeof loadQGenieConfig>; ts: number } | undefined;
function getCachedConfig(): ReturnType<typeof loadQGenieConfig> {
  const now = Date.now();
  if (_configCache && (now - _configCache.ts) < 5000) { return _configCache.data; }
  const data = loadQGenieConfig();
  _configCache = { data, ts: now };
  return data;
}

import { ThinkingCarry, splitThinkingChunks, flushSplitter } from './thinkingSplitter';
import { pruneMessages, isTransientStreamError } from './messageUtils';
import { buildDefaultSystemPrompt } from './defaultSystemPrompt';

// Re-export for external consumers
export { isTransientStreamError } from './messageUtils';



/** Implemented by ChatViewProvider; lets a session talk to its webview tab. */
export interface SessionHost {
  postToWebview(sessionId: string, msg: Record<string, unknown>): void;
  /** Request approval for a side-effecting tool. `signal` lets a Stop click
   *  unblock a queued/showing approval (resolves false on abort). */
  requestApproval(
    sessionId: string,
    sessionTitle: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<boolean>;
  diffProvider: QGenieDiffProvider;
  historyStore: ChatHistoryStore;
}

export class AgentSession {
  public readonly id: string;
  public title: string;
  /** Persistent history-store id (null until first save); distinct from
   *  runtime tab `id` though usually equal. */
  public persistedId: string | null = null;
  public persistedCreatedAt = 0;

  public messages: ChatMessage[] = [];
  public eventsLog: ChatHistoryEvent[] = [];
  public attachments: Array<{ label: string; content: string }> = [];
  public currentSkill: Skill | undefined;
  public currentModel: string;
  public totalPromptTokens = 0;
  public totalCompletionTokens = 0;

  /** True while runAgentLoop is in flight (drives per-tab "running" indicator). */
  public running = false;

  private _host: SessionHost;
  private _abortController: AbortController | undefined;

  private _historySaveTimer: ReturnType<typeof setTimeout> | undefined;

  private _streamingWrite = {
    active: false, filePath: '', target: '', paintedLength: 0,
    streamDone: false, pushScheduled: false,
  };
  private _streamingEdit = {
    active: false, filePath: '', originalContent: '',
    workingContent: '', diffBuffer: '', blocksApplied: 0, pushScheduled: false,
    searchCursor: 0,
  };

  /** Multi-agent orchestrator mode: enables `delegate_task` + orchestrator prompt. */
  public readonly orchestrator: boolean;

  private _subAgentCounter = 0;

  /** Per-turn collector of files mutated by tools during one runAgentLoop.
   *  Keyed by absolute filePath; later action wins, except created+modified
   *  on the same file stays 'created'. */
  private _filesChangedThisTurn = new Map<string, 'created' | 'modified' | 'deleted' | 'renamed'>();

  /** Has the model called search_codebase at least once this session? Drives
   *  the runtime nudge that reminds the model to consult the index BEFORE
   *  exploratory read_file / read_file_range calls. Reset only when the
   *  session messages are reset. */
  private _hasUsedSearchCodebase = false;

  /** Absolute paths of files this session has written/edited. Reading one of
   *  these back is NOT exploratory — the model already knows the layout — so
   *  the search-first nudge is suppressed for these paths. */
  private _filesTouchedThisSession = new Set<string>();

  /** Record a successful file mutation for the 'files changed this turn' summary. */
  private _recordFileChange(filePath: string, action: 'created' | 'modified' | 'deleted' | 'renamed'): void {
    if (!filePath) { return; }
    const prev = this._filesChangedThisTurn.get(filePath);
    // created + later modified on the same file stays 'created'.
    if (prev === 'created' && action === 'modified') { return; }

    this._filesChangedThisTurn.set(filePath, action);
  }

  /** Emit the 'filesChanged' summary if any files were mutated this turn. */
  private _emitFilesChanged(): void {
    if (this._filesChangedThisTurn.size === 0) { return; }
    const files = Array.from(this._filesChangedThisTurn.entries()).map(([filePath, action]) => ({
      path: filePath,
      baseName: path.basename(filePath),
      action,
    }));
    this._post({ type: 'filesChanged', files });
    this._filesChangedThisTurn.clear();
  }

  constructor(id: string, title: string, host: SessionHost, initialModel: string, orchestrator = false) {

    this.id = id;
    this.title = title;
    this._host = host;
    this.currentModel = initialModel;
    this.orchestrator = orchestrator;
    this.resetMessages();
  }

  public setModel(model: string): void {
    this.currentModel = model;
    this._post({ type: 'modelChanged', model });
  }

  public setSkill(skillName: string): void {
    if (!skillName) {
      this.currentSkill = undefined;
      this.resetMessages();
      this._post({ type: 'skillChanged', skill: '' });
      return;
    }
    const skill = [...loadSkills(), ...loadSystemSkills()].find(s => s.name === skillName);
    if (skill) { this.loadSkillContext(skill); }
  }

  public loadSkillContext(skill: Skill): void {
    this.currentSkill = skill;
    this.resetMessages();
    this._post({ type: 'skillChanged', skill: skill.name });
    this._post({
      type: 'systemMessage',
      text: `Skill loaded: ${skill.displayName || skill.name}`,
      isError: false,
    });
  }

  public stopGeneration(): void {
    if (this._abortController) {
      // Don't clear `_abortController` here — runAgentLoop's finally owns
      // that; clearing mid-flight made a 2nd Stop a no-op and dropped the signal.
      this._abortController.abort();
      this._post({
        type: 'systemMessage',
        text: 'Stop requested — cancelling current generation and any in-flight tool calls.',
        isError: false,
      });
    }
  }

  public resetMessages(): void {
    const wsCtx = buildWorkspaceContext();
    const toolsPrompt = getCachedToolPrompt();
    if (this.orchestrator) {
      this.messages = [{
        role: 'system',
        content:
          buildOrchestratorSystemPrompt(wsCtx) + toolsPrompt + buildDelegateToolPrompt(),
      }];
    } else if (this.currentSkill) {
      const details = loadSkillDetails(this.currentSkill);
      this.messages = [{
        role: 'system',
        content:
          `You are a highly capable coding agent. You are operating with the following skill context:\n\n${details.body}\n\nApply this skill's methodology and persona when answering. Use tools proactively to gather information before answering.${wsCtx}${toolsPrompt}`,
      }];
    } else {
      this.messages = [{
        role: 'system',
        content: buildDefaultSystemPrompt(wsCtx, toolsPrompt),
      }];
    }
    for (const att of this.attachments) {
      this.messages.push({ role: 'user', content: `[Context attached: ${att.label}]\n\n${att.content}` });
      this.messages.push({ role: 'assistant', content: `I've received the context from ${att.label}. I'll use this when answering your questions.` });
    }
  }

  /** Hydrate this (just-constructed) session from a persisted history record. */
  public restoreFromHistory(sess: ChatHistorySession): void {
    this.persistedId = sess.id;
    this.persistedCreatedAt = sess.createdAt;
    // Drop legacy role:'tool' messages — chat API rejects them; tool results
    // are now injected as role:'user' "[tool X result]" messages instead.
    this.messages = sess.messages.filter(m => m.role !== 'tool');
    this.eventsLog = sess.events || [];
    this.attachments = sess.attachments || [];
    this.totalPromptTokens = sess.promptTokens || 0;
    this.totalCompletionTokens = sess.completionTokens || 0;
    this.currentModel = sess.model || this.currentModel;
    this.title = sess.title || this.title;
    if (sess.skillName && sess.skillName !== '__orchestrator__') {
      const allSkills = [...loadSkills(), ...loadSystemSkills()];
      this.currentSkill = allSkills.find(s => s.name === sess.skillName);
    } else {
      this.currentSkill = undefined;
    }
  }

  /** Snapshot the session into a ChatHistorySession (for persistence). */
  public snapshotForHistory(): ChatHistorySession | null {
    const hasUser = this.messages.some(m => m.role === 'user');
    if (!hasUser) { return null; }

    if (!this.persistedId) {
      this.persistedId = this._host.historyStore.newId();
      this.persistedCreatedAt = Date.now();
    }

    let title = this.title || 'Untitled chat';
    for (const m of this.messages) {
      if (m.role !== 'user') { continue; }
      if (typeof m.content === 'string') {
        title = ChatHistoryStore.deriveTitle(m.content);
        break;
      }
      if (Array.isArray(m.content)) {
        const textPart = m.content.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined;
        if (textPart && textPart.text.trim()) {
          title = ChatHistoryStore.deriveTitle(textPart.text);
        } else {
          title = '[image]';
        }
        break;
      }
    }
    this.title = title;

    return {
      id: this.persistedId,
      title,
      createdAt: this.persistedCreatedAt || Date.now(),
      updatedAt: Date.now(),
      model: this.currentModel,
      // Persist orchestrator mode as a sentinel skill name for round-trip restore.
      skillName: this.orchestrator ? '__orchestrator__' : this.currentSkill?.name,
      messages: this.messages,
      events: this.eventsLog,
      attachments: this.attachments,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
    };
  }

  public saveToHistory(): void {
    const snap = this.snapshotForHistory();
    if (!snap) { return; }
    this._host.historyStore.save(snap);
  }

  private _debouncedSaveToHistory(): void {
    if (this._historySaveTimer) { return; }
    this._historySaveTimer = setTimeout(() => {
      this._historySaveTimer = undefined;
      this.saveToHistory();
    }, 2000);
  }

  public async attachActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._post({ type: 'systemMessage', text: 'No active editor to attach.', isError: true });
      return;
    }
    const filePath = editor.document.uri.fsPath;
    const content = editor.document.getText();
    const label = path.basename(filePath);
    this.attachments.push({ label: filePath, content });
    this.messages.push({ role: 'user', content: `[File attached: ${filePath}]\n\`\`\`${editor.document.languageId}\n${content}\n\`\`\`` });
    this.messages.push({ role: 'assistant', content: `I've received the file \`${label}\` (${editor.document.lineCount} lines). I'll use this context when answering.` });
    this._post({ type: 'contextAttached', label, preview: content.substring(0, 500) });
    this.eventsLog.push({ kind: 'attach', label, preview: content.substring(0, 500) });
  }


  public async runAgentLoop(userText: string, images: string[] = []): Promise<void> {
    if (this.running) {
      this._post({ type: 'systemMessage', text: 'Session is already running. Stop the current generation first.', isError: true });
      return;
    }

    const config = getCachedConfig();
    config.model = this.currentModel;

    if (!config.apiKey) {
      this._post({ type: 'error', message: 'No API key configured. Set QGENIE_API_KEY or configure ~/.config/qgenie-cli/config.toml' });
      return;
    }

    if (this.messages.length === 0) { this.resetMessages(); }

    if (images.length > 0) {
      const parts: ChatContentPart[] = [];
      parts.push({ type: 'text', text: userText || '' });
      for (const dataUrl of images) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } });
      }
      this.messages.push({ role: 'user', content: parts });
    } else {
      this.messages.push({ role: 'user', content: userText });
    }
    this.eventsLog.push({ kind: 'user', text: userText, images: images.length > 0 ? images : undefined });

    this.running = true;
    this._filesChangedThisTurn.clear();
    this._post({ type: 'sessionRunning', running: true });
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const MAX_ITERATIONS = 50;
    const MAX_TRANSIENT_RETRIES = 3;
    // Anti-stall budget: a tool-less, empty/cut-off round gets a nudge
    // instead of silently terminating the loop. See stalled-turn block below.
    const MAX_CONSECUTIVE_NUDGES = 2;
    let iteration = 0;
    let transientRetries = 0;
    let consecutiveNudges = 0;

    try {
      while (iteration < MAX_ITERATIONS) {
        iteration++;
        if (signal.aborted) { break; }

        this._post({ type: 'assistantStart' });
        const result = await this._streamOneRound(config, signal);

        if (result.error) {
          // Retry transient (network/timeout/5xx) but not auth/400/aborts.
          const retryable = !signal.aborted && isTransientStreamError(result.error)
            && transientRetries < MAX_TRANSIENT_RETRIES;
          if (retryable) {
            transientRetries++;
            const backoffMs = 500 * Math.pow(2, transientRetries - 1); // 0.5s, 1s, 2s
            this._post({
              type: 'systemMessage',
              text: `Transient error (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES}), retrying in ${Math.round(backoffMs / 100) / 10}s: ${result.error}`,
              isError: false,
            });
            this._post({ type: 'assistantDone' });
            await new Promise<void>((r) => setTimeout(r, backoffMs));
            iteration--; // this round didn't count — retry the same turn
            continue;
          }
          this._post({ type: 'error', message: result.error });
          break;
        }
        transientRetries = 0;

        this._post({ type: 'assistantDone' });

        if (result.textContent) {
          this.messages.push({ role: 'assistant', content: result.textContent });
        }
        // Store only the clean prose (no thinking tags, no tool XML) in
        // eventsLog so that history restore renders correctly.
        if (result.proseContent) {
          this.eventsLog.push({ kind: 'assistant', text: result.proseContent });
        }
        if (result.thinkingContent) {
          this.eventsLog.push({ kind: 'thinking', text: result.thinkingContent });
        }

        this._debouncedSaveToHistory();

        if (!result.tool) {
          // Distinguish a real "done" turn from a stalled one (no prose,
          // announced-but-not-emitted action, or trailing-ellipsis cutoff).
          const prose = (result.proseContent || '').trim();
          const announcedNoAction = /(?:^|[\s>"'`])(?:let me|let's|now (?:i|let)|i'?ll|i will|next[,:]?|then i|going to|i need to|i should|first[,:]?)\b[^.!?]*$/i.test(prose);
          const trailingCutoff = /[:…]$/.test(prose) || /\.\.\.$/.test(prose);
          const stalled = prose.length === 0 || announcedNoAction || trailingCutoff;

          if (stalled && consecutiveNudges < MAX_CONSECUTIVE_NUDGES) {
            consecutiveNudges++;
            const reason = prose.length === 0
              ? 'your last turn produced no prose and no tool call'
              : announcedNoAction
                ? 'your last turn announced an action ("let me…" / "next…" / "I will…") but did not emit the tool tag'
                : 'your last turn ended with trailing punctuation (":" / "…" / "...") suggesting it was cut off mid-thought';
            const nudge =
              `[SYSTEM] Stalled-turn detector: ${reason}. ` +
              `Either (a) emit the SINGLE next tool call NOW — one tool tag, nothing before it — ` +
              `or (b) write the actual final answer to the user as plain prose. ` +
              `Do not narrate intent without acting. (Nudge ${consecutiveNudges}/${MAX_CONSECUTIVE_NUDGES}.)`;
            this.messages.push({ role: 'user', content: nudge });
            this._post({
              type: 'systemMessage',
              text: `Agent stalled — nudging (${consecutiveNudges}/${MAX_CONSECUTIVE_NUDGES}).`,
              isError: false,
            });
            continue;
          }

          if (stalled) {
            this._post({
              type: 'systemMessage',
              text: `Agent still stalled after ${MAX_CONSECUTIVE_NUDGES} nudges — stopping. Send a new message to resume.`,
              isError: true,
            });
          }
          break;
        }

        consecutiveNudges = 0;

        const toolMsg = await this._executeXmlToolAndGetMessage(result.tool.name, result.tool.params, signal);
        if (signal.aborted) { break; }
        this.messages.push(toolMsg);
      }

      if (iteration >= MAX_ITERATIONS) {
        this._post({ type: 'systemMessage', text: 'Max iterations reached. Agent stopped.', isError: true });
      }
      // Normal completion path: emit the per-turn 'files changed' summary.
      this._emitFilesChanged();
    } finally {
      this._abortController = undefined;
      this.running = false;
      this._post({ type: 'sessionRunning', running: false });
      if (this._historySaveTimer) { clearTimeout(this._historySaveTimer); this._historySaveTimer = undefined; }
      // Also fire on abort / early exit (no-op if already emitted above).
      this._emitFilesChanged();
      this.saveToHistory();
    }
  }

  private _findAfterEditorForStreamingWrite(): vscode.TextEditor | undefined {
    const sw = this._streamingWrite;
    if (!sw.filePath) { return undefined; }
    const wantedKey = `after:${sw.filePath}`;
    return vscode.window.visibleTextEditors.find((ed) => {
      const uri = ed.document.uri;
      if (uri.scheme !== QGenieDiffProvider.scheme) { return false; }
      try { return decodeURIComponent(uri.path) === wantedKey; }
      catch { return uri.path === wantedKey; }
    });
  }

  private _focusOnTypewriterCursor(revealedText: string): void {
    const editor = this._findAfterEditorForStreamingWrite();
    if (!editor) { return; }
    const lines = revealedText.split('\n');
    const lineIdx = Math.max(0, lines.length - 1);
    const colIdx = lines[lineIdx].length;
    const lineStart = new vscode.Position(lineIdx, 0);
    const lineEnd = new vscode.Position(lineIdx, colIdx);
    try {
      editor.selection = new vscode.Selection(lineStart, lineEnd);
      editor.revealRange(new vscode.Range(lineStart, lineEnd), vscode.TextEditorRevealType.InCenter);
    } catch { /* ignore */ }
  }

  private _pushStreamingContent(content: string): void {
    const sw = this._streamingWrite;
    if (!sw.active) { return; }
    if (content.length <= sw.target.length) { return; }
    sw.target = content;
    if (sw.pushScheduled) { return; }
    sw.pushScheduled = true;
    setImmediate(() => {
      const cur = this._streamingWrite;
      cur.pushScheduled = false;
      if (!cur.active) { return; }
      if (cur.paintedLength === cur.target.length) { return; }
      cur.paintedLength = cur.target.length;
      this._host.diffProvider.setAfterContent(cur.filePath, cur.target);
      this._focusOnTypewriterCursor(cur.target);
    });
  }

  private _finishStreamingWrite(): void {
    const sw = this._streamingWrite;
    if (!sw.active) { return; }
    sw.active = false;
    if (sw.target.length > 0 && sw.paintedLength !== sw.target.length) {
      sw.paintedLength = sw.target.length;
      this._host.diffProvider.setAfterContent(sw.filePath, sw.target);
      this._focusOnTypewriterCursor(sw.target);
    }
  }

  private _tryApplyStreamingEditBlocks(): void {
    const se = this._streamingEdit;
    if (!se.active) { return; }
    let blocks;
    try { blocks = parseSearchReplaceBlocks(se.diffBuffer); }
    catch { return; }
    if (blocks.length <= se.blocksApplied) { return; }
    const newBlocks = blocks.slice(se.blocksApplied);
    let next = se.workingContent;
    let appliedNow = 0;
    // Sequential cursor mirrors applySearchReplaceBlocks(): match at or after
    // the previous insertion so identical SEARCH text across blocks maps onto
    // successive occurrences in document order (no ambiguity break).
    let cursor = se.searchCursor;
    for (const b of newBlocks) {
      if (b.search.length === 0) { break; }
      let idx = next.indexOf(b.search, cursor);
      if (idx === -1 && cursor > 0) { idx = next.indexOf(b.search); }
      if (idx === -1) { break; }
      next = next.slice(0, idx) + b.replace + next.slice(idx + b.search.length);
      cursor = idx + b.replace.length;
      appliedNow++;
    }
    if (appliedNow === 0) { return; }
    se.workingContent = next;
    se.blocksApplied += appliedNow;
    se.searchCursor = cursor;
    if (se.pushScheduled) { return; }
    se.pushScheduled = true;
    setImmediate(() => {
      const cur = this._streamingEdit;
      cur.pushScheduled = false;
      if (!cur.active) { return; }
      this._host.diffProvider.setAfterContent(cur.filePath, cur.workingContent);
    });
  }

  private _finishStreamingEdit(): void {
    const se = this._streamingEdit;
    if (!se.active) { return; }
    try {
      const all = parseSearchReplaceBlocks(se.diffBuffer);
      if (all.length > se.blocksApplied) {
        const remaining = all.slice(se.blocksApplied);
        const r = applySearchReplaceBlocks(se.workingContent, remaining);
        se.workingContent = r.result;
        se.blocksApplied = all.length;
      }
    } catch { /* ignore */ }
    this._host.diffProvider.setAfterContent(se.filePath, se.workingContent);
    se.active = false;
  }

  private _streamOneRound(
    config: ReturnType<typeof loadQGenieConfig>,
    signal: AbortSignal,
  ): Promise<{ textContent: string; thinkingContent: string; proseContent: string; tool?: { name: string; params: Record<string, string> }; error?: string }> {
    return new Promise((resolve) => {
      let textContent = '';
      let thinkingContent = '';
      // Prose actually surfaced to UI (no thinking blocks, no tool-tag
      // bodies). This is what the stalled-turn detector in runAgentLoop reads.
      let proseContent = '';
      let error: string | undefined;
      let invokedTool: { name: string; params: Record<string, string> } | undefined;
      // Single-shot guard: streamChatCompletion can fire done:true more than
      // once (natural-end then late abort); resolve+cleanup must run once.
      let resolved = false;

      this._streamingWrite = {
        active: false, filePath: '', target: '', paintedLength: 0,
        streamDone: false, pushScheduled: false,
      };
      this._streamingEdit = {
        active: false, filePath: '', originalContent: '',
        workingContent: '', diffBuffer: '', blocksApplied: 0, pushScheduled: false,
        searchCursor: 0,
      };

      const thinkingCarry: ThinkingCarry = { buf: '', inThinking: false, expectedClose: '' };

      const parser = new XmlToolParser(this.orchestrator ? ORCHESTRATOR_TOOL_SCHEMA : XML_TOOL_SCHEMA, {
        onSpeech: (text) => {
          proseContent += text;
          this._post({ type: 'assistantDelta', delta: text });
        },
        onToolStart: (toolName) => {
          if (toolName === 'write_file' || toolName === 'replace_in_file' || toolName === 'insert_in_file' || toolName === 'delete_file' || toolName === 'move_file') {
            this._post({ type: 'writingStart', toolName });
          }
        },
        onParamEnd: (tool, param, fullValue) => {
          if ((tool === 'write_file' || tool === 'replace_in_file' || tool === 'insert_in_file' || tool === 'delete_file') && param === 'path') {
            const resolvedPath = resolveWorkspacePath(fullValue.trim());
            const baseName = path.basename(resolvedPath);
            this._post({ type: 'writingPath', toolName: tool, filePath: resolvedPath, baseName });
          }
          if (tool === 'move_file' && param === 'source') {
            const resolvedPath = resolveWorkspacePath(fullValue.trim());
            const baseName = path.basename(resolvedPath);
            this._post({ type: 'writingPath', toolName: tool, filePath: resolvedPath, baseName });
          }
          if (tool === 'write_file' && param === 'path') {
            const resolvedPath = resolveWorkspacePath(fullValue.trim());
            this._streamingWrite.active = true;
            this._streamingWrite.filePath = resolvedPath;
            this._streamingWrite.target = '';
            this._streamingWrite.streamDone = false;
            const oldContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : '';
            const baseName = path.basename(resolvedPath);
            const beforeUri = this._host.diffProvider.setBeforeContent(resolvedPath, oldContent);
            const afterUri = this._host.diffProvider.setAfterContent(resolvedPath, '');
            vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `[LIVE] ${baseName}`, { preview: false }).then(undefined, () => {});
          }
          if (tool === 'replace_in_file' && param === 'path') {
            const resolvedPath = resolveWorkspacePath(fullValue.trim());
            const oldContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : '';
            const baseName = path.basename(resolvedPath);
            this._streamingEdit.active = true;
            this._streamingEdit.filePath = resolvedPath;
            this._streamingEdit.originalContent = oldContent;
            this._streamingEdit.workingContent = oldContent;
            this._streamingEdit.diffBuffer = '';
            this._streamingEdit.blocksApplied = 0;
            this._streamingEdit.searchCursor = 0;
            const beforeUri = this._host.diffProvider.setBeforeContent(resolvedPath, oldContent);
            const afterUri = this._host.diffProvider.setAfterContent(resolvedPath, oldContent);
            vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `[LIVE EDIT] ${baseName}`, { preview: false }).then(undefined, () => {});
          }
        },
        onParamChunk: (tool, param, chunk) => {
          if (tool === 'write_file' && param === 'content' && this._streamingWrite.active && chunk) {
            const next = this._streamingWrite.target + chunk;
            this._pushStreamingContent(next);
          }
          if (tool === 'replace_in_file' && param === 'diff' && this._streamingEdit.active && chunk) {
            this._streamingEdit.diffBuffer += chunk;
            this._tryApplyStreamingEditBlocks();
          }
        },
        onToolEnd: (toolName, params) => {
          invokedTool = { name: toolName, params };
          if (toolName === 'write_file' || toolName === 'replace_in_file' || toolName === 'insert_in_file' || toolName === 'delete_file' || toolName === 'move_file') {
            this._post({ type: 'writingEnd', toolName });
          }
        },
      });

      streamChatCompletion(
        pruneMessages(this.messages),
        config,
        (chunk) => {
          if (chunk.error) { error = chunk.error; }
          if (chunk.done) {
            flushSplitter(
              thinkingCarry,
              (outside) => { if (outside) { parser.feed(outside); } },
              (thinking) => {
                thinkingContent += thinking;
                this._post({ type: 'thinkingDelta', delta: thinking });
              },
              () => { this._post({ type: 'thinkingEnd' }); },
            );
            parser.end();
            this._streamingWrite.streamDone = true;
            const swPath = this._streamingWrite.filePath;
            const seActive = this._streamingEdit.active;
            const sePath = this._streamingEdit.filePath;
            this._finishStreamingWrite();
            this._finishStreamingEdit();
            // Always dismiss the writing indicator on stream end — covers
            // cases where onToolEnd never fires (error, abort, malformed XML).
            this._post({ type: 'writingEnd', toolName: '' });
            // Close dangling [LIVE]/[LIVE EDIT] tabs on error/abort so the user
            // isn't left staring at a half-written file.
            if (error || signal.aborted) {
              if (swPath) { void this._closeLiveDiffTabs(swPath).catch(() => {}); }
              if (seActive && sePath && sePath !== swPath) {
                void this._closeLiveDiffTabs(sePath).catch(() => {});
              }
            }
            if (resolved) { return; }
            resolved = true;
            resolve({ textContent, thinkingContent, proseContent, tool: invokedTool, error });
            return;
          }
          if (chunk.delta) {
            textContent += chunk.delta;
            splitThinkingChunks(
              thinkingCarry,
              chunk.delta,
              (outside) => { if (outside) { parser.feed(outside); } },
              (thinking) => {
                thinkingContent += thinking;
                this._post({ type: 'thinkingDelta', delta: thinking });
              },
              () => { this._post({ type: 'thinkingStart' }); },
              () => { this._post({ type: 'thinkingEnd' }); },
            );
          }
          if (chunk.usage) {
            this.totalPromptTokens += chunk.usage.promptTokens;
            this.totalCompletionTokens += chunk.usage.completionTokens;
            this._post({
              type: 'tokenUsage',
              promptTokens: this.totalPromptTokens,
              completionTokens: this.totalCompletionTokens,
            });
          }
        },
        signal,
      );
    });
  }

  /** Post a toolUse event, append to eventsLog, return the [tool X result] message. */
  private _recordToolResult(
    toolName: string,
    inputDisplay: string,
    output: string,
    isError: boolean,
    diffData?: unknown,
    appendToContent = '',
  ): ChatMessage {
    this._post({ type: 'toolUse', toolName, toolInput: inputDisplay, toolResult: output, isError, diffData });
    this.eventsLog.push({ kind: 'tool', toolName, toolInput: inputDisplay, toolResult: output, isError });
    return { role: 'user', content: `[tool ${toolName} result]\n${output}${appendToContent}` };
  }

  private async _executeXmlToolAndGetMessage(
    toolName: string,
    rawParams: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    // Orchestrator-only: delegate_task bypasses executeTool to fan out sub-agents.
    if (toolName === 'delegate_task' && this.orchestrator) {
      return this._runDelegateTask(rawParams, signal);
    }

    const args = coerceToolArgs(toolName, rawParams);

    const inputDisplay = Object.entries(args)
      .map(([k, v]) => `${k}: ${typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : JSON.stringify(v)}`)
      .join('\n');

    if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
      // Signal lets a Stop click auto-deny a pending approval.
      const approved = await this._host.requestApproval(this.id, this.title, toolName, args, signal);
      if (!approved || signal.aborted) {
        return this._recordToolResult(toolName, inputDisplay, 'User denied this operation.', true);
      }
    }

    const result = await executeTool(toolName, args, signal) as { success: boolean; output: string; diffData?: { filePath: string; isNewFile: boolean; oldContent: string; newContent: string } };

    if ((toolName === 'write_file' || toolName === 'replace_in_file') && result.success && result.diffData) {
      void this._closeLiveDiffAndOpenFile(result.diffData.filePath).catch(() => { /* non-fatal */ });
    }

    // Track search_codebase usage so we can detect "exploratory read without
    // search-first" violations on subsequent read_file / read_file_range calls.
    if (toolName === 'search_codebase' && result.success) {
      this._hasUsedSearchCodebase = true;
    }

    // Per-turn 'files changed' collector — record successful file mutations.
    if (result.success &&
        (toolName === 'write_file' || toolName === 'replace_in_file' ||
         toolName === 'insert_in_file' || toolName === 'delete_file' || toolName === 'move_file')) {
      const pathArg = (args as Record<string, unknown>)['path'];
      const changedPath = result.diffData?.filePath
        ?? (typeof pathArg === 'string' ? resolveWorkspacePath(pathArg.trim()) : '');
      let action: 'created' | 'modified' | 'deleted' | 'renamed';
      if (toolName === 'delete_file') {
        action = 'deleted';
      } else if (toolName === 'move_file') {
        action = 'renamed';
      } else if (toolName === 'write_file' && result.diffData?.isNewFile) {
        action = 'created';
      } else {
        action = 'modified';
      }
      this._recordFileChange(changedPath, action);
      if (changedPath) { this._filesTouchedThisSession.add(changedPath); }
    }

    // No-echo reminder for large-body tools — appended just before the
    // next turn so the model is less likely to quote the output back.
    const noEchoReminder = NO_ECHO_TOOLS.has(toolName)
      ? '\n\n[SYSTEM REMINDER: The above output is already visible to the user in the UI tool block. Do NOT echo, quote, summarize, or repeat any of this content in your next message. Go directly to the next tool call or your final answer — no preamble, no "I can see that...", no "The file contains..."]'
      : '';

    // Workflow nudge — when the model reads a file exploratorily WITHOUT
    // having checked the codebase index first, append a reminder. Suppressed
    // when (a) no index exists, (b) the model has used search_codebase at
    // least once this session, or (c) the file was just written/edited by
    // this same session (re-reading own work is not exploratory).
    let workflowReminder = '';
    if ((toolName === 'read_file' || toolName === 'read_file_range') && result.success) {
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const pathArg = (args as Record<string, unknown>)['path'];
        const readPath = typeof pathArg === 'string' ? resolveWorkspacePath(pathArg.trim()) : '';
        const isOwnWork = readPath && this._filesTouchedThisSession.has(readPath);
        if (root && !this._hasUsedSearchCodebase && !isOwnWork) {
          const indexer = new CodebaseIndexer(root);
          if (indexer.hasIndex()) {
            workflowReminder = '\n\n[WORKFLOW REMINDER: A codebase index exists for this workspace. For exploratory reads, you MUST call search_codebase FIRST to locate relevant code at 10–100x lower token cost — direct file reads should follow search results, not precede them. Skip this only when re-reading a file you have already edited yourself this session.]';
          }
        }
      } catch { /* non-fatal — never block a tool result on the nudge check */ }
    }

    return this._recordToolResult(toolName, inputDisplay, result.output, !result.success, result.diffData, noEchoReminder + workflowReminder);
  }

  /** Run a delegate_task call: parse specs, fan out to sub-agents, stream their
   *  progress as subAgent* events, return aggregated reports as the tool result. */
  private async _runDelegateTask(
    rawParams: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    const rawTasks = rawParams['tasks'] !== undefined ? rawParams['tasks'] : '';
    const { specs, error } = parseDelegatedTasks(rawTasks);

    const inputDisplay = specs.length > 0
      ? specs.map((s, i) => `#${i + 1} [${s.title}] ${s.task.slice(0, 120)}`).join('\n')
      : rawTasks.slice(0, 300);

    if (specs.length === 0) {
      const output = `delegate_task error: ${error || 'no valid tasks parsed'}. The <tasks> body must be a JSON array of {title, task} objects.`;
      return this._recordToolResult('delegate_task', inputDisplay, output, true);
    }

    const agentList = specs.map((s, i) => ({
      id: `${this.id}-sub${this._subAgentCounter + i + 1}`,
      title: s.title,
      task: s.task,
    }));

    this._post({ type: 'orchestrateStart', agents: agentList });

    // Accumulate per-agent activity so the orchestration is persisted to the
    // history event log and can be replayed as the same panels (rather than
    // losing the breakdown and dumping a raw aggregated text blob on restore).
    const agentRecs = agentList.map((a) => ({
      id: a.id,
      title: a.title,
      task: a.task,
      finalText: '',
      ok: false,
      tools: [] as Array<{ toolName: string; toolInput: string; toolResult: string; isError: boolean }>,
    }));
    const recById = new Map(agentRecs.map((r) => [r.id, r]));

    const config = loadQGenieConfig();
    config.model = this.currentModel;

    const progress: SubAgentProgress = {
      onStart: (agentId, title, task) => {
        this._post({ type: 'subAgentStart', agentId, title, task });
      },
      onDelta: (agentId, delta) => {
        this._post({ type: 'subAgentDelta', agentId, delta });
      },
      onTool: (agentId, tName, input, output, isError) => {
        recById.get(agentId)?.tools.push({ toolName: tName, toolInput: input, toolResult: output, isError });
        this._post({ type: 'subAgentTool', agentId, toolName: tName, toolInput: input, toolResult: output, isError });
      },
      onDone: (agentId, finalText, ok) => {
        const rec = recById.get(agentId);
        if (rec) { rec.finalText = finalText; rec.ok = ok; }
        this._post({ type: 'subAgentDone', agentId, finalText, ok });
      },
    };

    // Atomic reservation: capture the current base and bump by the batch
    // size in a single expression so a future concurrent delegate cannot
    // read the same base value twice.
    const baseCounter = (this._subAgentCounter += specs.length) - specs.length;

    const aggregated = await runDelegatedTasks({
      specs,
      defaultModel: this.currentModel,
      config,
      signal,
      progress,
      onApproval: (_agentId, title, toolName, args) =>
        // Reuse the outer signal so Stop unblocks every sub-agent's pending approval.
        this._host.requestApproval(this.id, `${this.title} ▸ ${title}`, toolName, args, signal),
      makeId: (index) => `${this.id}-sub${baseCounter + index + 1}`,
    });

    this._post({ type: 'orchestrateDone' });
    // Persist the structured orchestration (replays as panels). We deliberately
    // do NOT call _recordToolResult here: that would post a redundant raw
    // 'toolUse' block (the awkward un-styled aggregated dump) and double-record
    // the turn. The model still receives the aggregated reports via the returned
    // message content below.
    this.eventsLog.push({ kind: 'orchestrate', agents: agentRecs });
    return { role: 'user', content: `[tool delegate_task result]\n${aggregated}` };
  }

  /** Close any QGenie [LIVE]/[LIVE EDIT] diff tabs for `filePath` (errors swallowed). */
  private async _closeLiveDiffTabs(filePath: string): Promise<void> {
    const wantedAfter = `after:${filePath}`;
    const wantedBefore = `before:${filePath}`;
    const matches = (uri: vscode.Uri | undefined): boolean => {
      if (!uri || uri.scheme !== QGenieDiffProvider.scheme) { return false; }
      try {
        const decoded = decodeURIComponent(uri.path);
        return decoded === wantedAfter || decoded === wantedBefore;
      } catch {
        return uri.path === wantedAfter || uri.path === wantedBefore;
      }
    };
    const tabsToClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as unknown;
        if (input && typeof input === 'object') {
          const i = input as { original?: vscode.Uri; modified?: vscode.Uri; uri?: vscode.Uri };
          if (matches(i.original) || matches(i.modified) || matches(i.uri)) {
            tabsToClose.push(tab);
          }
        }
      }
    }
    if (tabsToClose.length > 0) {
      try { await vscode.window.tabGroups.close(tabsToClose, true); }
      catch { /* ignore */ }
    }
  }

  private async _closeLiveDiffAndOpenFile(filePath: string): Promise<void> {
    // Read at point of use so config changes take effect without reload.
    const configured = vscode.workspace.getConfiguration('qgenieSkills').get('liveDiffLingerMs', 3000);
    const LIVE_DIFF_LINGER_MS = Math.max(0, configured);
    await new Promise<void>((resolve) => setTimeout(resolve, LIVE_DIFF_LINGER_MS));

    await this._closeLiveDiffTabs(filePath);

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, {
        preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One,
      });
    } catch { /* ignore */ }
  }

  private _post(msg: Record<string, unknown>): void {
    this._host.postToWebview(this.id, msg);
  }
}