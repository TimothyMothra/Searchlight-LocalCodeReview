/**
 * Commits pane as a WebviewView (Phase D of the TreeView→Webview conversion).
 *
 * 1:1 behavioral parity with the former `CommitsViewProvider` (src/commitsView.ts):
 *   - one flat row per commit (short sha, subject, author, relative date),
 *   - lazy per-commit expand → `changedFilesForCommit` (diff-tree --name-only), plain file rows
 *     (a historical commit's file list gets NO working-tree gitDecoration colors — correct parity),
 *   - `copyCommitSha` inline button per row,
 *   - a truncation affordance row when the commit log was truncated for performance.
 *
 * Metrics parity: keeps `commits.data-load` (emitted inside ActiveComparison.getCommits),
 * `commits.build` (host-side, this file) and `commits.expand` (host-side, per expand) intact, and
 * adds `commits.render` + `commits.firstPaint` via the shared webview metrics protocol.
 *
 * This module NEVER calls a language model.
 */

import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { webviewHtml, getNonce } from './webviewShell';
import { logBuild, logRendered, logFirstPaint, isRenderedMessage } from './webviewMetrics';
import { changedFilesForCommit } from './git';
import { perfCount } from './perf';

/** A commit row in the serializable payload sent to the webview. */
interface WireCommit {
	sha: string;
	shortSha: string;
	subject: string;
	author: string;
	relDate: string;
}

type IncomingMessage =
	| { type: 'ready' }
	| { type: 'expand'; sha: string }
	| { type: 'openCommitFile'; sha: string; relPath: string }
	| { type: 'copySha'; sha: string }
	| { type: 'rendered'; view: string; ms: number; count: number };

export class CommitsWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private commitsExpanded = false;

	constructor(private readonly getActive: () => ActiveComparison | undefined) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const tResolve = Date.now();
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.html(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async (msg: IncomingMessage) => {
			switch (msg.type) {
				case 'ready':
					await this.postState();
					break;
				case 'expand':
					if (msg.sha) {
						await this.onExpand(msg.sha);
					}
					break;
				case 'openCommitFile':
					if (msg.sha && msg.relPath) {
						await vscode.commands.executeCommand('searchlight.openCommitFileDiff', msg.sha, msg.relPath);
					}
					break;
				case 'copySha':
					if (msg.sha) {
						await vscode.commands.executeCommand('searchlight.copyCommitSha', msg.sha);
					}
					break;
				default:
					if (isRenderedMessage(msg)) {
						logRendered(msg);
						logFirstPaint('commits', tResolve);
					}
					break;
			}
		});
		void this.postState();
	}

	/** External refresh (called by refreshAll). */
	refresh(): void {
		void this.postState();
	}

	/** Collapse-all (host command `searchlight.collapseAllCommits`); value=true is a no-op reset. */
	setExpanded(value: boolean): void {
		this.commitsExpanded = value;
		this.view?.webview.postMessage({ type: 'setExpanded', value });
	}

	/** Lazy per-commit file expand (mirrors commitsView.ts CommitNode getChildren). */
	private async onExpand(sha: string): Promise<void> {
		const active = this.getActive();
		const cwd = active?.repoRootFsPath;
		if (!this.view || !cwd) {
			return;
		}
		const tExpand = Date.now();
		const files = await changedFilesForCommit(cwd, sha);
		perfCount('commits.expand', tExpand, files.length);
		this.view.webview.postMessage({ type: 'files', sha, files });
	}

	/** Build the current commit list and push it to the webview (mirrors commitsView.ts root getChildren). */
	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const active = this.getActive();
		if (!active || !active.base || !active.compare) {
			this.view.webview.postMessage({ type: 'state', commits: null, expanded: this.commitsExpanded });
			return;
		}

		const tBuild = Date.now();
		const { commits, truncated } = await active.getCommits();
		const wire: WireCommit[] = commits.map((c) => ({
			sha: c.sha,
			shortSha: c.shortSha,
			subject: c.subject,
			author: c.author,
			relDate: c.relDate,
		}));
		logBuild('commits', tBuild, wire.length, wire);
		this.view.webview.postMessage({
			type: 'state',
			commits: wire,
			truncated,
			expanded: this.commitsExpanded,
		});
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		return webviewHtml({
			webview,
			nonce,
			viewName: 'commits',
			bodyHtml: '<div id="rows"></div>',
			styleCss: COMMITS_CSS,
			scriptJs: COMMITS_JS,
		});
	}
}

/** Pane-specific CSS (theme vars come from the shared shell). */
const COMMITS_CSS = `
#rows { user-select: none; }
.msg { padding: 6px 12px; color: var(--vscode-descriptionForeground); }
.row {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 1px 0;
	cursor: pointer;
	white-space: nowrap;
	line-height: 22px;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row:hover .copy { visibility: visible; }
.twisty {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	justify-content: center;
	color: var(--vscode-icon-foreground);
	transition: transform 0.1s;
}
.twisty.spacer { visibility: hidden; }
.commit.collapsed > .row .twisty { transform: rotate(-90deg); }
.glyph {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: var(--vscode-icon-foreground);
}
.glyph svg { width: 16px; height: 16px; fill: currentColor; }
.sha {
	font-family: var(--vscode-editor-font-family, monospace);
	color: var(--vscode-descriptionForeground);
	margin-right: 4px;
}
.label { overflow: hidden; text-overflow: ellipsis; }
.desc { color: var(--vscode-descriptionForeground); margin-left: 6px; font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; }
.copy {
	margin-left: auto;
	padding-left: 8px;
	visibility: hidden;
	color: var(--vscode-icon-foreground);
	display: inline-flex;
	align-items: center;
}
.copy svg { width: 14px; height: 14px; fill: currentColor; }
.children { display: block; }
.commit.collapsed > .children { display: none; }
.cfile { padding-left: 20px; color: var(--vscode-foreground); }
.cfile .desc { }
.loading { padding: 2px 0 2px 20px; color: var(--vscode-descriptionForeground); font-style: italic; }
.trunc { padding: 4px 12px; color: var(--vscode-descriptionForeground); font-style: italic; }
`;

/** Pane-specific script. The shared shell has already defined `vscode`, `reportRendered`, etc. */
const COMMITS_JS = `
const rows = document.getElementById('rows');

// Inline SVG glyphs (currentColor) — codicons aren't bundled, so no font is loaded.
const COMMIT_SVG = '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/><path d="M1 7.5h4.05v1H1zM10.95 7.5H15v1h-4.05z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 16 16"><path d="M9.5 1H3.5L3 1.5v13l.5.5h9l.5-.5V5.5L9.5 1zm0 1.4L11.6 4.5H9.5V2.4zM4 14V2h4.5v3.5H12V14H4z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4V4z"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 16 16"><path d="M4 4V1.5L4.5 1h9l.5.5v9l-.5.5H11v2.5l-.5.5h-9L1 13.5v-9L1.5 4H4zm1 0h5.5l.5.5V9h2V2H5v2zM2 13h8V5H2v8z"/></svg>';

let commits = null;      // WireCommit[] | null
let truncated = false;
let expanded = new Set();          // shas of expanded commit rows
let filesBySha = new Map();        // sha → string[] (changed files), 'loading' while pending

function basename(p) {
	const i = p.lastIndexOf('/');
	return i === -1 ? p : p.slice(i + 1);
}
function dirname(p) {
	const i = p.lastIndexOf('/');
	return i === -1 ? '' : p.slice(0, i);
}

function renderCommit(c) {
	const open = expanded.has(c.sha);
	const el = document.createElement('div');
	el.className = 'commit' + (open ? '' : ' collapsed');

	const row = document.createElement('div');
	row.className = 'row';
	row.innerHTML =
		'<span class="twisty">' + CHEVRON_SVG + '</span>' +
		'<span class="glyph">' + COMMIT_SVG + '</span>' +
		'<span class="sha"></span>' +
		'<span class="label"></span>' +
		'<span class="desc"></span>' +
		'<span class="copy" title="Copy commit SHA">' + COPY_SVG + '</span>';
	row.querySelector('.sha').textContent = c.shortSha;
	row.querySelector('.label').textContent = c.subject;
	row.querySelector('.desc').textContent = c.author + ', ' + c.relDate;
	row.querySelector('.copy').addEventListener('click', (e) => {
		e.stopPropagation();
		vscode.postMessage({ type: 'copySha', sha: c.sha });
	});
	row.addEventListener('click', () => {
		if (expanded.has(c.sha)) {
			expanded.delete(c.sha);
		} else {
			expanded.add(c.sha);
			if (!filesBySha.has(c.sha)) {
				filesBySha.set(c.sha, 'loading');
				vscode.postMessage({ type: 'expand', sha: c.sha });
			}
		}
		paint();
	});
	el.appendChild(row);

	const kids = document.createElement('div');
	kids.className = 'children';
	const files = filesBySha.get(c.sha);
	if (files === 'loading') {
		const l = document.createElement('div');
		l.className = 'loading';
		l.textContent = 'Loading changes…';
		kids.appendChild(l);
	} else if (Array.isArray(files)) {
		for (const relPath of files) {
			const fr = document.createElement('div');
			fr.className = 'row cfile';
			fr.innerHTML =
				'<span class="twisty spacer"></span>' +
				'<span class="glyph">' + FILE_SVG + '</span>' +
				'<span class="label"></span>' +
				'<span class="desc"></span>';
			fr.querySelector('.label').textContent = basename(relPath);
			const dir = dirname(relPath);
			fr.querySelector('.desc').textContent = dir || '';
			fr.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'openCommitFile', sha: c.sha, relPath });
			});
			kids.appendChild(fr);
		}
	}
	el.appendChild(kids);
	return el;
}

function paint() {
	const t0 = performance.now();
	rows.innerHTML = '';
	if (commits === undefined) {
		rows.innerHTML = '<div class="msg">Loading commits…</div>';
		reportRendered('commits', 0, t0);
		return;
	}
	if (!commits || commits.length === 0) {
		rows.innerHTML = '<div class="msg">No commits in range.</div>';
		reportRendered('commits', 0, t0);
		return;
	}
	const frag = document.createDocumentFragment();
	for (const c of commits) {
		frag.appendChild(renderCommit(c));
	}
	if (truncated) {
		const t = document.createElement('div');
		t.className = 'trunc';
		t.textContent = '(' + commits.length + '+ commits — showing ' + commits.length + ')';
		t.title = 'The commit log was truncated for performance. Use the terminal for the full history.';
		frag.appendChild(t);
	}
	rows.appendChild(frag);
	reportRendered('commits', commits.length, t0);
}

window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'state') {
		commits = m.commits;               // WireCommit[] | null
		truncated = !!m.truncated;
		paint();
	} else if (m.type === 'files') {
		filesBySha.set(m.sha, m.files || []);
		paint();
	} else if (m.type === 'setExpanded') {
		if (!m.value) { expanded.clear(); }
		paint();
	}
});

vscode.postMessage({ type: 'ready' });
`;
