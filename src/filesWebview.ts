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
 * cannot. To close that gap, `getChangedFiles()` returns per-file `{ relPath, status }` (the status
 * column comes free from upgrading the existing `git diff --name-only` to `--name-status` — same
 * single git op, no extra data-load, so `files.data-load` stays the apples-to-apples baseline).
 * Each file row renders a generic inline-SVG file glyph plus a status letter (M/A/D/R/C/U) and is
 * tinted with the matching `--vscode-gitDecoration-*ResourceForeground` theme color.
 *
 * This module NEVER calls a language model.
 */

import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { ReviewStatusBar } from './statusBar';
import * as store from './reviewStore';
import { webviewHtml, getNonce } from './webviewShell';
import { logBuild, logRendered, logFirstPaint, isRenderedMessage } from './webviewMetrics';
import { ChangedFile, UncommittedChanges, changedFilesUncommitted } from './git';

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
	/** Only meaningful for committed leaves (base…compare). Always false for uncommitted leaves. */
	reviewed: boolean;
	status: string;
	/** True → this leaf is a live working-tree change (staged/unstaged/untracked), not a committed diff. */
	uncommitted: boolean;
	/** Set only when `uncommitted` — drives the group-aware diff on click. */
	group?: UncommittedGroup;
}

/** Which uncommitted group a row belongs to (drives the diff sides in uc-3). */
type UncommittedGroup = 'staged' | 'unstaged' | 'untracked';

/**
 * A file after merging the committed (base…compare) set with the live uncommitted groups.
 * One entry per repo-relative path — see `mergeFiles` for the precedence order.
 */
interface MergedFile {
	relPath: string;
	status: string;
	uncommitted: boolean;
	group?: UncommittedGroup;
	reviewed: boolean;
}

type IncomingMessage =
	| { type: 'ready' }
	| { type: 'toggleReviewed'; relPath: string }
	| { type: 'toggleUncommitted' }
	| { type: 'openFile'; relPath: string }
	| { type: 'openUncommitted'; relPath: string; group: UncommittedGroup }
	| { type: 'rendered'; view: string; ms: number; count: number };

/** workspaceState key persisting the show/hide-uncommitted toggle across reloads (default false = shown). */
const HIDE_UNCOMMITTED_KEY = 'searchlight.files.hideUncommitted';

export class FilesWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private filesExpanded = false;

	// Mirror of filesView.ts loading state so we show "Loading changes…" once per comparison key.
	private paths: ChangedFile[] = [];
	private loadedKey?: string;
	private loadingKey?: string;

	constructor(
		private readonly getActive: () => ActiveComparison | undefined,
		private readonly statusBar: ReviewStatusBar,
		private readonly refreshConversations: () => void,
		private readonly workspaceState: vscode.Memento,
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
				case 'openUncommitted':
					if (msg.relPath) {
						await vscode.commands.executeCommand(
							'searchlight.openUncommittedFileDiff',
							msg.relPath,
							msg.group,
						);
					}
					break;
				case 'toggleUncommitted': {
					// Host state is authoritative: flip + persist, then re-post so the webview
					// restores from the stored flag rather than local guesswork.
					const next = !this.workspaceState.get<boolean>(HIDE_UNCOMMITTED_KEY, false);
					await this.workspaceState.update(HIDE_UNCOMMITTED_KEY, next);
					await this.postState();
					break;
				}
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
		const hideUncommitted = this.workspaceState.get<boolean>(HIDE_UNCOMMITTED_KEY, false);
		const active = this.getActive();
		if (!active || !active.base || !active.compare) {
			this.view.webview.postMessage({ type: 'state', tree: null, expanded: this.filesExpanded, hideUncommitted, ucHidden: 0 });
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
					.then((files) => {
						this.paths = files;
						this.loadedKey = key;
						this.loadingKey = undefined;
						void this.postState();
					})
					.catch(() => {
						this.loadingKey = undefined;
					});
			}
			this.view.webview.postMessage({ type: 'state', loading: true, expanded: this.filesExpanded, hideUncommitted, ucHidden: 0 });
			return;
		}

		// Uncommitted (staged/unstaged/untracked) is live working-tree state, independent of the
		// base...compare pair — load it fresh on every render so edits appear without a key change.
		const uc = await this.loadUncommitted(active);
		const tBuild = Date.now();
		const merged = mergeFiles(this.paths, uc, active.review?.reviewedFiles ?? []);
		const ucTotal = merged.reduce((n, f) => (f.uncommitted ? n + 1 : n), 0);
		// When hidden, drop uncommitted leaves entirely (folders that become empty simply aren't built).
		// NOTE: because "uncommitted wins" dedup collapses a file that is BOTH committed and edited into a
		// single uncommitted leaf, hiding uncommitted also hides that file's committed row. This is the
		// documented consequence of the locked precedence order (untracked > unstaged > staged > committed).
		const visible = hideUncommitted ? merged.filter((f) => !f.uncommitted) : merged;
		const tree = this.buildTree(visible);
		// count = merged visible leaves (respects the hide filter) — the whole tree is built at once.
		const count = visible.length;
		logBuild('files', tBuild, count, tree);
		const ucHidden = hideUncommitted ? ucTotal : 0;
		this.view.webview.postMessage({ type: 'state', tree, expanded: this.filesExpanded, hideUncommitted, ucHidden });
	}

	/**
	 * Load the live staged + unstaged + untracked changes for merging into the unified tree. These git
	 * ops run against the live index/worktree/HEAD, independent of the ActiveComparison base/compare
	 * shas. Returns the raw groups (not wire rows) so `mergeFiles` can weave them into the folder tree
	 * by path. Never throws — a git failure just yields empty groups.
	 */
	private async loadUncommitted(active: ActiveComparison): Promise<UncommittedChanges> {
		try {
			return await changedFilesUncommitted(active.repoRootFsPath);
		} catch {
			return { staged: [], unstaged: [], untracked: [] };
		}
	}

	/**
	 * Split merged files into a nested folder tree (folders-first, then alphabetical at each level) —
	 * the same shape filesView.ts's buildTree/renderLevel produced, but serializable.
	 */
	private buildTree(files: MergedFile[]): WireDir {
		const root: WireDir = { name: '', relPath: '', dirs: [], files: [] };

		for (const p of files) {
			const segments = p.relPath.split('/');
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
			node.files.push({
				name,
				relPath: p.relPath,
				reviewed: p.reviewed,
				status: p.status,
				uncommitted: p.uncommitted,
				group: p.group,
			});
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
			bodyHtml: '<div id="files-header"></div><div id="rows"></div>',
			styleCss: FILES_CSS,
			scriptJs: FILES_JS,
		});
	}
}

/**
 * Merge the committed (base…compare) changed files with the live uncommitted groups into ONE row per
 * repo-relative path. Precedence (total order, last wins): `untracked > unstaged > staged > committed`.
 * So a file that is both committed AND edited in the working tree shows once as its uncommitted row; a
 * file both staged and unstaged shows once as unstaged.
 *
 * // ASSUMPTION: unstaged > staged precedence is chosen because the working-tree version reflects the
 * // current on-disk state the user is looking at; the staged+unstaged overlap is rare. Flip the overlay
 * // order below (apply unstaged before staged) if you want staged to win instead.
 *
 * Reviewed state applies ONLY to committed leaves (it is a durable base…compare concept); uncommitted
 * leaves are transient and always `reviewed:false` (the client suppresses their checkbox).
 */
function mergeFiles(committed: ChangedFile[], uc: UncommittedChanges, reviewedFiles: string[]): MergedFile[] {
	const reviewed = new Set(reviewedFiles);
	const map = new Map<string, MergedFile>();
	// 1. committed base (lowest precedence)
	for (const f of committed) {
		map.set(f.relPath, { relPath: f.relPath, status: f.status, uncommitted: false, reviewed: reviewed.has(f.relPath) });
	}
	// 2..4. overlay uncommitted groups in ascending precedence — each overwrites the prior entry.
	const overlay = (files: ChangedFile[], group: UncommittedGroup): void => {
		for (const f of files) {
			map.set(f.relPath, { relPath: f.relPath, status: f.status, uncommitted: true, group, reviewed: false });
		}
	};
	overlay(uc.staged, 'staged');
	overlay(uc.unstaged, 'unstaged');
	overlay(uc.untracked, 'untracked');
	return [...map.values()];
}

/** Pane-specific CSS (theme vars come from the shared shell). */
const FILES_CSS = `
#rows { user-select: none; }
/* Header row hosting the show/hide-uncommitted toggle (mirrors the Conversations pane header). */
#files-header {
	display: flex;
	align-items: center;
	padding: 2px 12px 4px 12px;
	min-height: 22px;
}
#files-header:empty { display: none; }
.toggle-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	background: transparent;
	border: none;
	color: var(--vscode-descriptionForeground);
	cursor: pointer;
	padding: 2px 4px;
	border-radius: 4px;
	font: inherit;
	font-size: 0.9em;
}
.toggle-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
.toggle-btn svg { width: 14px; height: 14px; fill: currentColor; }
.uc-hint { margin-left: 6px; opacity: 0.7; font-size: 0.9em; }
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
/* Git-status letter badge (M/A/D/R/C/U/T), colored to match the row's decoration color. */
.status {
	margin-left: auto;
	padding-left: 8px;
	min-width: 12px;
	text-align: center;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.85em;
	opacity: 0.9;
}
/* Leading working-tree marker on uncommitted leaves (● colored by status). */
.uc-marker {
	width: 10px;
	min-width: 10px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 0.8em;
	line-height: 1;
}
/* Uncommitted leaves read italic (transient working-tree edit, not a durable committed diff). */
.file.uncommitted .label { font-style: italic; }
/* Per-status decoration colors (mirror VS Code's native SCM/file-explorer coloring). */
.file.st-M .label, .file.st-M .status, .file.st-M .uc-marker { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
.file.st-A .label, .file.st-A .status, .file.st-A .uc-marker { color: var(--vscode-gitDecoration-addedResourceForeground); }
.file.st-D .label, .file.st-D .status, .file.st-D .uc-marker { color: var(--vscode-gitDecoration-deletedResourceForeground); }
.file.st-R .label, .file.st-R .status, .file.st-R .uc-marker { color: var(--vscode-gitDecoration-renamedResourceForeground); }
.file.st-C .label, .file.st-C .status, .file.st-C .uc-marker { color: var(--vscode-gitDecoration-renamedResourceForeground); }
.file.st-U .label, .file.st-U .status, .file.st-U .uc-marker { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
.file.st-T .label, .file.st-T .status, .file.st-T .uc-marker { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
.children { display: block; }
.dir.collapsed > .children { display: none; }
input.chk { margin: 0 2px 0 0; }
`;

/** Pane-specific script. The shared shell has already defined `vscode`, `reportRendered`, etc. */
const FILES_JS = `
const filesHeader = document.getElementById('files-header');
const rows = document.getElementById('rows');

// Inline SVG glyphs (currentColor) — codicons aren't bundled, so no font is loaded.
const FILE_SVG = '<svg viewBox="0 0 16 16"><path d="M9.5 1H3.5L3 1.5v13l.5.5h9l.5-.5V5.5L9.5 1zm0 1.4L11.6 4.5H9.5V2.4zM4 14V2h4.5v3.5H12V14H4z"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 16 16"><path d="M14.5 3H7.7l-1-1H1.5L1 2.5v11l.5.5h13l.5-.5v-10L14.5 3zM14 13H2V3h4.3l1 1H14v9z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4V4z"/></svg>';
const EYE_SVG = '<svg viewBox="0 0 16 16"><path d="M8 3C4.5 3 1.7 5.1.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5C14.3 5.1 11.5 3 8 3zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 16 16"><path d="M13.5 2.5l-11 11 .7.7 2.2-2.2c.8.3 1.7.5 2.6.5 3.5 0 6.3-2.1 7.5-5a8.6 8.6 0 0 0-2.9-3.7l1.6-1.6-.7-.7zM8 11.3a3.3 3.3 0 0 1-2.3-5.6l1 1a2 2 0 0 0 2.6 2.6l1 1c-.6.4-1.4.6-2.3.6zM8 4.7c1.8 0 3.3 1.5 3.3 3.3 0 .5-.1.9-.3 1.3l1.5 1.5c.6-.6 1.1-1.3 1.5-2.1C12.3 5.6 10.4 4 8 4c-.6 0-1.2.1-1.8.3l1.2 1.2c.2 0 .4-.1.6-.1z"/></svg>';

let expanded = new Set();      // relPaths of expanded folders
let expandAll = false;
let lastTree = null;           // WireDir | null | undefined(sentinel → loading)
let hideUncommitted = false;   // host-authoritative; restored on first paint
let ucHidden = 0;              // count of uncommitted leaves the host filtered out

function renderHeader() {
	filesHeader.innerHTML = '';
	// Only offer the toggle when there is a tree to filter (avoids a lone control on an empty pane).
	const treeEmpty = !lastTree || (lastTree.dirs.length === 0 && lastTree.files.length === 0);
	if (lastTree === undefined || treeEmpty) { return; }
	const btn = document.createElement('button');
	btn.className = 'toggle-btn';
	btn.type = 'button';
	const glyph = hideUncommitted ? EYE_OFF_SVG : EYE_SVG;
	const label = hideUncommitted ? 'Show uncommitted' : 'Hide uncommitted';
	btn.innerHTML = glyph + '<span></span>';
	btn.querySelector('span').textContent = label;
	btn.title = label;
	btn.addEventListener('click', () => {
		vscode.postMessage({ type: 'toggleUncommitted' });
	});
	filesHeader.appendChild(btn);
	if (hideUncommitted && ucHidden > 0) {
		const hint = document.createElement('span');
		hint.className = 'uc-hint';
		hint.textContent = '(' + ucHidden + ' hidden)';
		filesHeader.appendChild(hint);
	}
}

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
		row.className = 'row file' + (f.status ? ' st-' + f.status : '') + (f.uncommitted ? ' uncommitted' : '');
		const twisty = document.createElement('span');
		twisty.className = 'twisty spacer';
		if (f.uncommitted) {
			// Uncommitted leaf: leading working-tree marker (● colored by status), NO reviewed checkbox
			// (reviewed is a durable base…compare concept; uncommitted files are transient).
			const marker = document.createElement('span');
			marker.className = 'uc-marker';
			marker.textContent = '\\u25CF';
			marker.title = 'Working-tree change (uncommitted)';
			const glyph = document.createElement('span');
			glyph.className = 'glyph';
			glyph.innerHTML = FILE_SVG;
			const label = document.createElement('span');
			label.className = 'label';
			label.textContent = f.name;
			row.appendChild(twisty);
			row.appendChild(marker);
			row.appendChild(glyph);
			row.appendChild(label);
			if (f.status) {
				const st = document.createElement('span');
				st.className = 'status';
				st.textContent = f.status;
				st.title = 'Git status: ' + f.status;
				row.appendChild(st);
			}
			row.addEventListener('click', () => {
				vscode.postMessage({ type: 'openUncommitted', relPath: f.relPath, group: f.group });
			});
		} else {
			// Committed leaf: reviewed checkbox + base…compare diff on click (unchanged behavior).
			const chk = document.createElement('input');
			chk.type = 'checkbox';
			chk.className = 'chk';
			chk.checked = !!f.reviewed;
			chk.title = 'Mark reviewed';
			chk.addEventListener('click', (e) => e.stopPropagation());
			chk.addEventListener('change', () => {
				vscode.postMessage({ type: 'toggleReviewed', relPath: f.relPath });
			});
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
			if (f.status) {
				const st = document.createElement('span');
				st.className = 'status';
				st.textContent = f.status;
				st.title = 'Git status: ' + f.status;
				row.appendChild(st);
			}
			row.addEventListener('click', () => {
				vscode.postMessage({ type: 'openFile', relPath: f.relPath });
			});
		}
		frag.appendChild(row);
	}
	return frag;
}

function paint() {
	const t0 = performance.now();
	renderHeader();
	rows.innerHTML = '';
	if (lastTree === undefined) {
		rows.innerHTML = '<div class="msg">Loading changes…</div>';
		reportRendered('files', 0, t0);
		return;
	}
	const treeEmpty = !lastTree || (lastTree.dirs.length === 0 && lastTree.files.length === 0);
	if (treeEmpty) {
		rows.innerHTML = '<div class="msg">No changes to review.</div>';
		reportRendered('files', 0, t0);
		return;
	}
	rows.appendChild(renderDir(lastTree));
	// Host already filtered hidden uncommitted leaves, so the tree = the visible leaf set.
	reportRendered('files', countFiles(lastTree), t0);
}

function countFiles(dir) {
	if (!dir) { return 0; }
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
		if (typeof m.hideUncommitted === 'boolean') { hideUncommitted = m.hideUncommitted; }
		ucHidden = typeof m.ucHidden === 'number' ? m.ucHidden : 0;
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
