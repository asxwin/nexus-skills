import * as vscode from 'vscode';

/** HTML-escape a string for safe embedding in HTML attributes and content. */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate a random 32-char alphanumeric nonce for CSP script tags. */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
  return text;
}

/** Dispose all items in an array and empty it. */
export function disposeAll(disposables: vscode.Disposable[]): void {
  while (disposables.length) { disposables.pop()?.dispose(); }
}
