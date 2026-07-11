/**
 * Searchlight: Local Code Review — extension entry point.
 *
 * Wires together:
 *   - the "Local Reviews" TreeView (from the v0 scaffold),
 *   - the native `vscode.comments` CommentController (inline threads, reply/resolve, /tag),
 *   - `/tag` autocomplete on the comment input,
 *   - copy commands (commit id / branch / review dir),
 *   - "Ask Copilot to Review" commands that shell out to the `copilot` CLI (never a model directly),
 *   - a FileSystemWatcher that refreshes BOTH the tree and the CommentController on disk change.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { SearchlightCommentController } from './commentController';
import { registerTagCompletion } from './tagCompletion';
import * as store from './reviewStore';
import { Review } from './reviewModel';
import { ReviewStatusBar } from './statusBar';
import * as gitApi from './gitApi';
import {
	BranchRef,
	getRepoRoot,
	fetch as gitFetch,
	aheadBehind,
	fastForward,
	fastForwardRef,
} from './git';
import { ActiveComparison } from './activeComparison';
import { ComparisonWebviewProvider } from './comparisonView';
import { FilesWebviewProvider } from './filesWebview';
import { CommitsWebviewProvider } from './commitsWebview';
import { ConversationsWebviewProvider } from './conversationsWebview';
import {
	DIFF_SCHEME,
	ReviewDiffContentProvider,
	openFileDiff,
	openAllChangesDiff,
	openCommitDiff,
	openCommitFileDiff,
	openUncommittedFileDiff,
	UncommittedGroup,
} from './reviewDiff';
import { initPerf, perf, perfLine } from './perf';

/** Shared "Searchlight" output channel for user-visible git/action feedback. Assigned in `activate`. */
let outputChannel: vscode.OutputChannel | undefined;

/** Timestamped line into the Searchlight output channel (no-op before activation). */
function log(message: string): void {
	const stamp = new Date().toLocaleTimeString();
	outputChannel?.appendLine(`[${stamp}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Shared output channel for git/action feedback (Update, terminal, etc.).
	outputChannel = vscode.window.createOutputChannel('Searchlight');
	context.subscriptions.push(outputChannel);
	initPerf(outputChannel);

	// Load-time instrumentation: header + overall activation timer (gated by searchlight.perfLogging).
	const tActivate = Date.now();
	perfLine('--- activation ---');

	// Status-bar active-review switcher (src → tgt); hidden when there's no review.
	const statusBar = new ReviewStatusBar(context.workspaceState);
	context.subscriptions.push(statusBar);
	void statusBar.update();

	const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!wsFolder) {
		warnNoWorkspace();
		return;
	}

	// The single in-memory "active comparison" that feeds all four views.
	//
	// NOTE: activate() must return FAST. On Windows, antivirus (Defender) scans git.exe on each
	// spawn during the startup burst, so getRepoRoot / computeDefaults / resolve can each take
	// several seconds (measured ~5s / ~18s / ~10s → 33s total) — but the SAME git ops are fast
	// once the AV scan settles. VS Code shows "Activating Extensions..." until activate() resolves,
	// so the fix is to STOP blocking activation on git, not to make git faster. We construct
	// `active` with a `wsFolder` placeholder for repoRoot and resolve the real root (plus
	// computeDefaults/resolve/refreshAll) in the background IIFE at the end of activate().
	const active = new ActiveComparison(wsFolder, wsFolder);

	// Inline comment threads. Constructed after `active` so new (first-ever) threads can target
	// the currently-viewed comparison's review even before any comments.json exists on disk.
	const comments = new SearchlightCommentController(() => active);
	context.subscriptions.push(comments);

	// Four stacked views, all reading from `active`. The comparison view is a webview inline selector;
	// the other three are TreeViews.
	const comparisonProvider = new ComparisonWebviewProvider(
		() => active,
		async (branch) => {
			await active.setBase(branch);
			refreshAll();
		},
		async (branch) => {
			await active.setCompare(branch);
			refreshAll();
		},
		async (row) => {
			await updateStaleBranch(active, row, refreshAll, (ok, message) =>
				comparisonProvider.postUpdateResult(row, ok, message),
			);
		},
	);
	const commitsProvider = new CommitsWebviewProvider(() => active);
	const conversationsProvider = new ConversationsWebviewProvider(() => active, context.workspaceState);
	const filesProvider = new FilesWebviewProvider(
		() => active,
		statusBar,
		() => conversationsProvider.refresh(),
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('searchlight.comparison', comparisonProvider),
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('searchlight.files', filesProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	// The Commits pane is now a webview (Phase D). Its expand/collapse, lazy
	// file listing, copy-sha button, and truncation node are handled inside
	// CommitsWebviewProvider's message handling — no TreeView subscription.
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('searchlight.commits', commitsProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	// The Conversations pane is now a webview (Phase E). Its thread rows,
	// per-comment #tag badges, resolve/unresolve inline buttons, and
	// click-to-navigate are handled inside ConversationsWebviewProvider's
	// message handling — no TreeView subscription. refresh() re-posts state so
	// the Files->Conversations refresh hook and refreshAll keep working.
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('searchlight.conversations', conversationsProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	// Refresh all four views + inline comments + status bar together.
	const refreshAll = () => {
		comparisonProvider.refresh();
		filesProvider.refresh();
		commitsProvider.refresh();
		conversationsProvider.refresh();
		void comments.render();
		void statusBar.update();
	};

	// Read-only content provider that serves historical file blobs for the diff view.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			DIFF_SCHEME,
			new ReviewDiffContentProvider(),
		),
	);

	// File checkbox toggles are handled inside FilesWebviewProvider.onToggleReviewed
	// (the Files pane is now a webview; the reviewedFiles mutation + persist lives there).

	// Initial inline render.
	void comments.render();

	// /tag autocomplete on the comment input box.
	context.subscriptions.push(registerTagCompletion());

	// Manual refresh (also wired to the view/title button).
	context.subscriptions.push(
		vscode.commands.registerCommand('searchlight.refresh', () => {
			refreshAll();
		}),
	);

	// Open a thread's file and reveal `filePath:startLine`.
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'searchlight.openThreadLocation',
			async (filePath: string, startLine: number, endLine: number) => {
				await openThreadLocation(filePath, startLine, endLine);
				// Also expand the matching live CommentThread at that anchor (leaves others as-is).
				await comments.expandThreadAt(filePath, startLine);
			},
		),
	);

	// ── Comment thread commands ────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'searchlight.createOrReply',
			(reply: vscode.CommentReply) => comments.handleReply(reply),
		),
		vscode.commands.registerCommand(
			'searchlight.resolveThread',
			(thread: vscode.CommentThread) => comments.setState(thread, 'resolved'),
		),
		vscode.commands.registerCommand(
			'searchlight.unresolveThread',
			(thread: vscode.CommentThread) => comments.setState(thread, 'unresolved'),
		),
		// Single always-visible in-thread toggle. RATIONALE: the split resolve/reopen title actions
		// depend on the `commentThreadState` context key (when clauses `== unresolved` / `== resolved`),
		// which did not resolve reliably in the host VS Code build — so neither `when` matched and NO
		// button rendered. This one command is keyed only on `commentController == searchlight`, so it
		// renders unconditionally; the handler reads the thread's current state and flips it.
		vscode.commands.registerCommand(
			'searchlight.toggleThreadResolved',
			async (thread: vscode.CommentThread) => {
				const next =
					thread?.state === vscode.CommentThreadState.Resolved ? 'unresolved' : 'resolved';
				await comments.setState(thread, next);
				// setStateByThreadId writes comments.json but does NOT touch active.review; re-sync the
				// in-memory review so the Conversations pane reflects the flipped state immediately.
				await active.reloadReview();
				conversationsProvider.refresh();
			},
		),
		vscode.commands.registerCommand(
			'searchlight.resolveThreadNode',
			// The Conversations webview posts a { thread: { id } } stub; the former ConversationNode
			// (native TreeItem, deleted in Phase F) satisfied this same minimal shape.
			async (node: { thread?: { id?: string } }) => {
				const reviewFile = active.review?.sourceFile;
				const threadId = node?.thread?.id;
				if (!reviewFile || !threadId) {
					return;
				}
				await comments.setStateByThreadId(reviewFile, threadId, 'resolved');
				await active.reloadReview();
				conversationsProvider.refresh();
			},
		),
		vscode.commands.registerCommand(
			'searchlight.unresolveThreadNode',
			async (node: { thread?: { id?: string } }) => {
				const reviewFile = active.review?.sourceFile;
				const threadId = node?.thread?.id;
				if (!reviewFile || !threadId) {
					return;
				}
				await comments.setStateByThreadId(reviewFile, threadId, 'unresolved');
				await active.reloadReview();
				conversationsProvider.refresh();
			},
		),
		vscode.commands.registerCommand(
			'searchlight.askCopilotThread',
			async (thread: vscode.CommentThread) => {
				const binding = comments.getBinding(thread);
				if (!binding) {
					void vscode.window.showWarningMessage(
						'Searchlight: this thread is not backed by a review file yet.',
					);
					return;
				}
				askCopilot(binding.reviewDir, binding.threadId);
			},
		),
		vscode.commands.registerCommand('searchlight.askCopilotReview', async () => {
			const review = await pickReview('Select a review for Copilot to look at');
			if (review) {
				askCopilot(path.dirname(review.sourceFile), undefined);
			}
		}),
	);

	// ── Copy commands ──────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('searchlight.copyCommitId', async () => {
			const review = await pickReview('Copy commit id from which review?');
			await copyValue(review?.sourceCommit, 'commit id');
		}),
		vscode.commands.registerCommand('searchlight.copyBranchName', async () => {
			const review = await pickReview('Copy branch name from which review?');
			await copyValue(review?.sourceBranch, 'branch name');
		}),
		vscode.commands.registerCommand('searchlight.copyDirPath', async () => {
			const review = await pickReview('Copy directory path from which review?');
			await copyValue(review ? path.dirname(review.sourceFile) : undefined, 'directory path');
		}),
	);

	// ── Git / directory integration (v1.5) ────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'searchlight.pickBranches',
			async (node?: { review?: Review }) => {
				await pickBranches(node?.review, refreshAll);
			},
		),
		vscode.commands.registerCommand('searchlight.switchReview', async () => {
			await switchReview(statusBar, refreshAll);
		}),
		vscode.commands.registerCommand(
			'searchlight.openDirectory',
			async (node?: { review?: Review }) => {
				await openDirectory(node?.review);
			},
		),
		vscode.commands.registerCommand('searchlight.gitPull', async () => {
			await runGit('pull', async () => {
				await active.resolve();
				refreshAll();
			});
		}),
		vscode.commands.registerCommand('searchlight.gitPush', async () => {
			await runGit('push', async () => {
				await active.resolve();
				refreshAll();
			});
		}),
		vscode.commands.registerCommand(
			'searchlight.openTerminalHere',
			async (node?: { review?: Review }) => {
				await openTerminalHere(node?.review);
			},
		),
	);

	// ── Four-view comparison commands ──────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('searchlight.pickBase', async () => {
			const chosen = await pickBranch(active.repoRootFsPath, 'Select the base (target) branch', {
				current: active.base,
			});
			if (chosen) {
				await active.setBase(chosen.name);
				refreshAll();
			}
		}),
		vscode.commands.registerCommand('searchlight.pickCompare', async () => {
			const chosen = await pickBranch(
				active.repoRootFsPath,
				'Select the compare (source) branch',
				{ current: active.compare },
			);
			if (chosen) {
				await active.setCompare(chosen.name);
				refreshAll();
			}
		}),
		vscode.commands.registerCommand('searchlight.swapBranches', async () => {
			await active.swap();
			refreshAll();
		}),
		vscode.commands.registerCommand('searchlight.copyCompareBranch', () =>
			comparisonProvider.copyCompareBranchName(),
		),
		vscode.commands.registerCommand('searchlight.copyComparePath', () =>
			comparisonProvider.copyCompareBranchPath(),
		),
		vscode.commands.registerCommand('searchlight.refreshAll', async () => {
			await active.resolve();
			refreshAll();
		}),
		vscode.commands.registerCommand('searchlight.filesExpandAll', () => {
			filesProvider.setExpanded(true);
		}),
		vscode.commands.registerCommand('searchlight.collapseAllCommits', () => {
			// The Commits pane is a webview (Phase D); collapsing is pure UI state
			// posted to the webview, which collapses all expanded commit rows.
			commitsProvider.setExpanded(false);
		}),
		vscode.commands.registerCommand(
			'searchlight.updateStaleBranch',
			async (row?: 'base' | 'compare') => {
				await updateStaleBranch(active, row, refreshAll);
			},
		),
		vscode.commands.registerCommand('searchlight.openFileDiff', async (relPath: string) => {
			await openFileDiff(active, relPath);
		}),
		vscode.commands.registerCommand(
			'searchlight.openUncommittedFileDiff',
			async (relPath: string, group: UncommittedGroup) => {
				await openUncommittedFileDiff(active, relPath, group);
			},
		),
		vscode.commands.registerCommand('searchlight.openCommitDiff', async (sha: string) => {
			await openCommitDiff(active, sha);
		}),
		vscode.commands.registerCommand(
			'searchlight.openCommitFileDiff',
			async (sha: string, relPath: string) => {
				await openCommitFileDiff(active, sha, relPath);
			},
		),
		vscode.commands.registerCommand('searchlight.openTerminal', () => {
			const leaf = active.compare ? shortBranch(active.compare) : 'terminal';
			const terminal = vscode.window.createTerminal({
				name: `Searchlight: ${leaf}`,
				cwd: active.repoRootFsPath,
			});
			terminal.show();
		}),
		vscode.commands.registerCommand('searchlight.commitsViewAllChanges', async () => {
			await openAllChangesDiff(active);
		}),
		vscode.commands.registerCommand('searchlight.copyCommitSha', async (node?: unknown) => {
			const sha =
				typeof node === 'string'
					? node
					: (node as { sha?: string } | undefined)?.sha;
			if (!sha) {
				return;
			}
			await vscode.env.clipboard.writeText(sha);
			void vscode.window.showInformationMessage(`Searchlight: copied commit ${sha}`);
		}),
	);

	// Keep the tree AND the inline comments in sync with on-disk review files.
	const watcher = vscode.workspace.createFileSystemWatcher(
		'**/.vscode/searchlight-reviews/**/comments.json',
	);
	const onChange = () => {
		refreshAll();
	};
	watcher.onDidCreate(onChange);
	watcher.onDidChange(onChange);
	watcher.onDidDelete(onChange);
	context.subscriptions.push(watcher);

	// Activation critical path ends here — return fast. The heavy, AV-scanned git work (repo-root
	// resolution, default base/compare, resolve, first refresh) runs in the background so VS Code
	// stops showing "Activating Extensions..." within milliseconds. The four views keep their
	// existing loading/placeholder state until the background init calls refreshAll().
	perf('activate total', tActivate);

	void (async () => {
		const tBg = Date.now();

		const tRepo = Date.now();
		const repoRoot = (await getRepoRoot(wsFolder)) ?? wsFolder;
		perf('getRepoRoot', tRepo);
		active.repoRootFsPath = repoRoot;

		// Populate the four views: compute default base/compare (unless disabled), resolve, refresh.
		const autoCreateOnEmpty = vscode.workspace
			.getConfiguration('searchlight')
			.get<boolean>('autoCreateOnEmpty', true);
		if (autoCreateOnEmpty) {
			const tDefaults = Date.now();
			await active.computeDefaults();
			perf('computeDefaults', tDefaults);
		}
		const tResolve = Date.now();
		await active.resolve();
		perf('resolve', tResolve);
		refreshAll();
		perf('background init total', tBg);
	})();
}

export function deactivate(): void {
	// Nothing to clean up; all disposables are tracked in context.subscriptions.
}

/**
 * Shell out to the Copilot CLI in an integrated terminal rooted at the review dir. The extension
 * NEVER calls a model itself — it only launches the configured CLI. After the CLI writes to
 * comments.json, the file watcher re-renders the thread automatically.
 */
function askCopilot(reviewDir: string, threadId: string | undefined): void {
	const cfg = vscode.workspace.getConfiguration('searchlight');
	const cliPath = cfg.get<string>('copilotPath', 'copilot');
	const cliArgs = cfg.get<string[]>('copilotArgs', ['-p']);

	const target = threadId
		? `local review thread ${threadId} in ${reviewDir}`
		: `the local review in ${reviewDir}`;
	const prompt =
		`Respond to ${target}. Read comments.json, reply in-thread per the schema ` +
		`(v2: author object, tags[], replyTo), stamp your identity as ~Written by 🤖 Copilot, ` +
		`and set thread state appropriately.`;

	const terminal = vscode.window.createTerminal({ name: 'Searchlight · Copilot', cwd: reviewDir });
	terminal.show();
	const quotedArgs = cliArgs.map(shellQuote).join(' ');
	terminal.sendText(`${shellQuote(cliPath)} ${quotedArgs} ${shellQuote(prompt)}`.trim());
}

/** Minimal cross-shell quoting: wrap in double quotes and escape embedded double quotes. */
function shellQuote(value: string): string {
	if (value.length > 0 && !/[\s"'`$&|<>();]/.test(value)) {
		return value;
	}
	return `"${value.replace(/"/g, '\\"')}"`;
}

/** Copy a value to the clipboard with user feedback, or warn when it is missing. */
async function copyValue(value: string | undefined, label: string): Promise<void> {
	if (!value) {
		void vscode.window.showWarningMessage(`Searchlight: no ${label} available.`);
		return;
	}
	await vscode.env.clipboard.writeText(value);
	void vscode.window.showInformationMessage(`Searchlight: copied ${label} — ${value}`);
}

/** Pick a review: auto-select when there's one, quick-pick when there are several. */
async function pickReview(placeHolder: string): Promise<Review | undefined> {
	const reviews = await store.scanReviews();
	if (reviews.length === 0) {
		void vscode.window.showWarningMessage('Searchlight: no review files found.');
		return undefined;
	}
	if (reviews.length === 1) {
		return reviews[0];
	}
	const picks = reviews.map((r) => ({
		label: path.basename(path.dirname(r.sourceFile)),
		description: `${r.sourceBranch ?? '?'} → ${r.targetBranch ?? '?'}`,
		review: r,
	}));
	const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
	return chosen?.review;
}

/**
 * Resolve a repo-relative (forward-slash) path against the workspace folders, open it, and
 * reveal the given 1-based line range with the selection placed on `startLine`.
 */
async function openThreadLocation(
	filePath: string,
	startLine: number,
	endLine: number,
): Promise<void> {
	const uri = await resolveWorkspaceFile(filePath);
	if (!uri) {
		void vscode.window.showWarningMessage(`Searchlight: could not locate file "${filePath}".`);
		return;
	}

	const doc = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(doc);

	// Convert 1-based schema lines to 0-based VS Code positions, clamped to the document.
	const lastLine = Math.max(doc.lineCount - 1, 0);
	const startIdx = Math.min(Math.max(startLine - 1, 0), lastLine);
	const endIdx = Math.min(Math.max(endLine - 1, 0), lastLine);
	const endCol = doc.lineAt(endIdx).text.length;

	const range = new vscode.Range(startIdx, 0, endIdx, endCol);
	editor.selection = new vscode.Selection(startIdx, 0, endIdx, endCol);
	editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Try each workspace folder in turn; return the first path that exists. */
async function resolveWorkspaceFile(relPath: string): Promise<vscode.Uri | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		const candidate = vscode.Uri.joinPath(folder.uri, ...relPath.split('/'));
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch {
			// Not in this folder; try the next.
		}
	}
	return undefined;
}

// ── v1.5 git / directory integration helpers ─────────────────────────────────

/**
 * Resolve a git working directory for the given review: the workspace folder that owns the review
 * file when available, otherwise the first workspace folder.
 */
function gitCwd(review?: Review): string | undefined {
	if (review) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(review.sourceFile));
		if (folder) {
			return folder.uri.fsPath;
		}
	}
	return (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath;
}

/** The configured default push remote, or `undefined` when unset (let git decide). */
function remoteSetting(): string | undefined {
	const value = vscode.workspace.getConfiguration('searchlight').get<string>('defaultRemote', '');
	return value.trim() ? value.trim() : undefined;
}

function warnNoWorkspace(): void {
	void vscode.window.showWarningMessage('Searchlight: open a folder/workspace first.');
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A remote ref like `origin/main` also matches a local worktree branch `main`. */
function shortBranch(branch: string): string {
	const idx = branch.indexOf('/');
	return idx >= 0 ? branch.slice(idx + 1) : branch;
}

/** Prompt for one branch (local or remote) from the repo at `cwd`. */
async function pickBranch(
	cwd: string,
	placeHolder: string,
	opts?: { current?: string },
): Promise<BranchRef | undefined> {
	const branches = await gitApi.listBranches(cwd);
	if (branches.length === 0) {
		void vscode.window.showWarningMessage('Searchlight: no branches found.');
		return undefined;
	}
	const head = await gitApi.getHead(cwd);
	const current = opts?.current;

	type PickItem = vscode.QuickPickItem & { branch?: BranchRef };
	const toItem = (b: BranchRef): PickItem => {
		const isCurrent = b.name === current;
		const isHead = !head.detached && b.kind === 'local' && b.name === head.branch;
		const marks: string[] = [];
		if (isCurrent) {
			marks.push('current');
		}
		if (isHead) {
			marks.push('HEAD');
		}
		return {
			label: `${isCurrent || isHead ? '$(check) ' : ''}${b.name}`,
			description: marks.length > 0 ? `${b.kind} · ${marks.join(', ')}` : b.kind,
			detail: b.commit ? b.commit.slice(0, 12) : undefined,
			branch: b,
		};
	};

	const locals = branches.filter((b) => b.kind === 'local');
	const remotes = branches.filter((b) => b.kind === 'remote');
	const items: PickItem[] = [];
	if (locals.length > 0) {
		items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
		items.push(...locals.map(toItem));
	}
	if (remotes.length > 0) {
		items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
		items.push(...remotes.map(toItem));
	}

	const chosen = await vscode.window.showQuickPick(items, {
		placeHolder,
		matchOnDescription: true,
	});
	return chosen?.branch;
}

/**
 * Fast-forward a stale comparison row's branch to its upstream. Fetches first, then:
 *   - if the row's branch is the currently checked-out HEAD → `git merge --ff-only <upstream>`;
 *   - otherwise → `git fetch . <upstream>:<branch>` (FF-only ref update, refuses non-FF).
 * On non-FF divergence, warns and does NOT merge/rebase. On success, re-resolves + refreshes.
 */
async function updateStaleBranch(
	active: ActiveComparison,
	row: 'base' | 'compare' | undefined,
	refreshAll: () => void,
	report?: (ok: boolean, message?: string) => void,
): Promise<void> {
	const branch = row === 'compare' ? active.compare : active.base;
	if (!branch) {
		const msg = 'no branch selected to update.';
		void vscode.window.showWarningMessage(`Searchlight: ${msg}`);
		report?.(false, msg);
		return;
	}
	if (branch.includes('/')) {
		const msg = `'${branch}' is a remote-tracking branch and cannot be fast-forwarded.`;
		log(`⚠ ${msg}`);
		void vscode.window.showWarningMessage(`Searchlight: ${msg}`);
		report?.(false, msg);
		return;
	}
	const cwd = active.repoRootFsPath;
	// Immediate feedback the instant the op starts, before any git work runs.
	vscode.window.setStatusBarMessage(`Searchlight: updating '${branch}'…`, 2000);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: `Searchlight: updating '${branch}'…` },
		async () => {
			try {
				log(`⇣ Fetching origin for '${branch}'…`);
				await gitFetch(cwd);
				const ab = await aheadBehind(cwd, branch);
				if (!ab || ab.behind === 0) {
					log(`Already up to date: '${branch}'.`);
					vscode.window.setStatusBarMessage(`Searchlight: '${branch}' already up to date`, 4000);
					void vscode.window.showInformationMessage(
						`Searchlight: '${branch}' is already up to date.`,
					);
					await active.resolve();
					refreshAll();
					report?.(true);
					return;
				}
				log(`'${branch}' is ⇣${ab.behind} behind ${ab.upstream}; attempting fast-forward…`);
				const head = await gitApi.getHead(cwd);
				const isHead = !head.detached && branch === head.branch;
				const ok = isHead
					? await fastForward(cwd, ab.upstream)
					: await fastForwardRef(cwd, ab.upstream, branch);
				if (!ok) {
					const msg = `Cannot fast-forward '${branch}' — diverged from ${ab.upstream}; resolve manually.`;
					log(`⚠ ${msg}`);
					log('Click ↻ Update again to retry.');
					vscode.window.setStatusBarMessage(`Searchlight: '${branch}' cannot fast-forward`, 5000);
					void vscode.window.showWarningMessage(`Searchlight: ${msg}`);
					report?.(false, msg);
					return;
				}
				log(`Fast-forwarded '${branch}' to ${ab.upstream}.`);
				vscode.window.setStatusBarMessage(`Searchlight: fast-forwarded '${branch}'`, 4000);
				void vscode.window.showInformationMessage(
					`Searchlight: fast-forwarded '${branch}' to ${ab.upstream}.`,
				);
				await active.resolve();
				refreshAll();
				report?.(true);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log(`⚠ Update failed for '${branch}': ${msg}`);
				log('Click ↻ Update again to retry.');
				vscode.window.setStatusBarMessage(`Searchlight: update failed for '${branch}'`, 5000);
				void vscode.window.showWarningMessage(`Searchlight: update failed for '${branch}': ${msg}`);
				report?.(false, msg);
			}
		},
	);
}

/**
 * Pick a source and target branch for a review and persist the choice (branch + commit) into its
 * comments.json header via the v2 writer. Keeps v1/v2 read back-compat because we reload → mutate →
 * save through reviewStore.
 */
async function pickBranches(review: Review | undefined, refreshAll: () => void): Promise<void> {
	const target = review ?? (await pickReview('Pick branches for which review?'));
	if (!target) {
		return;
	}
	const cwd = gitCwd(target);
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	if (!(await gitApi.hasRepository(cwd))) {
		void vscode.window.showErrorMessage('Searchlight: no git repository in the workspace.');
		return;
	}
	const source = await pickBranch(cwd, 'Select SOURCE branch (the changes under review)');
	if (!source) {
		return;
	}
	const base = await pickBranch(cwd, 'Select TARGET branch (the base to compare against)');
	if (!base) {
		return;
	}

	const fresh = await store.loadReview(vscode.Uri.file(target.sourceFile));
	if (!fresh) {
		void vscode.window.showErrorMessage('Searchlight: could not load the review file.');
		return;
	}
	fresh.sourceBranch = source.name;
	fresh.sourceCommit = source.commit;
	fresh.targetBranch = base.name;
	fresh.targetCommit = base.commit;
	await store.saveReview(fresh);
	void vscode.window.showInformationMessage(
		`Searchlight: review set to ${source.name} → ${base.name}.`,
	);
	refreshAll();
}

/**
 * Choose the active review for the status bar. With a single review, jump straight to the branch
 * pickers; with several, pick one and mark it active.
 */
async function switchReview(statusBar: ReviewStatusBar, refreshAll: () => void): Promise<void> {
	const reviews = await store.scanReviews();
	if (reviews.length === 0) {
		void vscode.window.showWarningMessage('Searchlight: no review files found.');
		return;
	}
	if (reviews.length === 1) {
		await statusBar.setActiveDir(path.dirname(reviews[0].sourceFile));
		await pickBranches(reviews[0], refreshAll);
		return;
	}
	const items = reviews.map((r) => ({
		label: path.basename(path.dirname(r.sourceFile)),
		description: `${r.sourceBranch ?? '?'} → ${r.targetBranch ?? '?'}`,
		review: r,
	}));
	const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Select the active review' });
	if (!chosen) {
		return;
	}
	await statusBar.setActiveDir(path.dirname(chosen.review.sourceFile));
	refreshAll();
}

/**
 * Worktree-aware "open directory": from a review's source/target branch, find a matching local
 * worktree and offer to open it in a new window or reveal it. If the branch isn't checked out
 * anywhere, say so gracefully.
 */
async function openDirectory(review?: Review): Promise<void> {
	const target = review ?? (await pickReview('Open directory for which review?'));
	if (!target) {
		return;
	}
	const cwd = gitCwd(target);
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	const candidates = [target.sourceBranch, target.targetBranch].filter(
		(b): b is string => !!b,
	);
	if (candidates.length === 0) {
		void vscode.window.showInformationMessage(
			'Searchlight: this review has no branches set — run "Pick Branches" first.',
		);
		return;
	}
	let branch: string | undefined = candidates[0];
	if (candidates.length > 1) {
		branch = await vscode.window.showQuickPick(candidates, {
			placeHolder: "Which branch's directory?",
		});
	}
	if (!branch) {
		return;
	}

	const worktrees = await gitApi.listWorktrees(cwd);
	const short = shortBranch(branch);
	const match = worktrees.find((w) => w.branch === branch || w.branch === short);
	if (!match) {
		void vscode.window.showInformationMessage(
			`Searchlight: branch "${branch}" is not checked out in any worktree.`,
		);
		return;
	}

	const OPEN = 'Open Folder (new window)';
	const REVEAL = 'Reveal in OS';
	const action = await vscode.window.showQuickPick([OPEN, REVEAL], { placeHolder: match.path });
	const uri = vscode.Uri.file(match.path);
	if (action === OPEN) {
		await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
	} else if (action === REVEAL) {
		await vscode.commands.executeCommand('revealFileInOS', uri);
	}
}

/** git pull / push one-click, preferring the vscode.git API with a CLI fallback. */
async function runGit(op: 'pull' | 'push', refreshAll: () => void | Promise<void>): Promise<void> {
	const cwd = gitCwd();
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	if (!(await gitApi.hasRepository(cwd))) {
		void vscode.window.showErrorMessage('Searchlight: no git repository in the workspace.');
		return;
	}
	if (op === 'push') {
		const head = await gitApi.getHead(cwd);
		if (head.detached) {
			void vscode.window.showErrorMessage('Searchlight: cannot push a detached HEAD.');
			return;
		}
	}
	const remote = op === 'push' ? remoteSetting() : undefined;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searchlight: git ${op}…` },
		async () => {
			try {
				if (op === 'pull') {
					await gitApi.pull(cwd);
				} else {
					await gitApi.push(cwd, remote);
				}
				void vscode.window.showInformationMessage(`Searchlight: git ${op} succeeded.`);
				await refreshAll();
			} catch (err) {
				void vscode.window.showErrorMessage(
					`Searchlight: git ${op} failed — ${errMessage(err)}`,
				);
			}
		},
	);
}

/** Open an integrated terminal rooted at the review dir (or the repo root). */
async function openTerminalHere(review?: Review): Promise<void> {
	let cwd = review ? path.dirname(review.sourceFile) : undefined;
	if (!cwd) {
		const base = gitCwd();
		cwd = base ? (await getRepoRoot(base)) ?? base : undefined;
	}
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	const terminal = vscode.window.createTerminal({ name: 'Searchlight · Terminal', cwd });
	terminal.show();
}
