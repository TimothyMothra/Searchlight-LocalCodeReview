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

/** Pick the repository that owns `cwd`, falling back to the first known repository. */
function pickRepo(api: GitAPI, cwd: string): ApiRepository | undefined {
	const repo = api.getRepository(vscode.Uri.file(cwd));
	return repo ?? api.repositories[0];
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
	if (repo) {
		const head = repo.state.HEAD;
		return {
			branch: head?.name,
			commit: head?.commit,
			detached: !!head && !head.name,
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
