import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatMessage } from './qgenieApi';

/** UI events captured from a chat session; replayed in order to restore a past conversation in the webview. */
export type ChatHistoryEvent =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      toolName: string;
      toolInput: string;
      toolResult: string;
      isError: boolean;
    }
  | { kind: 'sys'; text: string; isError?: boolean }
  | { kind: 'attach'; label: string; preview: string }
  | {
      kind: 'orchestrate';
      agents: Array<{
        id: string;
        title: string;
        task: string;
        finalText: string;
        ok: boolean;
        tools: Array<{ toolName: string; toolInput: string; toolResult: string; isError: boolean }>;
      }>;
    };

/** A persisted chat session. `messages` is used for resumption; `events` is the UI-event log for replay rendering. */
export interface ChatHistorySession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  skillName?: string;
  messages: ChatMessage[];
  events: ChatHistoryEvent[];
  attachments: Array<{ label: string; content: string }>;
  promptTokens: number;
  completionTokens: number;
}

/** Lightweight summary returned to the webview for the history list UI. */
export interface ChatHistorySummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  skillName?: string;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
}

/** Hard cap on the number of sessions we keep on disk. Older sessions are
 *  dropped FIFO when this limit is exceeded so the index file doesn't grow
 *  without bound. */
const MAX_SESSIONS = 100;

/** On-disk store: one JSON file per session under `<globalStorage>/chat-history/`, plus an `index.json`.
 *  Per-session files prevent a corrupted session from breaking the whole index. */
export class ChatHistoryStore {
  private readonly _root: string;
  private readonly _indexPath: string;
  private _index: ChatHistorySummary[] = [];
  private _loaded = false;

  constructor(context: vscode.ExtensionContext) {
    this._root = path.join(context.globalStorageUri.fsPath, 'chat-history');
    this._indexPath = path.join(this._root, 'index.json');
  }

  /** Ensure storage dirs exist and the index is in memory. Idempotent. */
  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) { return; }
    try {
      if (!fs.existsSync(this._root)) {
        await fsp.mkdir(this._root, { recursive: true });
      }
      if (fs.existsSync(this._indexPath)) {
        const raw = await fsp.readFile(this._indexPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this._index = parsed.filter((s) => s && typeof s.id === 'string');
        }
      }
    } catch {
      // Corrupted index → start fresh; we never want history bugs to
      // brick the chat panel.
      this._index = [];
    }
    this._loaded = true;
  }

  private async _writeIndex(): Promise<void> {
    try {
      await fsp.writeFile(this._indexPath, JSON.stringify(this._index, null, 2), 'utf8');
    } catch {
      /* ignore — non-fatal */
    }
  }

  private _sessionPath(id: string): string {
    return path.join(this._root, `${id}.json`);
  }

  /** newId() — short, sortable, unique-enough for human history. */
  public newId(): string {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 8);
    return `s_${t}_${r}`;
  }

  /**
   * Save a session. Replaces any prior on-disk copy (sessions are
   * mutated as the chat progresses, then re-saved).
   */
  public async save(session: ChatHistorySession): Promise<void> {
    await this._ensureLoaded();
    try {
      await fsp.writeFile(this._sessionPath(session.id), JSON.stringify(session), 'utf8');
    } catch {
      return;
    }
    const summary: ChatHistorySummary = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      skillName: session.skillName,
      messageCount: session.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
      promptTokens: session.promptTokens,
      completionTokens: session.completionTokens,
    };
    const idx = this._index.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      this._index[idx] = summary;
    } else {
      this._index.unshift(summary);
    }
    // Re-sort by updatedAt desc so newest-first stays accurate.
    this._index.sort((a, b) => b.updatedAt - a.updatedAt);
    // Trim to MAX_SESSIONS, deleting overflow files from disk.
    if (this._index.length > MAX_SESSIONS) {
      const overflow = this._index.splice(MAX_SESSIONS);
      for (const o of overflow) {
        try { fs.unlinkSync(this._sessionPath(o.id)); } catch { /* ignore */ }
      }
    }
    await this._writeIndex();
  }

  public async list(): Promise<ChatHistorySummary[]> {
    await this._ensureLoaded();
    return this._index.slice();
  }

  public async load(id: string): Promise<ChatHistorySession | undefined> {
    await this._ensureLoaded();
    try {
      const raw = await fsp.readFile(this._sessionPath(id), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.messages)) {
        return parsed as ChatHistorySession;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  public async delete(id: string): Promise<void> {
    await this._ensureLoaded();
    try { await fsp.unlink(this._sessionPath(id)); } catch { /* ignore */ }
    this._index = this._index.filter((s) => s.id !== id);
    await this._writeIndex();
  }

  public async clearAll(): Promise<void> {
    await this._ensureLoaded();
    for (const s of this._index) {
      try { await fsp.unlink(this._sessionPath(s.id)); } catch { /* ignore */ }
    }
    this._index = [];
    await this._writeIndex();
  }

  /** Build a human-friendly title from the first user message (strips whitespace, collapses newlines, truncates). */
  public static deriveTitle(firstUserText: string): string {
    if (!firstUserText) { return 'Untitled chat'; }
    const oneLine = firstUserText.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 60) { return oneLine; }
    return oneLine.slice(0, 57) + '...';
  }
}
