/**
 * IndexController — VSCode glue for the AI-free CodebaseIndexer.
 *
 * Owns the status-bar button, the progress notification, the command handlers
 * (index / reindex / clear / search) and a debounced file watcher for cheap
 * incremental re-indexing. Indexing runs on the host thread but yields
 * periodically (see CodebaseIndexer.build) so the UI stays responsive.
 */
import * as vscode from 'vscode';
import { CodebaseIndexer, IndexStats } from './CodebaseIndexer';

function fmtBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class IndexController {
  private readonly statusBar: vscode.StatusBarItem;
  private indexers = new Map<string, CodebaseIndexer>();
  private busy = false;
  private watcher?: vscode.FileSystemWatcher;
  private reindexTimer?: NodeJS.Timeout;

  /** Optional hook fired whenever index status may have changed (build done,
   *  cleared, or watcher detected staleness). The chat webview subscribes to
   *  this to repaint its in-panel Index button. */
  public onStatusChanged?: () => void;

  /** Optional hook fired with the live indexing percentage (0–100) so external
   *  UIs (the chat button) can show a live progress readout. */
  public onProgress?: (percent: number) => void;

  /** True while an index build is in progress (for UI spinners). */
  get isBusy(): boolean { return this.busy; }

  /** Read-only status snapshot for external UIs (e.g. the chat webview). */
  getStatus(): { state: 'none' | 'fresh' | 'stale'; fileCount: number; lastIndexed: number } {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return { state: 'none', fileCount: 0, lastIndexed: 0 }; }
    const ix = this.indexerFor(folder.uri.fsPath);
    const stats = ix.stats();
    if (!stats) { return { state: 'none', fileCount: 0, lastIndexed: 0 }; }
    return {
      // FLAW FIX: isStale() now returns a structured diff; project to the
      // existing boolean state surface for backwards compatibility.
      state: ix.isStale().stale ? 'stale' : 'fresh',
      fileCount: stats.fileCount,
      lastIndexed: stats.lastIndexed,
    };
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusBar.command = 'qgenieSkills.indexCodebase';
    this.statusBar.tooltip = 'NEXUS — index this codebase for the agent (no AI, fully local)';
    context.subscriptions.push(this.statusBar);
  }

  /** Register commands, status bar and watchers. Call from activate(). */
  register(): void {
    const ctx = this.context;
    ctx.subscriptions.push(
      vscode.commands.registerCommand('qgenieSkills.indexCodebase', () => this.indexAll(false)),
      vscode.commands.registerCommand('qgenieSkills.reindexCodebase', () => this.indexAll(true)),
      vscode.commands.registerCommand('qgenieSkills.clearCodebaseIndex', () => this.clearAll()),
      vscode.commands.registerCommand('qgenieSkills.searchCodebase', () => this.searchInteractive()),
    );

    this.attachWatcher();
    this.refreshStatusBar();
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.indexers.clear();
      this.attachWatcher();
      this.refreshStatusBar();
    }, undefined, ctx.subscriptions);
  }

  /** Programmatic retrieval entry point — usable by the chat agent. */
  retrieve(query: string, k = 20) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return undefined; }
    return this.indexerFor(folder.uri.fsPath).retrieve(query, { k });
  }

  private indexerFor(root: string): CodebaseIndexer {
    let ix = this.indexers.get(root);
    if (!ix) { ix = new CodebaseIndexer(root); this.indexers.set(root, ix); }
    return ix;
  }

  private async indexAll(force: boolean): Promise<void> {
    if (this.busy) {
      vscode.window.showInformationMessage('NEXUS is already indexing…');
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      vscode.window.showWarningMessage('Open a folder first to index it.');
      return;
    }

    // FLAW FIX: no longer prompt the user before (re)indexing.
    //
    // Indexing is already (a) user-initiated — this method only runs in
    // response to a deliberate click on the status-bar button or
    // command — and (b) incremental: CodebaseIndexer.build()'s stat
    // fast-path skips unchanged files automatically. The previous
    // confirmation toast was friction the user explicitly asked us to
    // remove. Just go.
    //
    // We keep ONE early-exit: if it's an incremental re-index and
    // nothing has actually changed, do nothing rather than spin up the
    // progress UI for zero work.
    if (!force) {
      let totalChanged = 0;
      let anyHasIndex = false;
      for (const f of folders) {
        const ix = this.indexerFor(f.uri.fsPath);
        if (ix.hasIndex()) {
          anyHasIndex = true;
          const s = ix.isStale();
          totalChanged += s.added + s.removed + s.modified;
        }
      }
      if (anyHasIndex && totalChanged === 0) {
        vscode.window.showInformationMessage(
          'NEXUS index is already up to date — nothing to re-index.'
        );
        return;
      }
    }

    this.busy = true;
    this.onStatusChanged?.();
    let totalStats: IndexStats | undefined;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: force ? 'NEXUS: Re-indexing codebase' : 'NEXUS: Indexing codebase',
          cancellable: false,
        },
        async (progress) => {
          for (const f of folders) {
            const ix = this.indexerFor(f.uri.fsPath);
            let last = 0;
            const stats = await ix.build((message, percent) => {
              const inc = Math.max(0, percent - last);
              last = percent;
              progress.report({ message, increment: inc / folders.length });
              this.statusBar.text = `$(sync~spin) Indexing ${Math.round(percent)}%`;
              this.statusBar.show();
              this.onProgress?.(Math.round(percent));
            }, force);
            totalStats = stats;
          }
        }
      );
      if (totalStats) {
        vscode.window.showInformationMessage(
          `✅ NEXUS indexed ${totalStats.fileCount} files · ${totalStats.chunkCount} chunks · ` +
          `${totalStats.symbolCount} symbols · ${fmtBytes(totalStats.sizeOnDiskBytes)} on disk.`
        );
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `NEXUS indexing failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.busy = false;
      this.refreshStatusBar();
      this.onStatusChanged?.();
    }
  }

  private async clearAll(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) { this.indexerFor(f.uri.fsPath).clear(); }
    this.indexers.clear();
    vscode.window.showInformationMessage('NEXUS codebase index cleared.');
    this.refreshStatusBar();
    this.onStatusChanged?.();
  }

  private async searchInteractive(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
    const ix = this.indexerFor(folder.uri.fsPath);
    if (!ix.hasIndex()) {
      const choice = await vscode.window.showInformationMessage(
        'No index yet. Index this codebase now?', 'Index'
      );
      if (choice === 'Index') { await this.indexAll(false); } else { return; }
    }
    const query = await vscode.window.showInputBox({
      prompt: 'Search the local codebase index (BM25, no AI)',
      placeHolder: 'e.g. parse skill frontmatter',
      ignoreFocusOut: true,
    });
    if (!query) { return; }
    const result = ix.retrieve(query, { k: 25 });
    if (!result.hits.length) {
      vscode.window.showInformationMessage(`No matches for "${query}".`);
      return;
    }
    const picks = result.hits.map(h => ({
      label: `$(symbol-method) ${h.chunk.symbol || h.chunk.kind}`,
      description: `${h.chunk.file}:${h.chunk.startLine}`,
      detail: `score ${h.score.toFixed(2)} · ${h.chunk.content.slice(0, 120).replace(/\s+/g, ' ')}`,
      hit: h,
    }));
    const sel = await vscode.window.showQuickPick(picks, {
      placeHolder: `${result.hits.length} relevant chunks — pick one to open`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!sel) { return; }
    const uri = vscode.Uri.joinPath(folder.uri, sel.hit.chunk.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const line = sel.hit.chunk.startLine - 1;
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  }

  private attachWatcher(): void {
    this.watcher?.dispose();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*')
    );
    const onChange = (uri: vscode.Uri) => {
      if (uri.fsPath.includes('/.nexus/') || uri.fsPath.includes('\\.nexus\\')) { return; }
      const ix = this.indexerFor(folder.uri.fsPath);
      if (!ix.hasIndex()) { return; }
      if (this.reindexTimer) { clearTimeout(this.reindexTimer); }
      this.reindexTimer = setTimeout(() => {
        this.reindexTimer = undefined;
        if (!this.busy) {
          this.refreshStatusBar();
          this.onStatusChanged?.();
        }
      }, 2000);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
    this.context.subscriptions.push(this.watcher);
  }

  private refreshStatusBar(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.statusBar.text = '$(database) Index';
      this.statusBar.show();
      return;
    }
    const ix = this.indexerFor(folder.uri.fsPath);
    const stats = ix.stats();
    if (!stats) {
      this.statusBar.text = '$(database) Index Codebase';
      this.statusBar.command = 'qgenieSkills.indexCodebase';
      this.statusBar.tooltip = 'NEXUS — index this codebase for the agent (no AI, fully local)';
      this.statusBar.show();
      return;
    }
    const staleness = ix.isStale();
    const meta =
      `NEXUS index: ${stats.fileCount} files · ${stats.chunkCount} chunks · ` +
      `${stats.symbolCount} symbols\nLast indexed ${new Date(stats.lastIndexed).toLocaleString()}`;
    if (staleness.stale) {
      const changeCount = staleness.added + staleness.removed + staleness.modified;
      this.statusBar.text = `$(sync) Re-index (${changeCount} changed)`;
      // FLAW FIX: status-bar click on a stale index uses the INCREMENTAL
      // path (force=false). Only the explicit "Re-index Codebase" command
      // from the palette uses force=true (full rebuild, ignores cache).
      this.statusBar.command = 'qgenieSkills.indexCodebase';
      this.statusBar.tooltip = `${meta}\n\n${changeCount} file${changeCount === 1 ? '' : 's'} changed (${staleness.added} added, ${staleness.removed} removed, ${staleness.modified} modified) — click to re-index just those.`;
    } else {
      this.statusBar.text = `$(check) Index up to date (${stats.fileCount})`;
      this.statusBar.command = 'qgenieSkills.indexCodebase';
      this.statusBar.tooltip = `${meta}\n\nUp to date — click to re-index anyway.`;
    }
    this.statusBar.show();
  }
}
