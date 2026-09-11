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
	runGitQuery,
} from './git';
import { ActiveComparison } from './activeComparison';
import { ComparisonWebviewProvider } from './comparisonView';
import { FilesWebviewProvider, isUncommittedHidden, syncUncommittedContext } from './filesWebview';
import { CommitsWebviewProvider } from './commitsWebview';
import { ConversationsWebviewProvider, isResolvedHidden, syncResolvedContext } from './conversationsWebview';
import {
	DIFF_SCHEME,
	ReviewDiffContentProvider,
	openFileDiff,
	openAllChangesDiff,
	openCommitDiff,
	openCommitFileDiff,
	openUncommittedFileDiff,
	openCumulativeFileDiff,
	UncommittedGroup,
} from './reviewDiff';
import { initPerf, perf, perfLine } from './perf';
import { diagnosticsEnabled, diagnosticsRunId, diagnosticsSnapshot, event, milestone, now, setDiagnosticsEnabled, trace } from './diagnostics';
import { setComparisonSettled, paneSnapshot, resetPaneMetrics } from './webviewMetrics';
import { initUsage, setUsageEnabled, recordUsage, usageEditor, usageFocus, usageSnapshot, emitUsageSummary } from './usage';
import { classifyEditorInput, editorInputIdentity } from './usageContext';
import { ConversationDocumentProvider, CONVERSATION_SCHEME } from './conversationDocument';
import { ConversationPages, CONVERSATION_PAGE_TYPE } from './conversationPage';

/** Shared "Searchlight" output channel for user-visible git/action feedback. Assigned in `activate`. */
let outputChannel: vscode.OutputChannel | undefined;

/** Timestamped line into the Searchlight output channel (no-op before activation). */
function log(message: string): void {
	const stamp = new Date().toLocaleTimeString();
	outputChannel?.appendLine(`[${stamp}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const tActivate = now();
	// Shared output channel for git/action feedback (Update, terminal, etc.).
	outputChannel = vscode.window.createOutputChannel('Searchlight');
	context.subscriptions.push(outputChannel);
	const cfg = vscode.workspace.getConfiguration('searchlight');
	initPerf(outputChannel, tActivate, {
		extensionVersion: context.extension.packageJSON.version,
		vscodeVersion: vscode.version, nodeVersion: process.version,
		platform: process.platform, arch: process.arch,
		workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0,
		autoCreateOnEmpty: cfg.get<boolean>('autoCreateOnEmpty', true),
		deferThreadsOnLoad: cfg.get<boolean>('deferThreadsOnLoad', true),
		cumulativeDiff: cfg.get<boolean>('files.cumulativeDiff', true),
		compactFolders: cfg.get<boolean>('files.compactFolders', true),
		autoReveal: cfg.get<boolean>('files.autoReveal', true),
		hideUncommitted: isUncommittedHidden(context.workspaceState),
		hideResolved: isResolvedHidden(context.workspaceState),
		extensionMode: context.extensionMode,
		trusted: vscode.workspace.isTrusted,
	});
	resetPaneMetrics();
	initUsage({
		runId: diagnosticsRunId(),
		startMs: tActivate,
		enabled: cfg.get<boolean>('usageLogging', true),
		focused: vscode.window.state.focused,
		sink: (line) => outputChannel?.appendLine(line),
	});
	let lastEditorKey: string | undefined;
	const observeEditor = (initial = false) => {
		const group = vscode.window.tabGroups.activeTabGroup;
		const tab = group.activeTab;
		// ASSUMPTION: VS Code may recreate Tab/input objects for unrelated updates. Compare stable
		// input values instead; the private key stays in memory and never reaches usage records.
		const identity = editorInputIdentity(tab?.input);
		const editorKey = JSON.stringify([group.viewColumn, identity, identity === 'other' || identity.startsWith('view:') ? tab?.label : undefined]);
		usageEditor(classifyEditorInput(tab?.input));
		if (initial || editorKey !== lastEditorKey) {
			recordUsage(initial ? 'editor.observed' : 'editor.changed');
		}
		lastEditorKey = editorKey;
	};
	observeEditor(true);
	const usageTimer = setInterval(emitUsageSummary, 60000);
	usageTimer.unref();
	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(() => observeEditor()),
		vscode.window.tabGroups.onDidChangeTabGroups(() => observeEditor()),
		vscode.window.onDidChangeWindowState((state) => usageFocus(state.focused)),
		{ dispose: () => clearInterval(usageTimer) },
	);

	let initializeComparison: (() => Promise<void>) | undefined;
	let comparisonInit: Promise<void> | undefined;
	const ensureComparison = async (reason: string): Promise<void> => {
		if (!initializeComparison) { throw new Error('Searchlight: open a workspace before starting a comparison.'); }
		if (!comparisonInit) {
			milestone('startup.comparisonRequested', { reason });
			sampleHostForMinute();
			comparisonInit = initializeComparison().catch((error) => {
				comparisonInit = undefined;
				milestone('startup.failed');
				log(`Comparison initialization failed: ${errMessage(error)}`);
				void vscode.window.showErrorMessage('Searchlight: comparison initialization failed. See the Searchlight output channel.');
				throw error;
			});
		}
		await comparisonInit;
	};
	const independentCommands = new Set([
		'searchlight.exportStartupDiagnostics', 'searchlight.openThreadLocation',
		'searchlight.viewConversation',
		'searchlight.createOrReply', 'searchlight.resolveThread', 'searchlight.unresolveThread',
		'searchlight.toggleThreadResolved', 'searchlight.askCopilotThread', 'searchlight.askCopilotReview',
		'searchlight.copyCommitId', 'searchlight.copyBranchName', 'searchlight.copyDirPath',
	]);
	const registerCommand = <Args extends unknown[]>(command: string, handler: (...args: Args) => unknown) =>
		vscode.commands.registerCommand(command, async (...args: Args) => {
			observeEditor();
			recordUsage('command.started', { command });
			try {
				if (!independentCommands.has(command)) { await ensureComparison('command'); }
				const result = await handler(...args);
				recordUsage('command.completed', { command });
				return result;
			} catch (error) {
				recordUsage('command.failed', { command });
				throw error;
			}
		});
	const registerPane = (id: string, provider: vscode.WebviewViewProvider, retainContextWhenHidden = false) =>
		vscode.window.registerWebviewViewProvider(id, {
			async resolveWebviewView(view, viewContext, token) {
				// Shells and usage visibility are observable immediately; Git work remains on demand.
				await provider.resolveWebviewView(view, viewContext, token);
				await ensureComparison('pane');
			},
		}, { webviewOptions: { retainContextWhenHidden } });
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('searchlight.perfLogging')) {
				setDiagnosticsEnabled(vscode.workspace.getConfiguration('searchlight').get<boolean>('perfLogging', true));
			}
			if (e.affectsConfiguration('searchlight.usageLogging')) {
				setUsageEnabled(vscode.workspace.getConfiguration('searchlight').get<boolean>('usageLogging', true));
			}
		}),
		registerCommand('searchlight.exportStartupDiagnostics', async () => {
			const uri = await vscode.window.showSaveDialog({
				title: 'Export Searchlight startup diagnostics',
				defaultUri: vscode.Uri.joinPath(context.logUri, 'searchlight-startup.json'),
				filters: { JSON: ['json'] },
			});
			if (!uri) { return; }
			try {
				const report = { trace: diagnosticsSnapshot(), panes: paneSnapshot(), usage: usageSnapshot() };
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(report, null, 2), 'utf8'));
				void vscode.window.showInformationMessage('Searchlight: startup diagnostics exported.');
			} catch (error) {
				void vscode.window.showErrorMessage(`Searchlight: diagnostic export failed: ${errMessage(error)}`);
			}
		}),
	);

	// ASSUMPTION: these are shared extension-host signals, not CPU/memory attributed to Searchlight.
	let hostTimer: ReturnType<typeof setInterval> | undefined;
	function sampleHostForMinute(): void {
		if (hostTimer) { clearInterval(hostTimer); }
		let lastSample = now();
		let lastCpu = process.cpuUsage();
		const samplingDeadline = lastSample + 60000;
		hostTimer = setInterval(() => {
			const current = now();
			if (current >= samplingDeadline) { clearInterval(hostTimer); }
			if (diagnosticsEnabled()) {
				const cpu = process.cpuUsage();
				const memory = process.memoryUsage();
				event('host.sample', {
					intervalMs: current - lastSample, eventLoopLagMs: Math.max(0, current - lastSample - 1000),
					cpuUserMs: (cpu.user - lastCpu.user) / 1000, cpuSystemMs: (cpu.system - lastCpu.system) / 1000,
					rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
				});
				lastCpu = cpu;
			} else {
				lastCpu = process.cpuUsage();
			}
			lastSample = current;
		}, 1000);
		hostTimer.unref();
	}
	sampleHostForMinute();
	context.subscriptions.push({ dispose: () => { if (hostTimer) { clearInterval(hostTimer); } } });

	// Load-time instrumentation: header + overall activation timer (gated by searchlight.perfLogging).
	perfLine('--- activation ---');

	// Status-bar active-review switcher (src → tgt); hidden when there's no review.
	const statusBar = new ReviewStatusBar(context.workspaceState);
	context.subscriptions.push(statusBar);
	void statusBar.update();

	const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!wsFolder) {
		milestone('activation.return', { outcome: 'no-workspace' });
		return;
	}

	// The single in-memory "active comparison" that feeds all four views.
	//
	// NOTE: activate() must return FAST. On Windows, antivirus (Defender) scans git.exe on each
	// spawn during the startup burst, so getRepoRoot / computeDefaults / resolve can each take
	// several seconds (measured ~5s / ~18s / ~10s → 33s total) — but the SAME git ops are fast
	// once the AV scan settles. VS Code shows "Activating Extensions..." until activate() resolves,
	// so the fix is to STOP blocking activation on git, not to make git faster. We construct
	// `active` with a `wsFolder` placeholder. Comparison initialization is shared and deferred
	// until a pane, comparison command, or new discussion actually needs it.
	const active = new ActiveComparison(wsFolder, wsFolder, context.workspaceState);

	// Inline comment threads. Constructed after `active` so new (first-ever) threads can target
	// the currently-viewed comparison's review even before any comments.json exists on disk.
	const comments = new SearchlightCommentController(() => active, () => ensureComparison('new-discussion'));
	context.subscriptions.push(comments);

	// Four stacked views, all reading from `active`. The comparison view is a webview inline selector;
	// the other three are TreeViews.
	const comparisonProvider = new ComparisonWebviewProvider(
		() => active,
		async (branch) => {
			await ensureComparison('pane-action');
			await active.setBase(branch);
			refreshAll('select-base');
		},
		async (branch) => {
			await ensureComparison('pane-action');
			await active.setCompare(branch);
			refreshAll('select-compare');
		},
		async (row) => {
			await ensureComparison('pane-action');
			await updateStaleBranch(active, row, () => refreshAll('git-operation'), (ok, message) =>
				comparisonProvider.postUpdateResult(row, ok, message),
			);
		},
		async (reset) => {
			await ensureComparison('pane-action');
			// ASSUMPTION: pinning freezes a commit ID, never a moving branch expression.
			const selectionKey = active.comparisonKey;
			const value = reset ? undefined : await vscode.window.showInputBox({
				title: 'Searchlight: Pin baseline commit',
				prompt: 'Enter an ancestor commit SHA. The pin stays fixed until you choose Auto.',
				value: active.baselinePin ?? active.baselineCommit,
				ignoreFocusOut: true,
			});
			if (!reset && value === undefined) { return; }
			try {
				if (selectionKey !== active.comparisonKey) {
					throw new Error('The comparison changed while entering a baseline. Try again.');
				}
				await active.setBaselinePin(value);
				refreshAll('baseline-pin');
			} catch (error) {
				void vscode.window.showErrorMessage(`Searchlight: ${errMessage(error)}`);
			}
		},
	);
	const commitsProvider = new CommitsWebviewProvider(() => active);
	const conversationsProvider = new ConversationsWebviewProvider(() => active, context.workspaceState);
	const filesProvider = new FilesWebviewProvider(
		() => active,
		statusBar,
		() => conversationsProvider.refresh(),
		context.workspaceState,
	);

	context.subscriptions.push(
		registerPane('searchlight.comparison', comparisonProvider),
	);
	context.subscriptions.push(
		registerPane('searchlight.files', filesProvider, true),
	);
	// The Commits pane is now a webview (Phase D). Its expand/collapse, lazy
	// file listing, copy-sha button, and truncation node are handled inside
	// CommitsWebviewProvider's message handling — no TreeView subscription.
	context.subscriptions.push(
		registerPane('searchlight.commits', commitsProvider, true),
	);
	// The Conversations pane is now a webview (Phase E). Its thread rows,
	// per-comment #tag badges, resolve/unresolve inline buttons, and
	// click-to-navigate are handled inside ConversationsWebviewProvider's
	// message handling — no TreeView subscription. refresh() re-posts state so
	// the Files->Conversations refresh hook and refreshAll keep working.
	context.subscriptions.push(
		registerPane('searchlight.conversations', conversationsProvider, true),
	);

	// Seed the show/hide-uncommitted context key from persisted state so the correct title-bar button
	// (Hide vs Show) is present immediately at startup — including for a user who reloads while
	// uncommitted rows are hidden.
	void syncUncommittedContext(context.workspaceState);
	// Same for the Conversations show/hide-resolved buttons.
	void syncResolvedContext(context.workspaceState);

	// Re-post the Files tree when folder compaction is toggled, so flipping the setting updates the
	// pane live instead of requiring a reload.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('searchlight.files.compactFolders') || e.affectsConfiguration('searchlight.files.cumulativeDiff')) {
				filesProvider.refresh();
			}
		}),
	);

	// Refresh all four views + inline comments + status bar together.
	const refreshAll = (reason = 'command-or-review-action') => {
		// Dispatch stays fire-and-forget; child spans retain this refresh's correlation context.
		void trace('refresh.dispatch', async () => {
			event('refresh.request', { reason });
			if (reason === 'manual-refresh' || reason === 'manual-resolve-refresh') { conversationDocuments.refresh(); }
			if (reason === 'manual-refresh' || reason === 'manual-resolve-refresh') { conversationPages.refresh(); }
			comparisonProvider.refresh(['manual-refresh', 'manual-resolve-refresh', 'git-operation'].includes(reason));
			filesProvider.refresh();
			commitsProvider.refresh();
			conversationsProvider.refresh();
			void comments.render();
			void statusBar.update();
		}, { reason });
	};

	// Read-only content provider that serves historical file blobs for the diff view.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			DIFF_SCHEME,
			new ReviewDiffContentProvider(),
		),
	);
	const conversationDocuments = new ConversationDocumentProvider();
	const conversationPages = new ConversationPages({
		changed: async () => {
			await active.reloadReview();
			refreshAll('conversation-page');
			conversationDocuments.refresh();
			conversationPages.refresh();
		},
		askCopilot: (reviewFile, threadId) => askCopilot(path.dirname(reviewFile), threadId),
		openCode: async (thread) => {
			if (thread.filePath) {
				await vscode.commands.executeCommand('searchlight.openThreadLocation', thread.filePath, thread.startLine ?? 1, thread.endLine ?? thread.startLine ?? 1);
			}
		},
	});
	context.subscriptions.push(
		conversationDocuments,
		conversationPages,
		vscode.workspace.registerTextDocumentContentProvider(CONVERSATION_SCHEME, conversationDocuments),
		vscode.window.registerWebviewPanelSerializer(CONVERSATION_PAGE_TYPE, conversationPages),
		registerCommand('searchlight.viewConversation', async (target: unknown) => {
			try {
				await conversationPages.open(target);
			} catch (error) {
				void vscode.window.showErrorMessage(`Searchlight: ${errMessage(error)}`);
				throw error;
			}
		}),
		registerCommand('searchlight.newConversation', async () => {
			if (!active.review) {
				void vscode.window.showWarningMessage('Searchlight: select a source and target branch before starting a thread.');
				return;
			}
			await conversationPages.openNew({
				...active.review, sourceBranch: active.compare ?? active.review.sourceBranch,
				targetBranch: active.base ?? active.review.targetBranch,
			});
		}),
	);

	// File checkbox toggles are handled inside FilesWebviewProvider.onToggleReviewed
	// (the Files pane is now a webview; the reviewedFiles mutation + persist lives there).

	// Initial inline render.
	void comments.render();

	// /tag autocomplete on the comment input box.
	context.subscriptions.push(registerTagCompletion());

	// Manual refresh (also wired to the view/title button).
	context.subscriptions.push(
		registerCommand('searchlight.refresh', () => {
			refreshAll('manual-refresh');
		}),
	);

	// Open a thread's file and reveal `filePath:startLine`.
	context.subscriptions.push(
		registerCommand(
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
		registerCommand(
			'searchlight.createOrReply',
			(reply: vscode.CommentReply) => comments.handleReply(reply),
		),
		registerCommand(
			'searchlight.resolveThread',
			(thread: vscode.CommentThread) => comments.setState(thread, 'resolved'),
		),
		registerCommand(
			'searchlight.unresolveThread',
			(thread: vscode.CommentThread) => comments.setState(thread, 'unresolved'),
		),
		// Single always-visible in-thread toggle. RATIONALE: the split resolve/reopen title actions
		// depend on the `commentThreadState` context key (when clauses `== unresolved` / `== resolved`),
		// which did not resolve reliably in the host VS Code build — so neither `when` matched and NO
		// button rendered. This one command is keyed only on `commentController == searchlight`, so it
		// renders unconditionally; the handler reads the thread's current state and flips it.
		registerCommand(
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
		registerCommand(
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
		registerCommand(
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
		registerCommand(
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
		registerCommand('searchlight.askCopilotReview', async () => {
			const review = await pickReview('Select a review for Copilot to look at');
			if (review) {
				askCopilot(path.dirname(review.sourceFile), undefined);
			}
		}),
	);

	// ── Copy commands ──────────────────────────────────────────────────────────
	context.subscriptions.push(
		registerCommand('searchlight.copyCommitId', async () => {
			const review = await pickReview('Copy commit id from which review?');
			await copyValue(review?.sourceCommit, 'commit id');
		}),
		registerCommand('searchlight.copyBranchName', async () => {
			const review = await pickReview('Copy branch name from which review?');
			await copyValue(review?.sourceBranch, 'branch name');
		}),
		registerCommand('searchlight.copyDirPath', async () => {
			const review = await pickReview('Copy directory path from which review?');
			await copyValue(review ? path.dirname(review.sourceFile) : undefined, 'directory path');
		}),
	);

	// ── Git / directory integration (v1.5) ────────────────────────────────────
	context.subscriptions.push(
		registerCommand(
			'searchlight.pickBranches',
			async (node?: { review?: Review }) => {
				await pickBranches(node?.review, refreshAll);
			},
		),
		registerCommand('searchlight.switchReview', async () => {
			await switchReview(statusBar, refreshAll);
		}),
		registerCommand(
			'searchlight.openDirectory',
			async (node?: { review?: Review }) => {
				await openDirectory(node?.review);
			},
		),
		registerCommand('searchlight.gitPull', async () => {
			await runGit('pull', async () => {
				await active.resolve();
				refreshAll('git-operation');
			});
		}),
		registerCommand('searchlight.gitPush', async () => {
			await runGit('push', async () => {
				await active.resolve();
				refreshAll('git-operation');
			});
		}),
		registerCommand(
			'searchlight.openTerminalHere',
			async (node?: { review?: Review }) => {
				await openTerminalHere(node?.review);
			},
		),
	);

	// ── Four-view comparison commands ──────────────────────────────────────────
	context.subscriptions.push(
		registerCommand('searchlight.pickBase', async () => {
			const chosen = await pickBranch(active.repoRootFsPath, 'Select the base (target) branch', {
				current: active.base,
			});
			if (chosen) {
				await active.setBase(chosen.name);
				refreshAll();
			}
		}),
		registerCommand('searchlight.pickCompare', async () => {
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
		registerCommand('searchlight.swapBranches', async () => {
			await active.swap();
			refreshAll();
		}),
		registerCommand('searchlight.copyCompareBranch', () =>
			comparisonProvider.copyCompareBranchName(),
		),
		registerCommand('searchlight.copyComparePath', () =>
			comparisonProvider.copyCompareBranchPath(),
		),
		registerCommand('searchlight.refreshAll', async () => {
			await active.resolve();
			refreshAll('manual-resolve-refresh');
		}),
		registerCommand('searchlight.filesExpandAll', () => {
			filesProvider.setExpanded(true);
		}),
		registerCommand('searchlight.filesHideUncommitted', async () => {
			await filesProvider.setHideUncommitted(true);
		}),
		registerCommand('searchlight.filesShowUncommitted', async () => {
			await filesProvider.setHideUncommitted(false);
		}),
		registerCommand('searchlight.conversationsHideResolved', async () => {
			await conversationsProvider.setHideResolved(true);
		}),
		registerCommand('searchlight.conversationsShowResolved', async () => {
			await conversationsProvider.setHideResolved(false);
		}),
		registerCommand('searchlight.collapseAllCommits', () => {
			// The Commits pane is a webview (Phase D); collapsing is pure UI state
			// posted to the webview, which collapses all expanded commit rows.
			commitsProvider.setExpanded(false);
		}),
		registerCommand(
			'searchlight.updateStaleBranch',
			async (row?: 'base' | 'compare') => {
				await updateStaleBranch(active, row, () => refreshAll('git-operation'));
			},
		),
		registerCommand('searchlight.openFileDiff', async (relPath: string) => {
			await openFileDiff(active, relPath);
		}),
		registerCommand(
			'searchlight.openUncommittedFileDiff',
			async (relPath: string, group: UncommittedGroup) => {
				await openUncommittedFileDiff(active, relPath, group);
			},
		),
		registerCommand('searchlight.openCumulativeFileDiff', async (relPath: string) => {
			await openCumulativeFileDiff(active, relPath);
		}),
		registerCommand('searchlight.openCommitDiff', async (sha: string) => {
			await openCommitDiff(active, sha);
		}),
		registerCommand(
			'searchlight.openCommitFileDiff',
			async (sha: string, relPath: string) => {
				await openCommitFileDiff(active, sha, relPath);
			},
		),
		registerCommand('searchlight.openTerminal', () => {
			const leaf = active.compare ? shortBranch(active.compare) : 'terminal';
			const terminal = vscode.window.createTerminal({
				name: `Searchlight: ${leaf}`,
				cwd: active.repoRootFsPath,
			});
			terminal.show();
		}),
		registerCommand('searchlight.commitsViewAllChanges', async () => {
			await openAllChangesDiff(active);
		}),
		registerCommand('searchlight.copyCommitSha', async (node?: unknown) => {
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
	const refreshReviews = (uri: vscode.Uri, reason: string): void => {
		conversationDocuments.refresh(uri);
		conversationPages.refresh(uri);
		void active.reloadReview().then(() => refreshAll(reason)).catch((error) => {
			log(`Could not refresh saved reviews: ${errMessage(error)}`);
		});
	};
	watcher.onDidCreate((uri) => refreshReviews(uri, 'review-created'));
	watcher.onDidChange((uri) => refreshReviews(uri, 'review-changed'));
	watcher.onDidDelete((uri) => refreshReviews(uri, 'review-deleted'));
	context.subscriptions.push(watcher);

	// Early startup enables inline discussions and usage observation only. This initializer is
	// invoked later by a pane, comparison command, or new-thread submission, never just by activation.
	perf('activate total', tActivate);

	initializeComparison = () => trace('startup.background', async () => {
		const tBg = now();

		const tRepo = now();
		const detectedRoot = await trace('startup.repoRoot', () => getRepoRoot(wsFolder));
		const repoRoot = detectedRoot ?? wsFolder;
		event('startup.repoRootResult', { fallback: !detectedRoot });
		perf('getRepoRoot', tRepo);
		active.repoRootFsPath = repoRoot;

		// Populate the four views: compute default base/compare (unless disabled), resolve, refresh.
		const autoCreateOnEmpty = vscode.workspace
			.getConfiguration('searchlight')
			.get<boolean>('autoCreateOnEmpty', true);
		if (autoCreateOnEmpty) {
			const tDefaults = now();
			await active.computeDefaults();
			perf('computeDefaults', tDefaults);
		}
		const tResolve = now();
		await active.resolve();
		perf('resolve', tResolve);
		setComparisonSettled();
		milestone('startup.comparisonResolved', { outcome: active.baselineError ? 'error' : active.baselineCommit ? 'ready' : 'unselected' });
		refreshAll('startup');

		// Watch for branch switches. Nothing else observes `git checkout`, so without this the panes
		// keep showing whatever branch was current at activation. Debounced because git fires several
		// state events per checkout; `inFlight` prevents the handler re-entering itself (resolve() can
		// mutate `compare` via auto-follow, but that is idempotent and refreshAll() only posts webview
		// state — neither touches git, so this cannot loop).
		let headTimer: NodeJS.Timeout | undefined;
		let inFlight = false;
		const onHeadChanged = (reason = 'git-api-state'): void => {
			if (reason === 'ref-changed' || reason === 'ref-created' || reason === 'ref-deleted') {
				comparisonProvider.invalidateBranches();
			}
			event('refs.refreshRequested', { reason, coalesced: !!headTimer, inFlight });
			if (headTimer) {
				clearTimeout(headTimer);
			}
			headTimer = setTimeout(() => {
				headTimer = undefined;
				if (inFlight) {
					// A ref update during resolution must trigger another pass, not be dropped.
					onHeadChanged('retry-in-flight');
					return;
				}
				inFlight = true;
				void (async () => {
					try {
						await active.resolve();
						refreshAll(reason);
					} finally {
						inFlight = false;
					}
				})();
			}, 250);
		};

		const repoSub = await trace('startup.gitSubscription', () =>
			gitApi.onRepoStateChanged(repoRoot, onHeadChanged, () => comparisonProvider.invalidateBranches()));
		if (repoSub) {
			context.subscriptions.push(repoSub);
		}

		// Auto-reveal: track the active editor in the Changed Files tree. Reveal-only — it never opens
		// or closes an editor, so it cannot fight the user's tab focus.
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((ed) => filesProvider.revealForUri(ed?.document.uri)),
		);
		// Reveal whatever is already open, so a file open at activation doesn't wait for a tab switch.
		filesProvider.revealForUri(vscode.window.activeTextEditor?.document.uri);
		// ASSUMPTION: linked worktrees share target refs but have their own HEAD. Ask git for
		// both locations so rebases, fetches and updates from another worktree all refresh the base.
		try {
			const [headPath, commonDir] = await Promise.all([
				runGitQuery(repoRoot, ['rev-parse', '--git-path', 'HEAD']),
				runGitQuery(repoRoot, ['rev-parse', '--git-common-dir']),
			]);
			const absoluteHead = path.resolve(repoRoot, headPath);
			const patterns = [
				new vscode.RelativePattern(vscode.Uri.file(path.dirname(absoluteHead)), path.basename(absoluteHead)),
				new vscode.RelativePattern(vscode.Uri.file(path.resolve(repoRoot, commonDir)), '{refs/**,packed-refs}'),
			];
			for (const pattern of patterns) {
				const watcher = vscode.workspace.createFileSystemWatcher(pattern);
				watcher.onDidChange(() => onHeadChanged('ref-changed'));
				watcher.onDidCreate(() => onHeadChanged('ref-created'));
				watcher.onDidDelete(() => onHeadChanged('ref-deleted'));
				context.subscriptions.push(watcher);
			}
		} catch (error) {
			log(`Could not watch comparison refs: ${errMessage(error)}`);
			void vscode.window.showWarningMessage('Searchlight: ref watching is unavailable. Use Refresh after updating branches.');
		}

		perf('background init total', tBg);
		milestone('startup.backgroundComplete');
	});
	event('startup.comparisonDeferred');
	milestone('activation.return');
}

export function deactivate(): void {
	emitUsageSummary();
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
		`and set thread state appropriately. Threads without filePath are review-wide threads; ` +
		`answer their messages without inventing a code location.`;

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
