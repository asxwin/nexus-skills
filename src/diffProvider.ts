import * as vscode from 'vscode';

/** Virtual document content provider for diff views (scheme: 'qgenie-diff'). */
export class QGenieDiffProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'qgenie-diff';

  private readonly _contents = new Map<string, string>();
  private readonly _emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this._emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.toString()) || '';
  }

  /** Store content under a key (e.g. 'before:/path', 'after:/path') and return its virtual URI. */
  setContent(key: string, content: string): vscode.Uri {
    const uri = vscode.Uri.parse(
      `${QGenieDiffProvider.scheme}:${encodeURIComponent(key)}`,
      true
    );
    const uriStr = uri.toString();
    // LRU eviction: delete first so re-insertion moves to end (most recent)
    if (this._contents.has(uriStr)) {
      this._contents.delete(uriStr);
    }
    this._contents.set(uriStr, content);
    // Evict oldest entry if exceeding capacity (Map preserves insertion order)
    if (this._contents.size > 40) {
      const firstKey = this._contents.keys().next().value;
      if (firstKey !== undefined) { this._contents.delete(firstKey); }
    }
    this._emitter.fire(uri);
    return uri;
  }

  /** Convenience: store "before" content for a file path */
  setBeforeContent(filePath: string, content: string): vscode.Uri {
    return this.setContent(`before:${filePath}`, content);
  }

  /** Convenience: store "after" content for a file path */
  setAfterContent(filePath: string, content: string): vscode.Uri {
    return this.setContent(`after:${filePath}`, content);
  }

  dispose(): void {
    this._emitter.dispose();
    this._contents.clear();
  }
}
