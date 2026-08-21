/**
 * Thin wrapper over the built-in `vscode.git` extension API with a `git` CLI fallback.
 *
 * The extension prefers the vscode.git API for branch lists, current HEAD, and pull/push, but
 * every function degrades to the CLI helpers in git.ts when the API is unavailable (e.g. the git
 * extension is disabled, still activating, or the running host doesn't ship it). The extension
 * itself never calls a model — this module only inspects/drives git.
 *
 * `@types/vscode` does not ship the git extension's typings, so we declare the minimal structural
 * interfaces we depend on. Ref kinds are plain numeric constants (not a `const enum`) for
 * isolatedModules safety.
 */

import * as vscode from 'vscode';
import {
	BranchRef,
	Worktree,
	listBranchesCli,
	listWorktreesCli,
	getRepoRoot,
	pullCli,
	pushCli,
} from './git';

// vscode.git RefType numeric values (see the git extension's api/git.d.ts).
const REF_HEAD = 0;
const REF_REMOTE = 1;

interface ApiRef {
	readonly type: number;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

interface ApiHead {
	readonly name?: string;
	readonly commit?: string;
}

interface ApiRepoState {
	readonly HEAD?: ApiHead;
	readonly refs: ApiRef[];
	/** Fires whenever the repository's state changes (HEAD, refs, working tree, …). */
	readonly onDidChange: vscode.Event<void>;
}

interface ApiRepository {
	readonly rootUri: vscode.Uri;
	readonly state: ApiRepoState;
	pull(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

interface GitAPI {
	readonly repositories: ApiRepository[];
	getRepository(uri: vscode.Uri): ApiRepository | null;
	/** Fires when a repository is opened after the API was first resolved. */
	readonly onDidOpenRepository: vscode.Event<ApiRepository>;
}

interface GitExtensionExports {
	getAPI(version: 1): GitAPI;
}

/** Info about the current HEAD of a repository. */
export interface HeadInfo {
	branch?: string;
	commit?: string;
	detached: boolean;
}

/**
 * Resolve the vscode.git API (activating the extension if needed).
 * Returns undefined when the extension is missing or exports nothing usable.
 */
async function resolveGitApi(): Promise<GitAPI | undefined> {
	try {
		const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
		if (!ext) {
			return undefined;
		}
		const exports = ext.isActive ? ext.exports : await ext.activate();
		return exports?.getAPI(1);
	} catch {
		return undefined;
	}
}

/** Memoized handle to the resolved vscode.git API. */
let cachedApi: Promise<GitAPI | undefined> | undefined;

/**
 * Resolve (and cache) the vscode.git API. Re-resolving/re-activating the git extension on every
 * call is expensive, so the resolved API is memoized in a module-level promise. A failed
 * (undefined) result is NOT cached permanently — it is cleared so a later call can retry once the
 * git extension has finished activating.
 */
export function getGitApi(): Promise<GitAPI | undefined> {
	if (!cachedApi) {
		cachedApi = resolveGitApi().then((api) => {
			if (!api) {
				cachedApi = undefined; // let a later call retry once the git ext is ready
			}
			return api;
		});
	}
	return cachedApi;
}

/**
 * Pick the repository that owns `cwd`.
 *
 * Returns `undefined` rather than guessing when the lookup misses. The previous
 * `?? api.repositories[0]` fallback silently reported an unrelated repository's HEAD as the user's
 * current branch — a live failure mode with several worktrees of the same repo (plus other repos)
 * open at once. Every caller has a `cwd`-keyed git-CLI fallback, which is correct per-worktree, so
 * "no repo" is strictly better than "the wrong repo".
 */
function pickRepo(api: GitAPI, cwd: string): ApiRepository | undefined {
	const repo = api.getRepository(vscode.Uri.file(cwd));
	if (repo) {
		return repo;
	}
	// Exact rootUri match (or a path inside it) only — never an arbitrary repository.
	const target = vscode.Uri.file(cwd).fsPath.replace(/\\/g, '/').toLowerCase();
	return api.repositories.find((r) => {
		const root = r.rootUri?.fsPath?.replace(/\\/g, '/').toLowerCase();
		return root !== undefined && (target === root || target.startsWith(root + '/'));
	});
}

/**
 * Subscribe to git repository state changes (branch switch, commit, index/worktree edits) for the
 * repo owning `cwd`. Without this nothing observes a `git checkout`, so the panes keep showing the
 * branch that was current at activation.
 *
 * Returns `undefined` when the git API or the repo is unavailable — callers should fall back to a
 * `.git/HEAD` file watcher. Also watches `onDidOpenRepository` so a repo opened *after* activation
 * still gets wired up; the returned disposable tears down both subscriptions.
 */
export async function onRepoStateChanged(
	cwd: string,
	handler: () => void,
): Promise<vscode.Disposable | undefined> {
	const api = await getGitApi();
	if (!api) {
		return undefined;
	}
	const subs: vscode.Disposable[] = [];
	let bound: ApiRepository | undefined;

	const bind = (repo: ApiRepository): void => {
		if (bound === repo) {
			return;
		}
		bound = repo;
		subs.push(repo.state.onDidChange(handler));
	};

	const existing = pickRepo(api, cwd);
	if (existing) {
		bind(existing);
	}
	// A repo can be discovered after activation (slow git ext, folder added later). Re-check on open
	// so the subscription is not permanently lost in that race.
	try {
		subs.push(
			api.onDidOpenRepository(() => {
				const repo = pickRepo(api, cwd);
				if (repo) {
					bind(repo);
					handler();
				}
			}),
		);
	} catch {
		// onDidOpenRepository missing on this host — the initial binding above is still in effect.
	}

	if (subs.length === 0) {
		return undefined;
	}
	return new vscode.Disposable(() => {
		for (const s of subs) {
			s.dispose();
		}
	});
}

/** Whether any git repository is known for `cwd` (API first, then CLI toplevel probe). */
export async function hasRepository(cwd: string): Promise<boolean> {
	const api = await getGitApi();
	if (api && pickRepo(api, cwd)) {
		return true;
	}
	return (await getRepoRoot(cwd)) !== undefined;
}

/** List local + remote branches (vscode.git API first, CLI fallback). */
export async function listBranches(cwd: string): Promise<BranchRef[]> {
	const api = await getGitApi();
	const repo = api ? pickRepo(api, cwd) : undefined;
	if (repo) {
		const refs: BranchRef[] = [];
		for (const ref of repo.state.refs) {
			if (!ref.name) {
				continue;
			}
			if (ref.type === REF_HEAD) {
				refs.push({ name: ref.name, kind: 'local', commit: ref.commit });
			} else if (ref.type === REF_REMOTE) {
				if (ref.name.endsWith('/HEAD')) {
					continue;
				}
				refs.push({ name: ref.name, kind: 'remote', commit: ref.commit });
			}
		}
		if (refs.length > 0) {
			return refs;
		}
	}
	return listBranchesCli(cwd);
}

/** Current HEAD (branch/commit/detached) for `cwd` (API first, CLI fallback). */
export async function getHead(cwd: string): Promise<HeadInfo> {
	const api = await getGitApi();
	const repo = api ? pickRepo(api, cwd) : undefined;
	const head = repo?.state.HEAD;
	// Only trust the API when it actually has HEAD populated. A repo can be known but still
	// initializing, in which case `state.HEAD` is undefined and reporting "no branch" would be wrong
	// — fall through to the CLI instead.
	if (head) {
		return {
			branch: head.name,
			commit: head.commit,
			detached: !head.name,
		};
	}
	// CLI fallback: rev-parse abbrev; 'HEAD' means detached.
	const root = await getRepoRoot(cwd);
	if (!root) {
		return { detached: false };
	}
	const { getCurrentBranch, getCurrentCommit } = await import('./git');
	const branch = await getCurrentBranch(cwd);
	const commit = await getCurrentCommit(cwd);
	const detached = branch === 'HEAD';
	return { branch: detached ? undefined : branch, commit, detached };
}

/** `git pull` for `cwd` (API first, CLI fallback). Throws on failure. */
export async function pull(cwd: string): Promise<void> {
	const api = await getGitApi();
	const repo = api ? pickRepo(api, cwd) : undefined;
	if (repo) {
		await repo.pull();
		return;
	}
	await pullCli(cwd);
}

/** `git push` for `cwd` (API first, CLI fallback). Throws on failure. */
export async function push(cwd: string, remote?: string): Promise<void> {
	const api = await getGitApi();
	const repo = api ? pickRepo(api, cwd) : undefined;
	if (repo) {
		await repo.push(remote || undefined);
		return;
	}
	await pushCli(cwd, remote);
}

/** List worktrees for `cwd` (CLI only — the vscode.git API doesn't expose worktrees). */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
	return listWorktreesCli(cwd);
}
