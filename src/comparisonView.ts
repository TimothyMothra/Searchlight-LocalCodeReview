/**
 * WebviewView for the "Comparison" view — an in-place inline branch selector (base + compare).
 *
 * Replaces the former two-row TreeView, whose rows fired `showQuickPick` (a top-center popup users
 * mistook for the Command Palette / search bar). Instead this renders two `<input>` + filterable
 * dropdown fields directly in the view, a live status line, and a per-row Pull/Update button that
 * fast-forwards a stale local branch to its upstream (FF-only, never merge/rebase).
 */

import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { aheadBehind, listWorktreesCli } from './git';
import * as gitApi from './gitApi';

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
}

type Row = 'base' | 'compare';

export class ComparisonWebviewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'searchlight.comparison';

	private view?: vscode.WebviewView;

	constructor(
		private readonly getActive: () => ActiveComparison | undefined,
		private readonly onSelectBase: (branch: string) => void | Promise<void>,
		private readonly onSelectCompare: (branch: string) => void | Promise<void>,
		private readonly onPull: (row: Row) => void | Promise<void>,
	) {}

	/** Kept named `refresh` so the extension's `refreshAll` closure is unchanged. */
	refresh(): void {
		void this.postState();
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
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.html();
		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; branch?: string; row?: string }) => {
			switch (msg.type) {
				case 'ready':
				case 'refreshBranches':
					await this.postState();
					break;
				case 'selectBase':
					if (msg.branch) {
						await this.onSelectBase(msg.branch);
					}
					break;
				case 'selectCompare':
					if (msg.branch) {
						await this.onSelectCompare(msg.branch);
					}
					break;
				case 'pullBase':
					await this.onPull('base');
					break;
				case 'pullCompare':
					await this.onPull('compare');
					break;
			}
		});
		void this.postState();
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

	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const active = this.getActive();
		if (!active) {
			void this.view.webview.postMessage({ type: 'state', branches: [], base: null, compare: null });
			return;
		}
		const cwd = active.repoRootFsPath;
		const [branchRefs, head] = await Promise.all([gitApi.listBranches(cwd), gitApi.getHead(cwd)]);
		const headBranch = head.detached ? undefined : head.branch;
		const branches: BranchItem[] = branchRefs
			.map((b) => ({
				name: b.name,
				kind: b.kind,
				isHead: b.kind === 'local' && b.name === headBranch,
			}))
			.sort((a, b) => {
				// Local branches first, then alphabetical.
				if (a.kind !== b.kind) {
					return a.kind === 'local' ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			});

		const [baseStale, compareStale] = await Promise.all([
			this.staleness(cwd, active.base),
			this.staleness(cwd, active.compare),
		]);

		const base = active.base ?? null;
		const compare = active.compare ?? null;
		void this.view.webview.postMessage({
			type: 'state',
			branches,
			base,
			compare,
			headBranch: headBranch ?? null,
			baseStale: baseStale ?? null,
			compareStale: compareStale ?? null,
			ready: !!(base && compare && base !== compare),
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
  }
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
    max-height: 220px;
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
    margin-top: 6px;
    padding: 4px 6px;
    border-radius: 2px;
    font-size: 12px;
  }
  .status-bar.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .status-bar.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
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
  <div class="field" data-row="base">
    <label class="field-label">Base (target)</label>
    <div class="field-row">
      <input class="branch-input" data-row="base" type="text" placeholder="Select base branch…" autocomplete="off" spellcheck="false" />
      <button class="pull-btn" data-row="base" title="Fetch + fast-forward this branch to its upstream">↻ Update</button>
    </div>
    <div class="dropdown" data-row="base"></div>
  </div>

  <div class="field" data-row="compare">
    <label class="field-label">Compare (source)</label>
    <div class="field-row">
      <input class="branch-input" data-row="compare" type="text" placeholder="Select compare branch…" autocomplete="off" spellcheck="false" />
      <button class="pull-btn" data-row="compare" title="Fetch + fast-forward this branch to its upstream">↻ Update</button>
    </div>
    <div class="dropdown" data-row="compare"></div>
  </div>

  <div class="status-bar" id="status"></div>

<script>
  const vscode = acquireVsCodeApi();
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
      item.innerHTML =
        '<span class="check">' + check + '</span>' +
        '<span class="name">' + b.name + '</span>' +
        '<span class="tag">' + tag + '</span>';
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
    inputs[row].addEventListener('focus', () => { activeIndex[row] = -1; renderDropdown(row); });
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
    if (state.sameBranch) {
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
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
