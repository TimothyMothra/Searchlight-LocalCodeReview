/**
 * Shared webview HTML scaffolding for the pane-conversion project (Files / Commits / Conversations).
 *
 * The 3 native TreeViews are being converted to `WebviewView`s. Every pane webview reuses the same
 * boilerplate: a strict CSP, a nonce'd script channel, the standard `--vscode-*` theme variables, and
 * a shared render-timing hook so each pane can report its client-side render duration back to the
 * extension host for the perf metrics protocol (see `webviewMetrics.ts`).
 *
 * Unlike the existing `comparisonView.ts` (which ships `enableScripts` with NO CSP/nonce), this shell
 * ADDS a strict Content-Security-Policy + per-load nonce so pane scripts run under a locked-down policy.
 *
 * Intended use (a pane's `WebviewViewProvider`):
 *
 * ```ts
 * import { webviewHtml, getNonce } from './webviewShell';
 *
 * resolveWebviewView(view: vscode.WebviewView): void {
 *   view.webview.options = { enableScripts: true };
 *   const nonce = getNonce();
 *   view.webview.html = webviewHtml({
 *     webview: view.webview,
 *     nonce,
 *     viewName: 'files',
 *     styleCss: `.row { padding: 2px 6px; }`,
 *     bodyHtml: `<div id="rows"></div>`,
 *     // Pane script runs AFTER the baked shell script, so `vscode` + `reportRendered` are in scope.
 *     scriptJs: `
 *       window.addEventListener('message', (e) => {
 *         if (e.data.type !== 'state') { return; }
 *         const t0 = performance.now();
 *         const rows = e.data.rows || [];
 *         document.getElementById('rows').textContent = rows.length + ' items';
 *         reportRendered('files', rows.length, t0); // -> host emits [perf] files.render
 *       });
 *       vscode.postMessage({ type: 'ready' });
 *     `,
 *   });
 * }
 * ```
 */

import * as vscode from 'vscode';

/** A 32-char alphanumeric nonce for the webview's script-src CSP directive (fresh per load). */
export function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

/** Options for {@link webviewHtml}. Keep pane-specific content in `bodyHtml` / `scriptJs` / `styleCss`. */
export interface WebviewHtmlOptions {
	/** The pane's webview (used for `cspSource`). */
	webview: vscode.Webview;
	/** Per-load nonce from {@link getNonce}; gates the pane script under `script-src 'nonce-...'`. */
	nonce: string;
	/** Stable pane id used as the default `view` in `reportRendered` and the `rendered` message. */
	viewName: string;
	/** Pane-specific body markup (rendered inside `<body>`). */
	bodyHtml: string;
	/** Pane-specific script; runs after the baked shell script, so `vscode` + `reportRendered` exist. */
	scriptJs: string;
	/** Optional pane-specific CSS appended after the shared theme base. */
	styleCss?: string;
}

/**
 * Build the full `<!DOCTYPE html>` document for a pane webview: strict CSP + nonce, shared `--vscode-*`
 * theme base, the pane's `bodyHtml`, and two nonce'd scripts — the baked render-timing shell followed
 * by the pane's own `scriptJs`.
 *
 * The baked shell exposes:
 * - `const vscode = acquireVsCodeApi()` — the message channel to the extension host.
 * - `reportRendered(view, count, t0)` — posts `{ type: 'rendered', view, ms: performance.now()-t0, count }`
 *   back to the host (which turns it into a `[perf] <view>.render: <ms>ms, count=<n>` line). Panes call
 *   this at the END of their render handler, passing the `t0` they captured at the START.
 */
export function webviewHtml(opts: WebviewHtmlOptions): string {
	const { webview, nonce, viewName, bodyHtml, scriptJs, styleCss = '' } = opts;

	// Strict CSP: nothing loads by default; styles only from the webview origin (+ inline for theme
	// vars); scripts only when carrying this load's nonce; fonts from the webview origin so bundled
	// codicons resolve. If a pane later fails to load codicons, this `font-src` is the lever to widen.
	const csp =
		`default-src 'none'; ` +
		`style-src ${webview.cspSource} 'unsafe-inline'; ` +
		`script-src 'nonce-${nonce}'; ` +
		`font-src ${webview.cspSource};`;

	// Baked render-timing shell. Defines the vscode handle + `reportRendered` used by every pane.
	const shellScript = /* js */ `
  const vscode = acquireVsCodeApi();
  const __searchlightView = ${JSON.stringify(viewName)};
  // Post the client-side render duration back to the host for the metrics protocol.
  // Panes capture \`const t0 = performance.now()\` when a {type:'state',...} message arrives,
  // render, then call reportRendered(view, count, t0).
  function reportRendered(view, count, t0) {
    vscode.postMessage({
      type: 'rendered',
      view: view || __searchlightView,
      ms: performance.now() - t0,
      count: count,
    });
  }
`;

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
  }
  a { color: var(--vscode-textLink-foreground); }
${styleCss}
</style>
</head>
<body>
${bodyHtml}
<script nonce="${nonce}">${shellScript}</script>
<script nonce="${nonce}">${scriptJs}</script>
</body>
</html>`;
}
