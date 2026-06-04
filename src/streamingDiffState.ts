import * as vscode from 'vscode';
import { QGenieDiffProvider } from './diffProvider';
import { parseSearchReplaceBlocks, applySearchReplaceBlocks } from './agentTools';

export class StreamingDiffState {
  public write = {
    active: false, filePath: '', target: '', paintedLength: 0,
    streamDone: false, pushScheduled: false,
  };

  public edit = {
    active: false, filePath: '', originalContent: '',
    workingContent: '', diffBuffer: '', blocksApplied: 0, pushScheduled: false,
    // Surfaced parse/apply-error state so callers can detect a corrupt or
    // partial diff instead of seeing a silently-frozen stream. Empty = no error.
    parseError: '' as string,
  };

  private _diffProvider: QGenieDiffProvider;

  constructor(diffProvider: QGenieDiffProvider) {
    this._diffProvider = diffProvider;
  }

  reset(): void {
    this.write = {
      active: false, filePath: '', target: '', paintedLength: 0,
      streamDone: false, pushScheduled: false,
    };
    this.edit = {
      active: false, filePath: '', originalContent: '',
      workingContent: '', diffBuffer: '', blocksApplied: 0, pushScheduled: false,
      parseError: '',
    };
  }

  startStreamingWrite(filePath: string): void {
    this.write.active = true;
    this.write.filePath = filePath;
    this.write.target = '';
    this.write.streamDone = false;
  }

  startStreamingEdit(filePath: string, originalContent: string): void {
    this.edit.active = true;
    this.edit.filePath = filePath;
    this.edit.originalContent = originalContent;
    this.edit.workingContent = originalContent;
    this.edit.diffBuffer = '';
    this.edit.blocksApplied = 0;
    this.edit.parseError = '';
  }

  pushStreamingContent(content: string): void {
    const sw = this.write;
    if (!sw.active) { return; }
    if (content.length <= sw.target.length) { return; }
    sw.target = content;
    if (sw.pushScheduled) { return; }
    sw.pushScheduled = true;
    setImmediate(() => {
      sw.pushScheduled = false;
      if (!sw.active) { return; }
      if (sw.paintedLength === sw.target.length) { return; }
      sw.paintedLength = sw.target.length;
      this._diffProvider.setAfterContent(sw.filePath, sw.target);
      this.focusOnTypewriterCursor(sw.target);
    });
  }

  finishStreamingWrite(): void {
    const sw = this.write;
    if (!sw.active) { return; }
    sw.active = false;
    if (sw.target.length > 0 && sw.paintedLength !== sw.target.length) {
      sw.paintedLength = sw.target.length;
      this._diffProvider.setAfterContent(sw.filePath, sw.target);
      this.focusOnTypewriterCursor(sw.target);
    }
  }

  findAfterEditorForStreamingWrite(): vscode.TextEditor | undefined {
    const sw = this.write;
    if (!sw.filePath) { return undefined; }
    const wantedKey = `after:${sw.filePath}`;
    return vscode.window.visibleTextEditors.find((ed) => {
      const uri = ed.document.uri;
      if (uri.scheme !== QGenieDiffProvider.scheme) { return false; }
      try { return decodeURIComponent(uri.path) === wantedKey; }
      catch { return uri.path === wantedKey; }
    });
  }

  focusOnTypewriterCursor(revealedText: string): void {
    const editor = this.findAfterEditorForStreamingWrite();
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

  tryApplyStreamingEditBlocks(): void {
    const se = this.edit;
    if (!se.active) { return; }
    let blocks;
    // Surface parse failures instead of silently swallowing them so callers
    // can detect a corrupt/partial diff rather than seeing a frozen stream.
    try { blocks = parseSearchReplaceBlocks(se.diffBuffer); se.parseError = ''; }
    catch (e) { se.parseError = (e as Error).message || 'parse error'; return; }
    if (blocks.length <= se.blocksApplied) { return; }
    const newBlocks = blocks.slice(se.blocksApplied);
    let next = se.workingContent;
    let appliedNow = 0;
    for (const b of newBlocks) {
      if (b.search.length === 0) { break; }
      const idx = next.indexOf(b.search);
      if (idx === -1) { break; }
      next = next.slice(0, idx) + b.replace + next.slice(idx + b.search.length);
      appliedNow++;
    }
    if (appliedNow === 0) { return; }
    se.workingContent = next;
    se.blocksApplied += appliedNow;
    if (se.pushScheduled) { return; }
    se.pushScheduled = true;
    setImmediate(() => {
      se.pushScheduled = false;
      if (!se.active) { return; }
      this._diffProvider.setAfterContent(se.filePath, se.workingContent);
    });
  }

  finishStreamingEdit(): void {
    const se = this.edit;
    if (!se.active) { return; }
    // Compute the final content into LOCALS first; only commit atomically if
    // the FULL apply succeeds. On any throw we leave prior state untouched and
    // record parseError, never painting a half-applied (inconsistent) state.
    let committed = se.workingContent;
    let committedBlocks = se.blocksApplied;
    try {
      const all = parseSearchReplaceBlocks(se.diffBuffer);
      if (all.length > se.blocksApplied) {
        const remaining = all.slice(se.blocksApplied);
        const r = applySearchReplaceBlocks(se.workingContent, remaining);
        committed = r.result;
        committedBlocks = all.length;
      }
      se.parseError = '';
    } catch (e) {
      // Leave se.workingContent / se.blocksApplied at their last-good values;
      // do NOT call setAfterContent with a partial apply.
      se.parseError = (e as Error).message || 'apply error';
      se.active = false;
      return;
    }
    // Full apply succeeded — commit atomically and paint the result.
    se.workingContent = committed;
    se.blocksApplied = committedBlocks;
    this._diffProvider.setAfterContent(se.filePath, se.workingContent);
    se.active = false;
  }
}
