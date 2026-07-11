/**
 * Conversations pane as a WebviewView (Phase E of the TreeView→Webview conversion).
 *
 * 1:1 behavioral parity with the former `ConversationsViewProvider` (src/conversationsView.ts):
 *   - one row per review thread (`Thread #NN  ·  filePath:line`), with a state + #tags description,
 *     a comment/check glyph, and resolved→collapsed / open→expanded default,
 *   - nested comment rows (`author: first line`), timestamp (+ model/version for agents) description,
 *     and an author glyph (hubot/account),
 *   - click a thread/comment row → `searchlight.openThreadLocation` (jump to file:line),
 *   - inline resolve / unresolve button per thread → `searchlight.resolveThreadNode` /
 *     `searchlight.unresolveThreadNode` (the native inline `view/item/context` menus don't apply to
 *     a webview, so the row button replaces them).
 *
 * Parity-PLUS: per-comment `#tag` badges (from `comment.tags`) are rendered here even though the
 * native TreeView did not surface them (explicitly requested for Phase E).
 *
 * Metrics parity: keeps `conversations.build` (host-side, this file — a pure in-memory thread map,
 * ~0ms) intact and adds `conversations.render` + `conversations.firstPaint` via the shared webview
 * metrics protocol.
 *
 * This module NEVER calls a language model.
 */

import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { authorDisplay, formatTimestamp, relocateAnchor, ReviewComment, ReviewThread } from './reviewModel';
import { webviewHtml, getNonce } from './webviewShell';
import { logBuild, logRendered, logFirstPaint, isRenderedMessage } from './webviewMetrics';

/** A comment row in the serializable payload sent to the webview. */
interface WireComment {
	name: string;
	iconId: string; // 'hubot' | 'account'
	firstLine: string;
	desc: string; // timestamp (+ model/version for agents)
	tags: string[];
}

/** A thread row in the serializable payload sent to the webview. */
interface WireThread {
	num: string; // seq (or index+1), zero-padded to 2 digits
	loc: string; // `filePath:line` or '(no file)'
	desc: string; // state + #tags text (mirrors the native description)
	resolved: boolean;
	threadId?: string;
	hasFile: boolean;
	filePath?: string;
	navStart: number; // startLine ?? 1
	navEnd: number; // endLine ?? startLine ?? 1
	drift?: 'relocated' | 'orphaned'; // uncommitted anchor moved (relocated) or vanished (orphaned)
	comments: WireComment[];
}

type IncomingMessage =
	| { type: 'ready' }
	| { type: 'navigate'; filePath: string; startLine: number; endLine: number }
	| { type: 'resolve'; threadId: string }
	| { type: 'unresolve'; threadId: string }
	| { type: 'toggleHideResolved' }
	| { type: 'rendered'; view: string; ms: number; count: number };

/** workspaceState key persisting the show/hide-resolved toggle across reloads. */
const HIDE_RESOLVED_KEY = 'searchlight.conversations.hideResolved';

export class ConversationsWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;

	constructor(
		private readonly getActive: () => ActiveComparison | undefined,
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
				case 'navigate':
					if (msg.filePath) {
						await vscode.commands.executeCommand(
							'searchlight.openThreadLocation',
							msg.filePath,
							msg.startLine,
							msg.endLine,
						);
					}
					break;
				case 'resolve':
					if (msg.threadId) {
						// The command handler reads only `node?.thread?.id`; a stub satisfies it.
						await vscode.commands.executeCommand('searchlight.resolveThreadNode', {
							thread: { id: msg.threadId },
						});
					}
					break;
				case 'unresolve':
					if (msg.threadId) {
						await vscode.commands.executeCommand('searchlight.unresolveThreadNode', {
							thread: { id: msg.threadId },
						});
					}
					break;
				case 'toggleHideResolved': {
					// Host state is authoritative: flip + persist, then re-post so the
					// webview restores from the stored flag rather than local guesswork.
					const next = !this.workspaceState.get<boolean>(HIDE_RESOLVED_KEY, false);
					await this.workspaceState.update(HIDE_RESOLVED_KEY, next);
					await this.postState();
					break;
				}
				default:
					if (isRenderedMessage(msg)) {
						logRendered(msg);
						logFirstPaint('conversations', tResolve);
					}
					break;
			}
		});
		void this.postState();
	}

	/** External refresh (called by refreshAll and the Files→Conversations refresh hook). */
	refresh(): void {
		void this.postState();
	}

	/** Build the current thread list and push it to the webview (mirrors conversationsView getChildren). */
	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const active = this.getActive();
		const review = active?.review;
		const hideResolved = this.workspaceState.get<boolean>(HIDE_RESOLVED_KEY, false);
		if (!review) {
			this.view.webview.postMessage({ type: 'state', threads: null, hideResolved });
			return;
		}

		// Root build — pure in-memory thread map (no git op), so ms is expected to be ~0.
		const tBuild = Date.now();
		// Per-postState cache so multiple threads in the same file read it once.
		const lineCache = new Map<string, string[] | null>();
		const wire: WireThread[] = [];
		for (let i = 0; i < review.threads.length; i++) {
			wire.push(await this.toWireThread(review.threads[i], i, lineCache));
		}
		logBuild('conversations', tBuild, wire.length, wire);
		this.view.webview.postMessage({ type: 'state', threads: wire, hideResolved });
	}

	/**
	 * Read the current lines of a repo-relative file (open doc or from disk), cached per postState.
	 * Never throws — returns null when the file can't be resolved/read (→ treated as orphaned).
	 */
	private async readFileLines(
		filePath: string,
		cache: Map<string, string[] | null>,
	): Promise<string[] | null> {
		if (cache.has(filePath)) {
			return cache.get(filePath)!;
		}
		let lines: string[] | null = null;
		try {
			const folders = vscode.workspace.workspaceFolders ?? [];
			if (folders.length > 0) {
				const uri = vscode.Uri.joinPath(folders[0].uri, ...filePath.split('/'));
				const doc = await vscode.workspace.openTextDocument(uri);
				lines = doc.getText().split(/\r?\n/);
			}
		} catch {
			lines = null;
		}
		cache.set(filePath, lines);
		return lines;
	}

	private async toWireThread(
		thread: ReviewThread,
		index: number,
		lineCache: Map<string, string[] | null>,
	): Promise<WireThread> {
		const num = String(thread.seq ?? index + 1).padStart(2, '0');
		const resolved = thread.state === 'resolved';

		const bits: string[] = [];
		if (thread.state) {
			bits.push(thread.state);
		}
		if (thread.tags.length > 0) {
			bits.push(thread.tags.map((t) => `#${t}`).join(' '));
		}

		let navStart = thread.startLine ?? 1;
		let navEnd = thread.endLine ?? thread.startLine ?? 1;
		let drift: 'relocated' | 'orphaned' | undefined;

		// Drift check for anchorText-bearing threads (uncommitted-file comments that may move as the
		// working tree changes). Only these pay the file read. `relocateAnchor` never throws.
		if (thread.anchorText && thread.filePath) {
			const lines = await this.readFileLines(thread.filePath, lineCache);
			if (lines === null) {
				// File missing/unreadable → the anchored line is gone.
				drift = 'orphaned';
			} else {
				const reloc = relocateAnchor(thread.anchorText, thread.startLine, lines);
				if (reloc.status === 'relocated') {
					drift = 'relocated';
					const span = navEnd - navStart;
					navStart = reloc.line;
					navEnd = navStart + Math.max(0, span);
				} else if (reloc.status === 'orphaned') {
					drift = 'orphaned';
				}
			}
		}

		const loc = thread.filePath ? `${thread.filePath}:${navStart}` : '(no file)';

		return {
			num,
			loc,
			desc: bits.join('  '),
			resolved,
			threadId: thread.id,
			hasFile: !!thread.filePath,
			filePath: thread.filePath,
			navStart,
			navEnd,
			drift,
			comments: thread.comments.map((c) => this.toWireComment(c)),
		};
	}

	private toWireComment(comment: ReviewComment): WireComment {
		const disp = authorDisplay(comment.author);
		const firstLine = comment.body.split('\n')[0] ?? '';
		const when = formatTimestamp(comment.timestamp);
		let desc: string;
		if (comment.author?.kind === 'agent') {
			const modelBits = [comment.author.model, comment.author.version].filter(Boolean);
			desc = [when, ...modelBits].filter(Boolean).join(' · ');
		} else {
			// Never leak the raw lowercase kind string to the description.
			desc = when;
		}
		return {
			name: disp.name,
			iconId: disp.iconId,
			firstLine,
			desc,
			tags: comment.tags ?? [],
		};
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		return webviewHtml({
			webview,
			nonce,
			viewName: 'conversations',
			bodyHtml: '<div id="conv-header"></div><div id="rows"></div>',
			styleCss: CONVERSATIONS_CSS,
			scriptJs: CONVERSATIONS_JS,
		});
	}
}

/** Pane-specific CSS (theme vars come from the shared shell). */
const CONVERSATIONS_CSS = `
#rows { user-select: none; }
/* Header row hosting the show/hide-resolved toggle. */
#conv-header {
	display: flex;
	align-items: center;
	padding: 2px 12px 4px 12px;
	min-height: 22px;
}
#conv-header:empty { display: none; }
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
.resolved-hint { margin-left: 6px; opacity: 0.7; font-size: 0.9em; }
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
.row:hover .action { visibility: visible; }
.twisty {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	justify-content: center;
	color: var(--vscode-icon-foreground);
	transition: transform 0.1s;
}
.twisty.spacer { visibility: hidden; }
.thread.collapsed > .row .twisty { transform: rotate(-90deg); }
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
.desc { color: var(--vscode-descriptionForeground); margin-left: 6px; font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; }
.tags { display: inline-flex; gap: 4px; margin-left: 6px; flex: 0 0 auto; }
.tag {
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	border-radius: 4px;
	padding: 0 6px;
	font-size: 0.85em;
	line-height: 16px;
}
.action {
	margin-left: auto;
	padding-left: 8px;
	visibility: hidden;
	color: var(--vscode-icon-foreground);
	display: inline-flex;
	align-items: center;
}
.action svg { width: 14px; height: 14px; fill: currentColor; }
.children { display: block; }
.thread.collapsed > .children { display: none; }
.crow { padding-left: 20px; color: var(--vscode-foreground); }
/* Drifted (uncommitted anchor moved/vanished) threads: dim the thread + its comments. */
.thread.drifted > .row .label,
.thread.drifted > .row .desc,
.thread.drifted > .children { opacity: 0.6; }
.drift-badge {
	margin-left: 6px;
	flex: 0 0 auto;
	background: var(--vscode-editorWarning-foreground, var(--vscode-badge-background));
	color: var(--vscode-editor-background, var(--vscode-badge-foreground));
	border-radius: 4px;
	padding: 0 6px;
	font-size: 0.8em;
	line-height: 16px;
	opacity: 0.9;
}
`;

/** Pane-specific script. The shared shell has already defined `vscode`, `reportRendered`, etc. */
const CONVERSATIONS_JS = `
const rows = document.getElementById('rows');
const convHeader = document.getElementById('conv-header');

// Inline SVG glyphs (currentColor) — codicons aren't bundled, so no font is loaded.
const COMMENT_SVG = '<svg viewBox="0 0 16 16"><path d="M2 2h12l1 1v8l-1 1H6l-3 3v-3H2l-1-1V3l1-1zm0 1v8h2v2l2-2h8V3H2z"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 16 16"><path d="M13.5 3.5l-8 8L2 8l1-1 2.5 2.5L12.5 2.5z"/></svg>';
const HUBOT_SVG = '<svg viewBox="0 0 16 16"><path d="M5 2h1v2h4V2h1v2h1.5L14 5.5V13l-1 1H3l-1-1V5.5L3.5 4H5V2zM4 6.5V13h8V6.5L11.5 6h-7L4 6.5zM6 8.5a1 1 0 110 2 1 1 0 010-2zm4 0a1 1 0 110 2 1 1 0 010-2z"/></svg>';
const ACCOUNT_SVG = '<svg viewBox="0 0 16 16"><path d="M8 2a3 3 0 100 6 3 3 0 000-6zm0 1a2 2 0 110 4 2 2 0 010-4zM3 14v-1c0-2 2.2-3 5-3s5 1 5 3v1h-1v-1c0-1.3-1.7-2-4-2s-4 .7-4 2v1H3z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4V4z"/></svg>';
const SLASH_SVG = '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1a7 7 0 100 14A7 7 0 008 1zM2 8a6 6 0 019.75-4.66L3.34 11.75A5.97 5.97 0 012 8zm2.25 4.66A6 6 0 0014 8a5.97 5.97 0 00-1.34-3.75l-8.41 8.41z"/></svg>';
// Eye / eye-off for the show/hide-resolved toggle.
const EYE_SVG = '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 3C4.5 3 1.7 5.1 0.5 8 1.7 10.9 4.5 13 8 13s6.3-2.1 7.5-5C14.3 5.1 11.5 3 8 3zm0 1c2.9 0 5.3 1.6 6.4 4-1.1 2.4-3.5 4-6.4 4S2.7 10.4 1.6 8C2.7 5.6 5.1 4 8 4zm0 1.5A2.5 2.5 0 108 10.5 2.5 2.5 0 008 5.5zm0 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M2.7 1.7l-1 1 2.2 2.2C2.5 5.8 1.4 6.8 0.5 8 1.7 10.9 4.5 13 8 13c1.3 0 2.6-.3 3.7-.8l2.6 2.6 1-1L2.7 1.7zM8 4c2.9 0 5.3 1.6 6.4 4-.5 1.1-1.3 2-2.3 2.7L10.7 9.3A2.5 2.5 0 007.7 5.3L6.4 4.1C6.9 4 7.4 4 8 4zM1.6 8C2.3 6.5 3.4 5.4 4.6 4.7l1.5 1.5A2.5 2.5 0 008.8 9l1.3 1.3c-.7.2-1.4.3-2.1.3-2.9 0-5.3-1.6-6.4-4z"/></svg>';

let threads = null;                 // WireThread[] | null
let hideResolved = false;           // host-authoritative toggle state (restored from state payload)
const threadOpen = new Map();       // thread key → bool (user override of default open state)

function renderComment(c, t) {
	const row = document.createElement('div');
	row.className = 'row crow';
	const glyph = c.iconId === 'hubot' ? HUBOT_SVG : ACCOUNT_SVG;
	row.innerHTML =
		'<span class="twisty spacer"></span>' +
		'<span class="glyph">' + glyph + '</span>' +
		'<span class="label"></span>' +
		'<span class="tags"></span>' +
		'<span class="desc"></span>';
	row.querySelector('.label').textContent = c.name + ': ' + c.firstLine;
	row.querySelector('.desc').textContent = c.desc;
	const tagsEl = row.querySelector('.tags');
	for (const tag of (c.tags || [])) {
		const b = document.createElement('span');
		b.className = 'tag';
		b.textContent = '#' + tag;
		tagsEl.appendChild(b);
	}
	if (t.hasFile) {
		row.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'navigate', filePath: t.filePath, startLine: t.navStart, endLine: t.navEnd });
		});
	}
	return row;
}

function renderThread(t) {
	const key = t.threadId || t.num;
	const open = threadOpen.has(key) ? threadOpen.get(key) : !t.resolved;
	const el = document.createElement('div');
	el.className = 'thread' + (open ? '' : ' collapsed') + (t.drift ? ' drifted' : '');

	const row = document.createElement('div');
	row.className = 'row';
	const glyph = t.resolved ? CHECK_SVG : COMMENT_SVG;
	// Only offer resolve/unresolve when we have a thread id to target.
	const actionType = t.resolved ? 'unresolve' : 'resolve';
	const actionSvg = t.resolved ? SLASH_SVG : CHECK_SVG;
	const actionTitle = t.resolved ? 'Unresolve thread' : 'Resolve thread';
	const actionHtml = t.threadId
		? '<span class="action" title="' + actionTitle + '">' + actionSvg + '</span>'
		: '';
	const driftHtml = t.drift
		? '<span class="drift-badge" title="This comment is anchored to an uncommitted change and may move or be lost as the working tree changes.">uncommitted — may drift</span>'
		: '';
	row.innerHTML =
		'<span class="twisty">' + CHEVRON_SVG + '</span>' +
		'<span class="glyph">' + glyph + '</span>' +
		'<span class="label"></span>' +
		'<span class="desc"></span>' +
		driftHtml +
		actionHtml;
	row.querySelector('.label').textContent = 'Thread #' + t.num + '  ·  ' + t.loc;
	row.querySelector('.desc').textContent = t.desc;
	row.querySelector('.twisty').addEventListener('click', (e) => {
		e.stopPropagation();
		threadOpen.set(key, !open);
		paint();
	});
	const action = row.querySelector('.action');
	if (action) {
		action.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: actionType, threadId: t.threadId });
		});
	}
	if (t.hasFile) {
		row.addEventListener('click', () => {
			vscode.postMessage({ type: 'navigate', filePath: t.filePath, startLine: t.navStart, endLine: t.navEnd });
		});
	}
	el.appendChild(row);

	const kids = document.createElement('div');
	kids.className = 'children';
	for (const c of t.comments) {
		kids.appendChild(renderComment(c, t));
	}
	el.appendChild(kids);
	return el;
}

function renderHeader(resolvedHiddenCount) {
	convHeader.innerHTML = '';
	// Only offer the toggle when there is a real thread list to filter.
	if (!threads || threads.length === 0) {
		return;
	}
	const btn = document.createElement('button');
	btn.className = 'toggle-btn';
	btn.type = 'button';
	const glyph = hideResolved ? EYE_OFF_SVG : EYE_SVG;
	const text = hideResolved ? 'Show resolved' : 'Hide resolved';
	btn.innerHTML = '<span class="glyph">' + glyph + '</span><span class="toggle-label"></span>';
	btn.querySelector('.toggle-label').textContent = text;
	btn.title = text;
	btn.addEventListener('click', () => {
		// Host is authoritative: it flips + persists + re-posts state.
		vscode.postMessage({ type: 'toggleHideResolved' });
	});
	convHeader.appendChild(btn);
	if (hideResolved && resolvedHiddenCount > 0) {
		const hint = document.createElement('span');
		hint.className = 'resolved-hint';
		hint.textContent = '(' + resolvedHiddenCount + ' resolved hidden)';
		convHeader.appendChild(hint);
	}
}

function paint() {
	const t0 = performance.now();
	rows.innerHTML = '';
	if (threads === undefined) {
		convHeader.innerHTML = '';
		rows.innerHTML = '<div class="msg">Loading conversations…</div>';
		reportRendered('conversations', 0, t0);
		return;
	}
	if (!threads || threads.length === 0) {
		convHeader.innerHTML = '';
		rows.innerHTML = '<div class="msg">No conversations in this review.</div>';
		reportRendered('conversations', 0, t0);
		return;
	}
	// Host sends every thread; the client hides resolved ones when the toggle is on.
	const visible = hideResolved ? threads.filter((t) => !t.resolved) : threads;
	const resolvedHiddenCount = threads.length - visible.length;
	renderHeader(resolvedHiddenCount);
	if (visible.length === 0) {
		rows.innerHTML = '<div class="msg">All conversations are resolved and hidden.</div>';
		reportRendered('conversations', 0, t0);
		return;
	}
	const frag = document.createDocumentFragment();
	for (const t of visible) {
		frag.appendChild(renderThread(t));
	}
	rows.appendChild(frag);
	reportRendered('conversations', visible.length, t0);
}

window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'state') {
		threads = m.threads;            // WireThread[] | null
		hideResolved = !!m.hideResolved;
		paint();
	}
});

vscode.postMessage({ type: 'ready' });
`;
