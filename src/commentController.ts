/**
 * Native `vscode.comments` integration for Searchlight.
 *
 * Renders every thread from every `.vscode/searchlight-reviews/<src>_<tgt>/comments.json` as an
 * inline VS Code comment thread anchored at `filePath:startLine`. Supports:
 *   - replying (writes a v2 comment with `replyTo`),
 *   - starting a brand-new thread on any line (writes a v2 thread),
 *   - resolve / unresolve (updates thread `state`),
 *   - `/tag` tokens in the reply box → merged into the thread's `tags[]` on submit.
 *
 * The controller re-renders from disk on demand (see `render`), so the file watcher in
 * extension.ts can call it after any external change (including this extension's own writes and
 * the `copilot` CLI shell-out). It NEVER calls a model — model work happens only via the terminal
 * shell-out wired in extension.ts.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { authorDisplay, Review, ReviewComment, ReviewThread } from './reviewModel';
import * as store from './reviewStore';
import { getGitUserName } from './git';
import type { ActiveComparison } from './activeComparison';
import { perf, perfLine } from './perf';

/** Links a live VS Code thread back to its backing model (which review file + which thread id). */
interface Binding {
	reviewFile: string;
	threadId: string;
	reviewDir: string;
}

/** A live thread + its binding + signatures, keyed for reconciliation across renders. */
interface Rendered {
	vsThread: vscode.CommentThread;
	binding: Binding;
	/** Signature of everything EXCEPT resolved-state (structure/content). */
	structSig: string;
	/** Tracked separately so a resolve/unresolve is an in-place update, not a dispose+recreate. */
	state: ReviewThread['state'];
}

/** Default tag set; overridable via the `searchlight.tags` setting. */
const DEFAULT_TAGS = ['idea', 'question', 'bug', 'change', 'todo', 'nit', 'praise'];

/**
 * Trailing debounce window for render(). 200ms is imperceptible to the user but collapses the
 * two dominant sources of redundant reconciles into a single doRender():
 *   1. the comments.json file watcher echoing THIS extension's own writes (VS Code frequently
 *      fires onDidChange ~2x per write), and
 *   2. the ~15 refreshAll() call sites (every command handler) each calling render().
 * Without this, a single interaction burst logged 5–7 zero-churn `comments.render` reconciles,
 * each 250–840ms of git-backed work. A trailing timer means the LAST call in a burst wins and
 * only one reconcile runs after the burst settles.
 */
const RENDER_DEBOUNCE_MS = 200;

export class SearchlightCommentController implements vscode.Disposable {
	private readonly controller: vscode.CommentController;
	/** Live threads keyed by `${reviewFile}::${threadId}` for cross-render reconciliation. */
	private readonly rendered = new Map<string, Rendered>();
	/** Reverse lookup: live thread → its model binding. Rebuilt during each reconcile. */
	private readonly bindings = new Map<vscode.CommentThread, Binding>();
	private readonly disposables: vscode.Disposable[] = [];

	/** How many times doRender() has actually run (perf evidence for the flashing investigation). */
	private renderCount = 0;
	/** Whether threads have been materialized yet (deferral gate). */
	private materialized = false;
	/** Whether the deferred-materialize triggers are already armed (idempotent). */
	private deferArmed = false;
	/** Disposables for the deferred-materialize triggers (torn down once materialized). */
	private readonly deferDisposables: vscode.Disposable[] = [];

	/** In-flight reconcile promise; serializes concurrent doRender() calls (anti-duplicate guard). */
	private renderInFlight: Promise<void> | null = null;
	/** Set when a render is requested while one is already running; triggers exactly one re-run. */
	private renderQueued = false;

	/**
	 * Trailing debounce timer for render(). Multiple render()/materialize calls within
	 * RENDER_DEBOUNCE_MS collapse into a single trailing doRender(). See RENDER_DEBOUNCE_MS.
	 */
	private renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly getActive: () => ActiveComparison | undefined = () => undefined) {
		this.controller = vscode.comments.createCommentController(
			'searchlight',
			'Searchlight Reviews',
		);
		// Greyed-out placeholder in BOTH the new-thread and reply input boxes. Setting it on the
		// controller's `options` covers every thread the controller owns, so it reminds the user of
		// the `/tag` autocomplete (see tagCompletion.ts) without any extra helper UI.
		this.controller.options = {
			placeHolder: 'Type / to add tags (idea, question, bug, change, todo)…',
			prompt: 'Type / to add tags (idea, question, bug, change, todo)…',
		};
		// Allow starting a new comment thread on any line of any file.
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: (document) => {
				const last = Math.max(0, document.lineCount - 1);
				return [new vscode.Range(0, 0, last, 0)];
			},
		};
		this.disposables.push(this.controller);
	}

	dispose(): void {
		if (this.renderDebounceTimer) {
			clearTimeout(this.renderDebounceTimer);
			this.renderDebounceTimer = null;
		}
		this.clearThreads();
		for (const d of this.deferDisposables) {
			d.dispose();
		}
		this.deferDisposables.length = 0;
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	/** Configured tag set (falls back to the core set). */
	private configuredTags(): string[] {
		const raw = vscode.workspace
			.getConfiguration('searchlight')
			.get<string[]>('tags', DEFAULT_TAGS);
		return Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_TAGS;
	}

	private clearThreads(): void {
		for (const r of this.rendered.values()) {
			r.vsThread.dispose();
		}
		this.rendered.clear();
		this.bindings.clear();
	}

	/** Whether thread materialization should be deferred off the activation critical path. */
	private shouldDefer(): boolean {
		return vscode.workspace
			.getConfiguration('searchlight')
			.get<boolean>('deferThreadsOnLoad', true);
	}

	/**
	 * Rebuild every inline thread from disk. Safe to call repeatedly (idempotent) — reconciles
	 * against live threads instead of disposing+recreating everything, so unchanged threads never
	 * flash. When `searchlight.deferThreadsOnLoad` is on and threads haven't been materialized yet,
	 * the first render is deferred off the activation path (see `armDeferredMaterialize`).
	 */
	async render(): Promise<void> {
		if (!this.materialized && this.shouldDefer()) {
			this.armDeferredMaterialize();
			perfLine(`comments.render deferred (materialized=false, call skipped)`);
			return;
		}
		this.materialized = true;
		this.scheduleRender();
	}

	/**
	 * Schedule a single trailing reconcile, coalescing bursty callers. Flips `materialized`
	 * synchronously (so the defer gate is satisfied immediately) then (re)arms one trailing timer.
	 * Every caller that wants a reconcile — render(), the deferred-materialize trigger, and the
	 * user-action paths (resolve/reply via render()) — routes through here so a burst collapses to
	 * one doRender(). 200ms trailing keeps a user resolve prompt (applyThreadState already updates
	 * widget state in place, so the visible flip is immediate; the timer only defers the disk-backed
	 * reconcile).
	 */
	private scheduleRender(): void {
		this.materialized = true;
		if (this.renderDebounceTimer) {
			clearTimeout(this.renderDebounceTimer);
		}
		this.renderDebounceTimer = setTimeout(() => {
			this.renderDebounceTimer = null;
			void this.doRender();
		}, RENDER_DEBOUNCE_MS);
	}

	/**
	 * Arm the deferred-materialize triggers exactly once: materialize on the first visible-editor
	 * change (i.e. the user actually looking at a file) or after a short settle timeout, whichever
	 * comes first. Keeps thread churn off the activation critical path.
	 */
	private armDeferredMaterialize(): void {
		if (this.deferArmed) {
			return;
		}
		this.deferArmed = true;
		const trigger = () => {
			if (this.materialized) {
				return;
			}
			this.materialized = true;
			for (const d of this.deferDisposables) {
				d.dispose();
			}
			this.deferDisposables.length = 0;
			this.scheduleRender();
		};
		this.deferDisposables.push(vscode.window.onDidChangeVisibleTextEditors(() => trigger()));
		const timer = setTimeout(trigger, 1200);
		this.deferDisposables.push({ dispose: () => clearTimeout(timer) });
	}

	/**
	 * The actual reconcile: diff the desired set of threads (from disk) against the live set.
	 * Threads whose content signature is unchanged are left untouched (no flash); only added,
	 * removed, or genuinely-changed threads are created/disposed.
	 *
	 * Serialized: only one reconcile runs at a time. A render requested while one is in flight sets
	 * `renderQueued` so exactly one follow-up reconcile runs afterwards. This prevents two
	 * interleaved calls (defer trigger racing a file-watcher refresh) from both passing the initial
	 * `await store.scanReviews()` with the same stale live-thread map and each calling
	 * `createCommentThread()` for the same key — the cause of duplicate threads at one anchor.
	 */
	private async doRender(): Promise<void> {
		if (this.renderInFlight) {
			this.renderQueued = true;
			return this.renderInFlight;
		}
		this.renderInFlight = this._doRenderOnce();
		try {
			await this.renderInFlight;
		} finally {
			this.renderInFlight = null;
		}
		if (this.renderQueued) {
			this.renderQueued = false;
			await this.doRender();
		}
	}

	/** One reconcile pass. Never call directly — go through `doRender()` for serialization. */
	private async _doRenderOnce(): Promise<void> {
		const t = Date.now();
		this.renderCount++;
		const reviews = await store.scanReviews();

		// Build the desired set: key → {review, thread, index}.
		const desired = new Map<string, { review: Review; thread: ReviewThread; index: number }>();
		for (const review of reviews) {
			review.threads.forEach((thread, index) => {
				if (!thread.filePath || !thread.id) {
					return;
				}
				desired.set(this.key(review.sourceFile, thread.id), { review, thread, index });
			});
		}

		let created = 0;
		let updated = 0;
		let removed = 0;
		let kept = 0;

		// Remove live threads no longer present on disk.
		for (const [k, r] of [...this.rendered]) {
			if (!desired.has(k)) {
				this.bindings.delete(r.vsThread);
				r.vsThread.dispose();
				this.rendered.delete(k);
				removed++;
			}
		}

		// Create / update / keep the desired threads.
		for (const [k, d] of desired) {
			const structSig = this.threadStructSig(d.thread);
			const state = d.thread.state;
			const existing = this.rendered.get(k);
			if (existing && existing.structSig === structSig) {
				if (existing.state === state) {
					kept++;
					continue; // unchanged — leave the live thread exactly as-is (no churn)
				}
				// ONLY resolved-state changed: update the live thread IN PLACE (state, collapsible,
				// label) instead of dispose+recreate. This eliminates the flash the user reported and
				// guarantees the in-thread Resolve/Reopen button reflects the new state immediately.
				this.applyThreadState(existing.vsThread, d.thread, d.index);
				existing.state = state;
				updated++;
				continue;
			}
			if (existing) {
				this.bindings.delete(existing.vsThread);
				existing.vsThread.dispose();
				this.rendered.delete(k);
				updated++;
			} else {
				created++;
			}
			const vsThread = this.buildThread(d.thread, d.index);
			if (!vsThread) {
				continue;
			}
			const binding: Binding = {
				reviewFile: d.review.sourceFile,
				threadId: d.thread.id!,
				reviewDir: path.dirname(d.review.sourceFile),
			};
			this.bindings.set(vsThread, binding);
			this.rendered.set(k, { vsThread, binding, structSig, state });
		}

		perf(
			'comments.render',
			t,
			`call #${this.renderCount}, +${created} ~${updated} -${removed} =${kept}`,
		);
	}

	private key(reviewFile: string, threadId: string): string {
		return `${reviewFile}::${threadId}`;
	}

	/**
	 * A stable STRUCTURE/CONTENT signature — everything except resolved-state. When it changes the
	 * live thread is rebuilt; a state-only change is handled in place (see applyThreadState).
	 */
	private threadStructSig(thread: ReviewThread): string {
		return JSON.stringify({
			f: thread.filePath,
			s: thread.startLine,
			e: thread.endLine,
			sq: thread.seq,
			tg: thread.tags,
			c: thread.comments.map((c) => [
				c.id,
				c.body,
				c.author?.name,
				c.author?.kind,
				c.timestamp,
			]),
		});
	}

	/**
	 * Apply resolved-state to a live thread: VS Code thread state, collapsible state, and label.
	 * Shared by buildThread (initial) and the reconcile in-place path (resolve/unresolve), so the
	 * in-thread Resolve/Reopen button and the Conversations pane always agree without a rebuild.
	 */
	private applyThreadState(
		vsThread: vscode.CommentThread,
		thread: ReviewThread,
		index: number,
	): void {
		vsThread.label = this.threadLabel(thread, index);
		vsThread.state =
			thread.state === 'resolved'
				? vscode.CommentThreadState.Resolved
				: vscode.CommentThreadState.Unresolved;
		vsThread.collapsibleState =
			thread.state === 'resolved'
				? vscode.CommentThreadCollapsibleState.Collapsed
				: vscode.CommentThreadCollapsibleState.Expanded;
	}

	/** Build a live VS Code thread for a model thread (no bookkeeping — caller records it). */
	private buildThread(thread: ReviewThread, index: number): vscode.CommentThread | undefined {
		if (!thread.filePath || !thread.id) {
			return undefined;
		}
		const fileUri = this.resolveFilePath(thread.filePath);
		if (!fileUri) {
			return undefined;
		}
		const line = Math.max(0, (thread.startLine ?? 1) - 1);
		const endLine = Math.max(line, (thread.endLine ?? thread.startLine ?? 1) - 1);
		const range = new vscode.Range(line, 0, endLine, 0);

		const vsThread = this.controller.createCommentThread(
			fileUri,
			range,
			thread.comments.map((c) => this.toComment(c)),
		);
		vsThread.canReply = true;
		vsThread.contextValue = 'searchlight.commentThread';
		this.applyThreadState(vsThread, thread, index);
		return vsThread;
	}

	private threadLabel(thread: ReviewThread, index: number): string {
		const bits: string[] = [];
		const num = String(thread.seq ?? index + 1).padStart(2, '0');
		bits.push(`Thread #${num}`);
		if (thread.tags.length > 0) {
			bits.push(thread.tags.map((t) => `#${t}`).join(' '));
		}
		bits.push(thread.state === 'resolved' ? '✓ resolved' : 'unresolved');
		return bits.join('  ·  ');
	}

	private toComment(model: ReviewComment): vscode.Comment {
		const a = model.author;
		const disp = authorDisplay(a);
		const detailBits = [a?.model, a?.version].filter(Boolean);
		let authorName = detailBits.length > 0 ? `${disp.name} (${detailBits.join(' · ')})` : disp.name;
		// Render per-comment tags as a compact `#tag` badge right on the comment the user tagged.
		if (model.tags && model.tags.length > 0) {
			authorName += '  ' + model.tags.map((t) => `#${t}`).join(' ');
		}
		return {
			body: new vscode.MarkdownString(model.body),
			mode: vscode.CommentMode.Preview,
			author: {
				name: authorName,
				// ASSUMPTION: @types/vscode 1.85 types iconPath as Uri only; ThemeIcon is accepted at
				// runtime (and by later type defs). Cast keeps the nice hubot/account glyphs.
				iconPath: new vscode.ThemeIcon(disp.iconId) as unknown as vscode.Uri,
			},
			contextValue: a?.kind ?? 'unknown',
			timestamp: model.timestamp ? new Date(model.timestamp) : undefined,
		};
	}

	/** Resolve a repo-relative filePath against the workspace folders. */
	private resolveFilePath(filePath: string): vscode.Uri | undefined {
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			const candidate = vscode.Uri.joinPath(folder.uri, ...filePath.split('/'));
			return candidate; // first workspace folder wins (single-root is the common case)
		}
		return undefined;
	}

	// ── Command handlers (wired from extension.ts) ─────────────────────────────

	/**
	 * Reply box submit. If the thread is bound to a model thread, append a reply; otherwise the
	 * user started a new thread on a line — create one in the review file for this workspace.
	 * `/tag` tokens in the text are extracted and merged into the thread's tags[].
	 */
	async handleReply(reply: vscode.CommentReply): Promise<void> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const name = (await getGitUserName(cwd)) ?? 'user';
		const author = store.humanAuthor(name);
		const { body, tags } = this.extractTags(reply.text);

		// Reject whitespace-only (or tag-only) bodies — never persist an empty comment/thread.
		if (body.trim().length === 0) {
			reply.thread.dispose();
			vscode.window.setStatusBarMessage('Searchlight: empty comment ignored.', 2000);
			return;
		}

		const binding = this.bindings.get(reply.thread);
		if (binding) {
			const review = await store.loadReview(vscode.Uri.file(binding.reviewFile));
			if (!review) {
				return;
			}
			store.addReply(review, binding.threadId, undefined, body, author, tags);
			if (tags.length > 0) {
				store.addThreadTags(review, binding.threadId, tags);
			}
			await store.saveReview(review);
		} else {
			await this.createNewThread(reply, body, author, tags);
		}
		reply.thread.dispose();
		this.materialized = true;
		await this.render();
	}

	/** Create a new review thread from a reply on an unbound (freshly started) thread. */
	private async createNewThread(
		reply: vscode.CommentReply,
		body: string,
		author: ReturnType<typeof store.humanAuthor>,
		tags: string[],
	): Promise<void> {
		// Defensive: callers already reject empty bodies, but never create an empty thread.
		if (body.trim().length === 0) {
			return;
		}
		const reviews = await store.scanReviews();
		// Prefer the currently-viewed comparison's review (its emptyReview() always has a valid
		// sourceFile) so the first-ever comment lands even before any comments.json exists on disk.
		const active = this.getActive?.();
		const review = active?.review ?? reviews[0];
		if (!review) {
			vscode.window.showWarningMessage(
				'Searchlight: no review target found. Open a comparison or create .vscode/searchlight-reviews/<src>_<tgt>/comments.json first.',
			);
			return;
		}
		// Note when the target differs from a single on-disk review (multiple files present).
		if (!active?.review && reviews.length > 1) {
			vscode.window.showInformationMessage(
				`Searchlight: added the new thread to ${path.basename(path.dirname(review.sourceFile))}.`,
			);
		}
		const rel = this.toWorkspaceRelative(reply.thread.uri);
		// CommentThread.range can be undefined (e.g. file-level threads); default to line 1.
		const range = reply.thread.range;
		const startLine = range ? range.start.line + 1 : 1;
		const endLine = range ? range.end.line + 1 : 1;
		// Compute seq against the authoritative on-disk review so a transiently-emptied
		// active.review (watcher-triggered resolve() racing a mid-flight write) can't reset
		// the #NN counter and collide (the #01-reused bug).
		let target = review;
		if (review.sourceFile) {
			const fresh = await store.loadReview(vscode.Uri.file(review.sourceFile));
			if (fresh) {
				fresh.sourceFile = review.sourceFile;
				if (!fresh.reviewedFiles) { fresh.reviewedFiles = []; }
				target = fresh;
			}
		}
		// Capture the trimmed text of the anchored line so uncommitted-file threads can be
		// relocated when the working tree drifts (uc-5). Best-effort: never block thread creation.
		let anchorText: string | undefined;
		if (range) {
			try {
				const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
				const lineIdx = range.start.line;
				if (lineIdx >= 0 && lineIdx < doc.lineCount) {
					const t = doc.lineAt(lineIdx).text.trim();
					if (t.length > 0) { anchorText = t; }
				}
			} catch {
				// Non-file scheme or unreadable document: leave anchorText undefined.
			}
		}
		store.addThread(target, rel, startLine, endLine, body, author, tags, anchorText);
		await store.saveReview(target);
		// Keep the active in-memory review authoritative post-write so the NEXT thread's seq
		// is also computed from a correct set.
		if (active && active.review?.sourceFile === target.sourceFile) {
			await active.reloadReview();
		}
	}

	/** Best-effort repo-relative path (forward slashes) for a file uri. */
	private toWorkspaceRelative(uri: vscode.Uri): string {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		const base = folder ? folder.uri.fsPath : '';
		const rel = base ? path.relative(base, uri.fsPath) : uri.fsPath;
		return rel.split(path.sep).join('/');
	}

	/** Pull `/tag` tokens (matching the configured set) out of text; return cleaned body + tags. */
	private extractTags(text: string): { body: string; tags: string[] } {
		const allowed = new Set(this.configuredTags());
		const tags: string[] = [];
		const body = text
			.replace(/\/([a-zA-Z][\w-]*)/g, (match, word: string) => {
				if (allowed.has(word)) {
					if (!tags.includes(word)) {
						tags.push(word);
					}
					return '';
				}
				return match;
			})
			.replace(/[ \t]{2,}/g, ' ')
			.trim();
		return { body, tags };
	}

	async setState(vsThread: vscode.CommentThread, state: 'resolved' | 'unresolved'): Promise<void> {
		const binding = this.bindings.get(vsThread);
		if (!binding) {
			return;
		}
		await this.setStateByThreadId(binding.reviewFile, binding.threadId, state);
	}

	/**
	 * Resolve/unresolve a thread by its review-file + thread id (no live CommentThread required).
	 * Used by the Conversations pane, whose tree nodes hold a plain ReviewThread, not a live
	 * vscode.CommentThread. Forces materialization so the state change is reflected even if threads
	 * were deferred and never built.
	 */
	async setStateByThreadId(
		reviewFile: string,
		threadId: string,
		state: 'resolved' | 'unresolved',
	): Promise<void> {
		const review = await store.loadReview(vscode.Uri.file(reviewFile));
		if (!review) {
			return;
		}
		store.setThreadState(review, threadId, state);
		await store.saveReview(review);
		this.materialized = true;
		await this.render();
	}

	/**
	 * Force thread materialization and FLUSH — awaits a real reconcile so callers can rely on
	 * `this.rendered` being populated when this returns. Used by user actions that read live
	 * threads immediately afterwards (e.g. expandThreadAt / jump-to-thread), so it deliberately
	 * bypasses the render debounce (clearing any pending trailing timer) instead of coalescing.
	 */
	async ensureMaterialized(): Promise<void> {
		this.materialized = true;
		if (this.renderDebounceTimer) {
			clearTimeout(this.renderDebounceTimer);
			this.renderDebounceTimer = null;
		}
		await this.doRender();
	}

	/**
	 * Expand the live CommentThread anchored at the given file + 1-based start line (used by
	 * jump-to-thread). Materializes threads first if they were deferred. Leaves other threads as-is.
	 */
	async expandThreadAt(filePath: string, startLine: number): Promise<void> {
		await this.ensureMaterialized();
		const targetUri = this.resolveFilePath(filePath);
		if (!targetUri) {
			return;
		}
		const target = targetUri.fsPath.toLowerCase();
		const wantLine = Math.max(0, startLine - 1);
		for (const r of this.rendered.values()) {
			if (
				r.vsThread.uri.fsPath.toLowerCase() === target &&
				r.vsThread.range?.start.line === wantLine
			) {
				r.vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
			}
		}
	}

	/** Return the {threadId, reviewDir} for a live thread (used by the Ask Copilot command). */
	getBinding(vsThread: vscode.CommentThread): Binding | undefined {
		return this.bindings.get(vsThread);
	}
}
