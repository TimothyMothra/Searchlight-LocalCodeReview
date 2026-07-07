/**
 * Files pane as a WebviewView (Phase C of the TreeView→Webview conversion).
 *
 * 1:1 behavioral parity with the former `FilesViewProvider` (src/filesView.ts):
 *   - hierarchical folder tree, folders-first then alphabetical, files nested under folders,
 *   - "Loading changes…" placeholder until the changed-files data resolves,
 *   - per-file checkbox bound to `review.reviewedFiles` (toggle persists via the store),
 *   - click a file row → `searchlight.openFileDiff` with the file's relPath,
 *   - expand-all via `setExpanded(true)` (host command `searchlight.filesExpandAll`).
 *
 * Icon gap: TreeItems get native file icons + git-status decoration colors for free; a webview
 * cannot. `getChangedFiles()` returns paths only (no per-file M/A/D/R status), so rows render a
 * generic inline-SVG file/folder glyph (no status letter — there is no status data to derive one
 * from, and adding a `--name-status` git op would risk the very perf regression this project tracks).
 *
 * This module NEVER calls a language model.
 */

import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { ReviewStatusBar } from './statusBar';
import * as store from './reviewStore';
import { webviewHtml, getNonce } from './webviewShell';
import { logBuild, logRendered, logFirstPaint, isRenderedMessage } from './webviewMetrics';

/** A folder node in the serializable tree sent to the webview. */
interface WireDir {
	name: string;
	relPath: string;
	dirs: WireDir[];
	files: WireFile[];
}

/** A file leaf in the serializable tree sent to the webview. */
interface WireFile {
	name: string;
	relPath: string;
	reviewed: boolean;
}

type IncomingMessage =
	| { type: 'ready' }
	| { type: 'toggleReviewed'; relPath: string }
	| { type: 'openFile'; relPath: string }
	| { type: 'rendered'; view: string; ms: number; count: number };

export class FilesWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private filesExpanded = false;

	// Mirror of filesView.ts loading state so we show "Loading changes…" once per comparison key.
	private paths: string[] = [];
	private loadedKey?: string;
	private loadingKey?: string;

	constructor(
		private readonly getActive: () => ActiveComparison | undefined,
		private readonly statusBar: ReviewStatusBar,
		private readonly refreshConversations: () => void,
	) {}

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
				case 'toggleReviewed':
					if (msg.relPath) {
						await this.onToggleReviewed(msg.relPath);
					}
					break;
				case 'openFile':
					if (msg.relPath) {
						await vscode.commands.executeCommand('searchlight.openFileDiff', msg.relPath);
					}
					break;
				default:
					if (isRenderedMessage(msg)) {
						logRendered(msg);
						logFirstPaint('files', tResolve);
					}
					break;
			}
		});
		void this.postState();
	}

	/** External refresh (called by refreshAll / after a checkbox toggle). */
	refresh(): void {
		void this.postState();
	}

	/** Expand-all (host command `searchlight.filesExpandAll`) / collapse. */
	setExpanded(value: boolean): void {
		this.filesExpanded = value;
		this.view?.webview.postMessage({ type: 'setExpanded', value });
	}

	/** Migrated from extension.ts's Files checkbox handler — toggle a file's reviewed state + persist. */
	private async onToggleReviewed(relPath: string): Promise<void> {
		const active = this.getActive();
		const review = active?.review;
		if (!review) {
			return;
		}
		review.reviewedFiles ??= [];
		const idx = review.reviewedFiles.indexOf(relPath);
		if (idx === -1) {
			review.reviewedFiles.push(relPath);
		} else {
			review.reviewedFiles.splice(idx, 1);
		}
		await store.saveReview(review);
		this.refresh();
		this.refreshConversations();
		void this.statusBar.update();
	}

	/** Build the current tree and push it to the webview (mirrors filesView.ts getChildren). */
	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const active = this.getActive();
		if (!active || !active.base || !active.compare) {
			this.view.webview.postMessage({ type: 'state', tree: null, expanded: this.filesExpanded });
			return;
		}

		// Same inline key form filesView.ts uses (ActiveComparison.pairKey is private).
		const key = `${active.baseCommit ?? active.base}...${active.compareCommit ?? active.compare}`;
		if (this.loadedKey !== key) {
			// Kick the async load exactly once per key, then show the loading placeholder.
			if (this.loadingKey !== key) {
				this.loadingKey = key;
				active
					.getChangedFiles()
					.then((paths) => {
						this.paths = paths;
						this.loadedKey = key;
						this.loadingKey = undefined;
						void this.postState();
					})
					.catch(() => {
						this.loadingKey = undefined;
					});
			}
			this.view.webview.postMessage({ type: 'state', loading: true, expanded: this.filesExpanded });
			return;
		}

		const tBuild = Date.now();
		const tree = this.buildTree(this.paths, active.review?.reviewedFiles ?? []);
		// count basis: filesView.ts's files.build counted ROOT rows; the webview builds the whole tree
		// at once, so count = total changed files (paths.length). See docs/metrics-baseline.md.
		const count = this.paths.length;
		logBuild('files', tBuild, count, tree);
		this.view.webview.postMessage({ type: 'state', tree, expanded: this.filesExpanded });
	}

	/**
	 * Split paths into a nested folder tree (folders-first, then alphabetical at each level) —
	 * the same shape filesView.ts's buildTree/renderLevel produced, but serializable.
	 */
	private buildTree(paths: string[], reviewedFiles: string[]): WireDir {
		const reviewed = new Set(reviewedFiles);
		const root: WireDir = { name: '', relPath: '', dirs: [], files: [] };

		for (const p of paths) {
			const segments = p.split('/');
			let node = root;
			// Interior segments → nested dirs.
			for (let i = 0; i < segments.length - 1; i++) {
				const name = segments[i];
				const relPath = node.relPath ? `${node.relPath}/${name}` : name;
				let child = node.dirs.find((d) => d.name === name);
				if (!child) {
					child = { name, relPath, dirs: [], files: [] };
					node.dirs.push(child);
				}
				node = child;
			}
			// Last segment → file leaf.
			const name = segments[segments.length - 1];
			node.files.push({ name, relPath: p, reviewed: reviewed.has(p) });
		}

		this.sortLevel(root);
		return root;
	}

	/** Recursively sort each level: folders first (localeCompare), then files (localeCompare). */
	private sortLevel(dir: WireDir): void {
		dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
		dir.files.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of dir.dirs) {
			this.sortLevel(child);
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		return webviewHtml({
			webview,
			nonce,
			viewName: 'files',
			bodyHtml: '<div id="rows"></div>',
			styleCss: FILES_CSS,
			scriptJs: FILES_JS,
		});
	}
}

/** Pane-specific CSS (theme vars come from the shared shell). */
const FILES_CSS = `
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
.twisty {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	justify-content: center;
	color: var(--vscode-icon-foreground);
	transition: transform 0.1s;
}
.twisty.spacer { visibility: hidden; }
.dir.collapsed > .row .twisty { transform: rotate(-90deg); }
.glyph {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: var(--vscode-icon-foreground);
}
.glyph svg { width: 16px; height: 16px; fill: currentColor; }
.label { overflow: hidden; text-overflow: ellipsis; }
.desc { color: var(--vscode-descriptionForeground); margin-left: 6px; font-size: 0.9em; }
.children { display: block; }
.dir.collapsed > .children { display: none; }
input.chk { margin: 0 2px 0 0; }
`;

/** Pane-specific script. The shared shell has already defined `vscode`, `reportRendered`, etc. */
const FILES_JS = `
const rows = document.getElementById('rows');

// Inline SVG glyphs (currentColor) — codicons aren't bundled, so no font is loaded.
const FILE_SVG = '<svg viewBox="0 0 16 16"><path d="M9.5 1H3.5L3 1.5v13l.5.5h9l.5-.5V5.5L9.5 1zm0 1.4L11.6 4.5H9.5V2.4zM4 14V2h4.5v3.5H12V14H4z"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 16 16"><path d="M14.5 3H7.7l-1-1H1.5L1 2.5v11l.5.5h13l.5-.5v-10L14.5 3zM14 13H2V3h4.3l1 1H14v9z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4V4z"/></svg>';

let expanded = new Set();      // relPaths of expanded folders
let expandAll = false;

function renderDir(dir) {
	const frag = document.createDocumentFragment();
	for (const d of dir.dirs) {
		const open = expandAll || expanded.has(d.relPath);
		const el = document.createElement('div');
		el.className = 'dir' + (open ? '' : ' collapsed');
		const row = document.createElement('div');
		row.className = 'row';
		row.innerHTML =
			'<span class="twisty">' + CHEVRON_SVG + '</span>' +
			'<span class="glyph">' + FOLDER_SVG + '</span>' +
			'<span class="label"></span>';
		row.querySelector('.label').textContent = d.name;
		row.addEventListener('click', () => {
			if (expanded.has(d.relPath)) { expanded.delete(d.relPath); }
			else { expanded.add(d.relPath); }
			expandAll = false;
			paint();
		});
		el.appendChild(row);
		const kids = document.createElement('div');
		kids.className = 'children';
		kids.appendChild(renderDir(d));
		el.appendChild(kids);
		frag.appendChild(el);
	}
	for (const f of dir.files) {
		const row = document.createElement('div');
		row.className = 'row file';
		const chk = document.createElement('input');
		chk.type = 'checkbox';
		chk.className = 'chk';
		chk.checked = !!f.reviewed;
		chk.title = 'Mark reviewed';
		chk.addEventListener('click', (e) => e.stopPropagation());
		chk.addEventListener('change', () => {
			vscode.postMessage({ type: 'toggleReviewed', relPath: f.relPath });
		});
		const twisty = document.createElement('span');
		twisty.className = 'twisty spacer';
		const glyph = document.createElement('span');
		glyph.className = 'glyph';
		glyph.innerHTML = FILE_SVG;
		const label = document.createElement('span');
		label.className = 'label';
		label.textContent = f.name;
		row.appendChild(twisty);
		row.appendChild(chk);
		row.appendChild(glyph);
		row.appendChild(label);
		row.addEventListener('click', () => {
			vscode.postMessage({ type: 'openFile', relPath: f.relPath });
		});
		frag.appendChild(row);
	}
	return frag;
}

let lastTree = null;

function paint() {
	const t0 = performance.now();
	rows.innerHTML = '';
	if (lastTree === undefined) {
		rows.innerHTML = '<div class="msg">Loading changes…</div>';
		reportRendered('files', 0, t0);
		return;
	}
	if (!lastTree || (lastTree.dirs.length === 0 && lastTree.files.length === 0)) {
		rows.innerHTML = '<div class="msg">No changes to review.</div>';
		reportRendered('files', 0, t0);
		return;
	}
	rows.appendChild(renderDir(lastTree));
	reportRendered('files', countFiles(lastTree), t0);
}

function countFiles(dir) {
	let n = dir.files.length;
	for (const d of dir.dirs) { n += countFiles(d); }
	return n;
}

window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'state') {
		if (m.loading) {
			lastTree = undefined;   // sentinel → "Loading changes…"
		} else {
			lastTree = m.tree;      // WireDir | null
		}
		if (typeof m.expanded === 'boolean') { expandAll = m.expanded; }
		paint();
	} else if (m.type === 'setExpanded') {
		expandAll = !!m.value;
		if (!m.value) { expanded.clear(); }
		paint();
	}
});

vscode.postMessage({ type: 'ready' });
`;
