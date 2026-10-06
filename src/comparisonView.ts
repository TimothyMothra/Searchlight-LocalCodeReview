/**
 * WebviewView for the "Comparison" view — an in-place inline branch selector (base + compare).
 *
 * Replaces the former two-row TreeView, whose rows fired `showQuickPick` (a top-center popup users
 * mistook for the Command Palette / search bar). Instead this renders two `<input>` + filterable
 * dropdown fields directly in the view, a live status line, and a per-row Pull/Update button that
 * fast-forwards a stale local branch to its upstream (FF-only, never merge/rebase).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ActiveComparison } from './activeComparison';
import { aheadBehind, BranchRef, changedFilesForCommit, commitAncestry, CommitEntry, listWorktreesCli } from './git';
import * as gitApi from './gitApi';
import { PaneMetrics } from './webviewMetrics';
import { renderMetricsScript } from './webviewShell';
import { event, trace } from './diagnostics';
import { COMMITS_CSS, COMMITS_JS } from './commitsWebview';

/** A stale row is `behind` its `upstream` (only sent when behind > 0). */
interface Staleness {
	behind: number;
	upstream: string;
}

/** One selectable branch pushed to the webview. */
interface BranchItem {
	name: string;
	kind: 'local' | 'remote';
	isHead: boolean;
	commit?: string;
}

type Row = 'base' | 'compare';

export class ComparisonWebviewProvider implements vscode.WebviewViewProvider {
	private readonly metrics = new PaneMetrics('comparison');
	static readonly viewType = 'searchlight.comparison';

	private view?: vscode.WebviewView;
	private stateVersion = 0;
	private catalogGeneration = 0;
	private catalog?: { cwd: string; refs: BranchRef[] };
	private catalogLoad?: { cwd: string; generation: number; promise: Promise<BranchRef[]> };

	constructor(
		private readonly getActive: () => ActiveComparison | undefined,
		private readonly onSelectBase: (branch: string) => void | Promise<void>,
		private readonly onSelectCompare: (branch: string) => void | Promise<void>,
		private readonly onPull: (row: Row) => void | Promise<void>,
		private readonly onBaseline: (reset: boolean) => void | Promise<void>,
	) {}

	/** Kept named `refresh` so the extension's `refreshAll` closure is unchanged. */
	refresh(reloadBranches = false): void {
		if (reloadBranches) { this.invalidateBranches(); }
		void this.postState();
	}

	/** Native context menus carry the immutable SHA of the selected history row. */
	async setCommitAsBase(context: unknown): Promise<void> {
		const sha = typeof context === 'string' ? context :
			context && typeof context === 'object' && 'sha' in context ? context.sha : undefined;
		if (typeof sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
			throw new Error('Set as Base requires a full commit SHA.');
		}
		await this.onSelectBase(sha);
	}

	setCommitsExpanded(value: boolean): void {
		void this.view?.webview.postMessage({ type: 'setExpanded', value });
	}

	invalidateBranches(): void {
		this.catalogGeneration++;
		this.catalog = undefined;
		this.stateVersion++;
		event('comparison.catalogInvalidated');
	}

	private repoKey(cwd: string): string {
		const resolved = path.resolve(cwd);
		// VS Code uses native paths while git prints forward slashes; Windows casing is immaterial.
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	}

	private async loadBranches(cwd: string): Promise<BranchRef[]> {
		const key = this.repoKey(cwd);
		if (this.catalog?.cwd === key) {
			event('comparison.catalogCache', { outcome: 'hit' });
			return this.catalog.refs;
		}
		let load = this.catalogLoad;
		if (!load || load.cwd !== key) {
			event('comparison.catalogCache', { outcome: 'miss' });
			load = { cwd: key, generation: this.catalogGeneration, promise: gitApi.listBranches(cwd) };
			this.catalogLoad = load;
		} else {
			event('comparison.catalogCache', { outcome: 'join' });
		}
		let refs: BranchRef[];
		try {
			refs = await load.promise;
		} finally {
			if (this.catalogLoad === load) { this.catalogLoad = undefined; }
		}
		// ASSUMPTION: ref changes during enumeration invalidate its result. Wait for that query
		// to finish before starting one replacement, rather than overlapping expensive git scans.
		if (load.generation !== this.catalogGeneration) {
			return this.loadBranches(cwd);
		}
		// Empty results can be transient CLI fallbacks; never retain them across later refreshes.
		const current = this.getActive();
		if (refs.length > 0 && current && key === this.repoKey(current.repoRootFsPath)) {
			this.catalog = { cwd: key, refs };
		}
		return refs;
	}

	/** Copy the COMPARE (source) branch name to the clipboard. */
	async copyCompareBranchName(): Promise<void> {
		const active = this.getActive();
		const b = active?.compare;
		if (b) {
			await vscode.env.clipboard.writeText(b);
			void vscode.window.showInformationMessage(`Copied branch: ${b}`);
		}
	}

	/**
	 * Copy the COMPARE (source) branch's checkout/worktree directory to the clipboard.
	 * Falls back to the repo root when that branch isn't checked out in any worktree.
	 */
	async copyCompareBranchPath(): Promise<void> {
		const active = this.getActive();
		const branch = active?.compare;
		if (!active || !branch) {
			return;
		}
		const cwd = active.repoRootFsPath;
		// Map the compare branch to its dedicated worktree dir; fall back to the
		// repo root when the branch isn't checked out in any worktree.
		const worktrees = await listWorktreesCli(cwd);
		const match = worktrees.find((w) => w.branch === branch);
		const path = match?.path ?? cwd;
		if (!match) {
			console.warn(`[searchlight] copyComparePath: branch ${branch} has no dedicated worktree; using repo root`);
		}
		await vscode.env.clipboard.writeText(path);
		void vscode.window.showInformationMessage(`Copied path: ${path}`);
	}

	/**
	 * Report the outcome of a Pull/Update op back to the webview so the row's
	 * button can show (on error) or clear (on success) an inline ⚠ triangle.
	 */
	postUpdateResult(row: Row, ok: boolean, message?: string): void {
		this.view?.webview.postMessage({ type: ok ? 'updateOk' : 'updateError', row, message });
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.stateVersion++;
		this.view = webviewView;
		this.metrics.bind(webviewView);
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.html();
		webviewView.webview.onDidReceiveMessage(async (msg: {
			type: string; branch?: string; sourceSha?: string; startSha?: string; baseSha?: string;
			mode?: string; requestId?: number; sha?: string; relPath?: string;
		}) => {
			try {
				switch (msg.type) {
				case 'ready':
					await this.postState(msg.type);
					break;
				case 'refreshBranches':
					this.invalidateBranches();
					await this.postState(msg.type);
					break;
				case 'selectBase':
					if (typeof msg.branch === 'string' && msg.branch) {
						await this.onSelectBase(msg.branch);
					}
					break;
				case 'selectCompare':
					if (typeof msg.branch === 'string' && msg.branch) {
						await this.onSelectCompare(msg.branch);
					}
					break;
				case 'pullBase':
					await this.onPull('base');
					break;
				case 'pullCompare':
					await this.onPull('compare');
					break;
				case 'pinBaseline':
					await this.onBaseline(false);
					break;
				case 'autoBaseline':
					await this.onBaseline(true);
					break;
				case 'loadCommits':
					await this.postCommits(msg.mode, msg.sourceSha, msg.startSha, msg.baseSha, msg.requestId);
					break;
				case 'expand':
					if (msg.sha) { await this.postCommitFiles(msg.sha); }
					break;
				case 'openCommitFile':
					if (msg.sha && msg.relPath) {
						await vscode.commands.executeCommand('searchlight.openCommitFileDiff', msg.sha, msg.relPath);
					}
					break;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error('[searchlight] Comparison selection failed:', error);
				await this.postState();
				void this.view?.webview.postMessage({ type: 'selectionError', message });
			}
		});
		void this.postState('view-resolve');
	}

	private async postCommits(mode?: string, sourceSha?: string, startSha?: string, baseSha?: string, requestId?: number): Promise<void> {
		try {
			const active = this.getActive();
			if (!active || !sourceSha || sourceSha !== active.compareCommit ||
				(mode === 'review' && (!baseSha || baseSha !== active.baselineCommit || active.baselineError))) {
				throw new Error('The comparison changed or is unresolved. Refresh and try again.');
			}
			if (mode !== 'history' && mode !== 'review') {
				throw new Error('Unknown commit-list mode.');
			}
			const key = active.comparisonKey;
			let page: { commits: CommitEntry[]; next?: string; truncated?: boolean };
			if (mode === 'history') {
				if (!startSha) {
					throw new Error('History requires a starting commit.');
				}
				page = await commitAncestry(active.repoRootFsPath, startSha);
			} else {
				page = await active.getCommits();
			}
			// A pin/ref change can overtake the query before its replacement state reaches the client.
			if (active !== this.getActive() || sourceSha !== active.compareCommit ||
				(mode === 'review' && key !== active.comparisonKey)) {
				throw new Error('The comparison changed while loading commits. Refresh and try again.');
			}
			void this.view?.webview.postMessage({ type: 'commitPage', mode, sourceSha, baseSha, requestId, ...page });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('[searchlight] Commit lookup failed:', error);
			void this.view?.webview.postMessage({ type: 'commitPage', mode, sourceSha, baseSha, requestId, error: message });
		}
	}

	private async postCommitFiles(sha: string): Promise<void> {
		try {
			const active = this.getActive();
			if (!active) {
				throw new Error('No active comparison.');
			}
			const files = await changedFilesForCommit(active.repoRootFsPath, sha);
			void this.view?.webview.postMessage({ type: 'files', sha, files });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('[searchlight] Commit file lookup failed:', error);
			void this.view?.webview.postMessage({ type: 'files', sha, error: message });
		}
	}

	/** Ahead/behind staleness for a local branch (skipped for remote-tracking refs / no upstream). */
	private async staleness(cwd: string, branch: string | undefined): Promise<Staleness | undefined> {
		if (!branch || branch.includes('/')) {
			return undefined;
		}
		const ab = await aheadBehind(cwd, branch);
		if (!ab || ab.behind === 0) {
			return undefined;
		}
		return { behind: ab.behind, upstream: ab.upstream };
	}

	private async postState(reason = 'refresh-or-action'): Promise<void> {
		const version = ++this.stateVersion;
		return this.metrics.build(() => this.buildState(version), reason);
	}

	private async buildState(version: number): Promise<void> {
		if (!this.view) {
			return;
		}
		const active = this.getActive();
		if (!active) {
			this.metrics.post({ type: 'state', branches: [], base: null, compare: null });
			return;
		}
		const cwd = active.repoRootFsPath;
		const comparisonKey = active.comparisonKey;
		const [branchRefs, head] = await trace('comparison.branches', () =>
			Promise.all([this.loadBranches(cwd), gitApi.getHead(cwd)]));
		const overtaken = () => version !== this.stateVersion || active !== this.getActive() ||
			cwd !== active.repoRootFsPath || comparisonKey !== active.comparisonKey;
		if (overtaken()) {
			event('comparison.stateDiscarded', { phase: 'branches' });
			return;
		}
		event('comparison.branchCount', { count: branchRefs.length });
		const headBranch = head.detached ? undefined : head.branch;
		const branches: BranchItem[] = branchRefs
			.map((b) => ({
				name: b.name,
				kind: b.kind,
				isHead: b.kind === 'local' && b.name === headBranch,
				commit: b.commit,
			}))
			.sort((a, b) => {
				// Local branches first, then alphabetical.
				if (a.kind !== b.kind) {
					return a.kind === 'local' ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			});

		const [baseStale, compareStale] = await trace('comparison.staleness', () => Promise.all([
			this.staleness(cwd, active.base),
			this.staleness(cwd, active.compare),
		]));
		if (overtaken()) {
			event('comparison.stateDiscarded', { phase: 'staleness' });
			return;
		}

		const base = active.base ?? null;
		const compare = active.compare ?? null;
		this.metrics.post({
			type: 'state',
			branches,
			base,
			compare,
			baseCommit: active.baselineCommit ?? null,
			targetCommit: active.baseCommit ?? null,
			compareCommit: active.compareCommit ?? null,
			mergeBaseCommit: active.baselinePin ? null : active.baselineCommit ?? null,
			baseExplanation: active.baseExplanation ?? null,
			baselineCommit: active.baselineCommit ?? null,
			baselinePin: active.baselinePin ?? null,
			baselineReason: active.baselineReason,
			baselineError: active.baselineError ?? null,
			headBranch: headBranch ?? null,
			baseStale: baseStale ?? null,
			compareStale: compareStale ?? null,
			ready: !!(base && compare && active.baselineCommit),
			sameBranch: !!(base && compare && base === compare),
		});
	}

	private html(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .selectors { flex: 0 0 auto; }
  .field { margin-bottom: 10px; position: relative; }
  .field-label {
    display: block;
    margin-bottom: 3px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
  }
  .field-row { display: flex; gap: 4px; align-items: stretch; }
  .branch-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    outline: none;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .branch-input:focus { border-color: var(--vscode-focusBorder); }
  .pull-btn {
    flex: 0 0 auto;
    display: none;
    align-items: center;
    padding: 0 8px;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }
  .pull-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
  }
  .pull-btn.stale {
    display: inline-flex;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .pull-btn.stale:hover { background: var(--vscode-button-hoverBackground); }
  /* Always-visible per-row copy buttons (branch name / worktree path). Mirrors .pull-btn's
     theme-var styling but is shown unconditionally (unlike .pull-btn which is display:none
     until stale). Kept compact so the two glyph buttons sit next to the Update button. */
  .icon-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
  }
  .icon-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
  }
  .dropdown {
    display: none;
    position: absolute;
    left: 0; right: 0;
    z-index: 10;
    margin-top: 2px;
    /* Cap to the pane height so a short Comparison pane (initialSize 150px) doesn't clip the list.
       vh resolves against the webview's own viewport (the pane), not the .field offset parent,
       so this tracks the actual pane height; 96px reserves the field rows above the dropdown. */
    max-height: min(220px, calc(100vh - 96px));
    overflow-y: auto;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 2px;
  }
  .dropdown.open { display: block; }
  .dropdown-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    cursor: pointer;
  }
  .dropdown-item.active,
  .dropdown-item:hover {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .dropdown-item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-item .tag {
    flex: 0 0 auto;
    font-size: 10px;
    opacity: 0.7;
    text-transform: uppercase;
  }
  .dropdown-item .check { flex: 0 0 auto; opacity: 0.9; }
  .status-bar {
    margin-top: 4px;
    border-radius: 2px;
    font-size: 12px;
  }
  .status-bar:empty, .explanation:empty { display: none; }
  .status-bar.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .status-bar.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
  .baseline-detail { margin-top: 4px; font-size: 11px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
  .explanation { font-size: 11px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
${COMMITS_CSS}
  .warn-tri { color: var(--vscode-editorWarning-foreground, #d29922); margin-left: 4px; }
  .pull-btn:disabled { opacity: 0.85; cursor: default; }
  .spinner {
    display: inline-block;
    width: 10px; height: 10px;
    margin-right: 4px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    vertical-align: -1px;
    animation: sl-spin 0.7s linear infinite;
  }
  @keyframes sl-spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="selectors">
  <div class="field" data-row="base">
    <label class="field-label" for="base-input">Base (target)</label>
    <div class="field-row">
      <input id="base-input" class="branch-input" data-row="base" type="text" placeholder="Select branch or right-click a commit…" autocomplete="off" spellcheck="false" />
      <button class="pull-btn" data-row="base" title="Fetch + fast-forward this branch to its upstream">↻ Update</button>
    </div>
    <div class="dropdown" data-row="base"></div>
  </div>

  <div class="field" data-row="compare">
    <label class="field-label" for="compare-input">Compare (source)</label>
    <div class="field-row">
      <input id="compare-input" class="branch-input" data-row="compare" type="text" placeholder="Select compare branch…" autocomplete="off" spellcheck="false" />
      <button class="pull-btn" data-row="compare" title="Fetch + fast-forward this branch to its upstream">↻ Update</button>
    </div>
    <div class="dropdown" data-row="compare"></div>
  </div>

  <div class="field">
    <label class="field-label">Effective baseline</label>
    <div class="field-row">
      <span id="baseline" style="flex: 1; overflow-wrap: anywhere;">Not resolved</span>
      <button class="icon-btn" id="pin-baseline" title="Use an explicit ancestor commit as the baseline">⌖ Pin</button>
      <button class="icon-btn" id="auto-baseline" title="Clear the pin and resolve shared ancestry automatically">↻ Auto</button>
    </div>
    <div class="baseline-detail" id="baseline-reason"></div>
  </div>
  <div class="status-bar" id="status" role="status"></div>
  <div class="explanation" id="base-explanation"></div>
  </div>
  <div class="commit-pane collapsed" id="commit-pane">
    <button class="commit-toggle" id="commit-toggle" type="button" aria-expanded="false" aria-controls="commit-content">▸ Commits</button>
    <div class="commit-content" id="commit-content" hidden>
      <div class="commit-toolbar">
        <button class="mode-btn" id="commit-history" type="button" aria-pressed="true" title="First-parent source history; right-click a commit to Set as Base">↶ History</button>
        <button class="mode-btn" id="commit-review" type="button" aria-pressed="false" title="Commits between the effective baseline and source">⇄ Review</button>
      </div>
      <div class="commit-scroll">
        <div id="commit-rows" role="tree" aria-label="Commits"></div>
        <div id="commit-status" class="commit-msg" role="status"></div>
        <button class="more-btn" id="commit-more" type="button" hidden>↓ Older commits</button>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  ${renderMetricsScript()}
  let branches = [];
  let selected = { base: null, compare: null };
  let headBranch = null;
  const activeIndex = { base: -1, compare: -1 };

  const inputs = {
    base: document.querySelector('.branch-input[data-row="base"]'),
    compare: document.querySelector('.branch-input[data-row="compare"]'),
  };
  const dropdowns = {
    base: document.querySelector('.dropdown[data-row="base"]'),
    compare: document.querySelector('.dropdown[data-row="compare"]'),
  };
  const pullBtns = {
    base: document.querySelector('.pull-btn[data-row="base"]'),
    compare: document.querySelector('.pull-btn[data-row="compare"]'),
  };
  const statusEl = document.getElementById('status');
  document.getElementById('pin-baseline').addEventListener('click', () => vscode.postMessage({ type: 'pinBaseline' }));
  document.getElementById('auto-baseline').addEventListener('click', () => vscode.postMessage({ type: 'autoBaseline' }));

  // Per-row UI state: last-known stale info and last-known update error (for the ⚠ triangle).
  const staleState = { base: null, compare: null };
  const errState = { base: null, compare: null };
  // Per-row in-flight state: true while a Pull/Update op is running (shows the spinner).
  const pending = { base: false, compare: false };

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function filtered(row) {
    const q = inputs[row].value.trim().toLowerCase();
    const list = q
      ? branches.filter((b) => b.name.toLowerCase().includes(q))
      : branches.slice();
    return list.slice(0, 50);
  }

  function renderDropdown(row) {
    const list = filtered(row);
    const dd = dropdowns[row];
    dd.innerHTML = '';
    list.forEach((b, i) => {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (i === activeIndex[row] ? ' active' : '');
      const check = selected[row] === b.name ? '✓ ' : '';
      const tag = b.isHead ? 'HEAD' : (b.kind === 'remote' ? 'remote' : '');
      for (const [className, text] of [['check', check], ['name', b.name], ['tag', tag]]) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        item.appendChild(span);
      }
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus so blur doesn't hide before click registers
        choose(row, b.name);
      });
      dd.appendChild(item);
    });
    dd.classList.toggle('open', list.length > 0);
  }

  function choose(row, name) {
    selected[row] = name;
    inputs[row].value = name;
    dropdowns[row].classList.remove('open');
    activeIndex[row] = -1;
    vscode.postMessage({ type: row === 'base' ? 'selectBase' : 'selectCompare', branch: name });
  }

  function move(row, delta) {
    const list = filtered(row);
    if (list.length === 0) { return; }
    activeIndex[row] = (activeIndex[row] + delta + list.length) % list.length;
    renderDropdown(row);
  }

  for (const row of ['base', 'compare']) {
    inputs[row].addEventListener('input', () => { activeIndex[row] = 0; renderDropdown(row); });
    inputs[row].addEventListener('focus', () => {
      vscode.postMessage({ type: 'usageAction', action: 'openBranchPicker' });
      activeIndex[row] = -1;
      renderDropdown(row);
    });
    inputs[row].addEventListener('blur', () => {
      setTimeout(() => dropdowns[row].classList.remove('open'), 150);
    });
    inputs[row].addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(row, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(row, -1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const list = filtered(row);
        const pick = activeIndex[row] >= 0 ? list[activeIndex[row]] : list[0];
        if (pick) { choose(row, pick.name); }
      } else if (e.key === 'Escape') {
        dropdowns[row].classList.remove('open');
      }
    });
    pullBtns[row].addEventListener('click', () => {
      // Ignore re-clicks while an op is already in flight for this row.
      if (pending[row]) { return; }
      pending[row] = true;
      renderPullBtn(row); // immediate spinner, before the git work starts
      vscode.postMessage({ type: row === 'base' ? 'pullBase' : 'pullCompare' });
    });
  }

  function renderPullBtn(row) {
    const btn = pullBtns[row];
    // In-flight: show an immediate spinner and disable re-click. Keep the row visible.
    if (pending[row]) {
      btn.classList.add('stale');
      btn.disabled = true;
      btn.title = 'Updating ' + (selected[row] || 'branch') + '…';
      btn.innerHTML = '<span class="spinner"></span>Updating…';
      return;
    }
    btn.disabled = false;
    const stale = staleState[row];
    let label;
    if (stale && stale.behind > 0) {
      btn.classList.add('stale');
      label = '↻ Update ⇣' + stale.behind;
      btn.title = selected[row] + ' is ' + stale.behind + ' behind ' + stale.upstream +
        ' — fast-forward it.';
    } else {
      btn.classList.remove('stale');
      label = '↻ Update';
      btn.title = 'Fetch + fast-forward this branch to its upstream';
    }
    const err = errState[row];
    if (err) {
      btn.innerHTML = label + ' <span class="warn-tri" title="' + escapeAttr(err) + '">⚠</span>';
      btn.title = err;
    } else {
      btn.textContent = label;
    }
  }

  function applyStale(row, stale) {
    staleState[row] = stale;
    // A successful refresh that shows the row is no longer behind clears any prior error.
    if (!stale || stale.behind <= 0) { errState[row] = null; }
    renderPullBtn(row);
  }

  function renderStatus(state) {
    const baseline = document.getElementById('baseline');
    const fixedTarget = state.base && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(state.base);
    baseline.textContent = state.baselineCommit
      ? state.baselineCommit.slice(0, 12) + (state.baselinePin || fixedTarget ? ' (pinned)' : ' (auto)')
      : (state.baselinePin ? state.baselinePin.slice(0, 12) + ' (invalid pin)' : 'Not resolved');
    baseline.title = [state.baselineCommit || state.baselinePin, state.baselineReason].filter(Boolean).join('\\n');
    document.getElementById('baseline-reason').title = state.baselineReason || '';
    document.getElementById('pin-baseline').disabled = !state.base || !state.compare;
    document.getElementById('auto-baseline').disabled = !state.baselinePin;
    if (state.baselineError) {
      statusEl.className = 'status-bar warn';
      statusEl.textContent = state.baselineError;
    } else if (state.sameBranch && !state.baselinePin) {
      statusEl.className = 'status-bar warn';
      statusEl.textContent = '⚠ Same branch selected';
    } else if (state.ready) {
      // Ready state is intentionally silent: the persistent "✓ Ready to review" box
      // was distracting. Keep the element (and class) so layout is stable, but no text.
      statusEl.className = 'status-bar ok';
      statusEl.textContent = '';
    } else {
      statusEl.className = 'status-bar';
      statusEl.textContent = 'Select a base and compare branch.';
    }
  }

  window.addEventListener('message', (event) => {
    const state = event.data;
    if (state.type === 'selectionError') {
      statusEl.className = 'status-bar warn';
      statusEl.textContent = '⚠ ' + state.message;
      return;
    }
    if (state.type === 'updateError') {
      pending[state.row] = false;
      errState[state.row] = state.message || 'Update failed';
      renderPullBtn(state.row);
      return;
    }
    if (state.type === 'updateOk') {
      pending[state.row] = false;
      errState[state.row] = null;
      renderPullBtn(state.row);
      return;
    }
    if (state.type !== 'state') { return; }
    const t0 = performance.now();
    branches = state.branches || [];
    selected.base = state.base;
    selected.compare = state.compare;
    headBranch = state.headBranch;
    // Reflect selection into inputs only when the field isn't being actively edited.
    if (document.activeElement !== inputs.base) { inputs.base.value = state.base || ''; }
    if (document.activeElement !== inputs.compare) { inputs.compare.value = state.compare || ''; }
    applyStale('base', state.baseStale);
    applyStale('compare', state.compareStale);
    renderStatus(state);
    const pinnedCommit = selected.base && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(selected.base);
    const explanation = document.getElementById('base-explanation');
    explanation.title = state.baseExplanation || (pinnedCommit ? 'Pinned commit: does not follow a branch.' : '');
    explanation.textContent = state.baseExplanation
      ? (state.baseExplanation.startsWith('Suggested') ? 'Suggested target' :
        state.baseExplanation.startsWith('Default') ? 'Default target' : '⚠ Target detection failed')
      : (pinnedCommit ? 'Pinned commit · ' + selected.base.slice(0, 7) : '');
    reportRendered('comparison', branches.length, t0);
  });

</script>
<script>${COMMITS_JS}</script>
<script>vscode.postMessage({ type: 'ready' });</script>
</body>
</html>`;
	}
}
