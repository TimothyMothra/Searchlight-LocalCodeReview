/**
 * Small git helpers used by Searchlight.
 *
 * These intentionally shell out to `git` (rather than depending on the built-in vscode.git
 * extension API) so they work headlessly and in the Extension Development Host without waiting
 * for the git extension to activate. Each helper degrades gracefully to a sensible default.
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Run a git command in `cwd`; return trimmed stdout, or undefined on any failure. */
async function git(args: string, cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execAsync(`git ${args}`, { cwd, windowsHide: true });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

/** The configured git user.name for `cwd`, falling back to 'user' when unset. */
export async function getGitUserName(cwd: string): Promise<string> {
	const name = await git('config user.name', cwd);
	return name && name.length > 0 ? name : 'user';
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`), or undefined. */
export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	return git('rev-parse --abbrev-ref HEAD', cwd);
}

/** The current full commit sha (`git rev-parse HEAD`), or undefined. */
export async function getCurrentCommit(cwd: string): Promise<string | undefined> {
	return git('rev-parse HEAD', cwd);
}

/** A branch ref discovered via the git CLI. */
export interface BranchRef {
	/** Short name, e.g. 'main' or 'origin/main'. */
	name: string;
	kind: 'local' | 'remote';
	/** Commit sha the ref points at, when known. */
	commit?: string;
}

/** A worktree entry parsed from `git worktree list --porcelain`. */
export interface Worktree {
	/** Absolute path to the worktree directory. */
	path: string;
	/** Short branch name checked out there (e.g. 'main'), when not detached/bare. */
	branch?: string;
	/** HEAD commit sha, when known. */
	commit?: string;
	/** True for the bare repository entry. */
	bare: boolean;
}

/**
 * Run a git command via execFile (no shell) so `%(...)` format strings survive on Windows,
 * where cmd.exe would otherwise treat `%name%` as an environment variable reference.
 * Returns trimmed stdout, or undefined on any failure.
 */
async function gitv(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

/** The repository root for `cwd` (`git rev-parse --show-toplevel`), or undefined. */
export async function getRepoRoot(cwd: string): Promise<string | undefined> {
	return gitv(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * List local + remote branches via the git CLI (fallback when the vscode.git API is unavailable).
 * Remote HEAD pointers (e.g. `origin/HEAD`) are skipped.
 */
export async function listBranchesCli(cwd: string): Promise<BranchRef[]> {
	const refs: BranchRef[] = [];
	const parse = (out: string | undefined, kind: 'local' | 'remote') => {
		if (!out) {
			return;
		}
		for (const line of out.split(/\r?\n/)) {
			if (!line) {
				continue;
			}
			const [name, commit] = line.split('\t');
			if (!name || name.endsWith('/HEAD')) {
				continue;
			}
			refs.push({ name, kind, commit: commit || undefined });
		}
	};
	parse(await gitv(['for-each-ref', '--format=%(refname:short)\t%(objectname)', 'refs/heads'], cwd), 'local');
	parse(await gitv(['for-each-ref', '--format=%(refname:short)\t%(objectname)', 'refs/remotes'], cwd), 'remote');
	return refs;
}

/** Parse `git worktree list --porcelain` into structured worktree entries. */
export async function listWorktreesCli(cwd: string): Promise<Worktree[]> {
	const out = await gitv(['worktree', 'list', '--porcelain'], cwd);
	if (!out) {
		return [];
	}
	const worktrees: Worktree[] = [];
	let current: Partial<Worktree> | undefined;
	const flush = () => {
		if (current && current.path) {
			worktrees.push({
				path: current.path,
				branch: current.branch,
				commit: current.commit,
				bare: current.bare ?? false,
			});
		}
		current = undefined;
	};
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith('worktree ')) {
			flush();
			current = { path: line.slice('worktree '.length).trim(), bare: false };
		} else if (!current) {
			continue;
		} else if (line.startsWith('HEAD ')) {
			current.commit = line.slice('HEAD '.length).trim();
		} else if (line.startsWith('branch ')) {
			// e.g. 'branch refs/heads/main' → 'main'
			current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
		} else if (line.trim() === 'bare') {
			current.bare = true;
		} else if (line.trim() === 'detached') {
			current.branch = undefined;
		}
	}
	flush();
	return worktrees;
}

/**
 * `git pull` in `cwd` (CLI fallback for the vscode.git API path).
 * Throws on failure so callers can surface progress/error state.
 */
export async function pullCli(cwd: string): Promise<void> {
	await execFileAsync('git', ['pull'], { cwd, windowsHide: true });
}

/**
 * `git push` in `cwd` (CLI fallback). Optionally targets a specific remote/branch.
 * Throws on failure so callers can surface progress/error state.
 */
export async function pushCli(cwd: string, remote?: string, branch?: string): Promise<void> {
	const args = ['push'];
	if (remote) {
		args.push(remote);
		if (branch) {
			args.push(branch);
		}
	}
	await execFileAsync('git', args, { cwd, windowsHide: true });
}

/** A single commit entry from a log range. */
export interface CommitEntry {
	/** Full commit sha. */
	sha: string;
	/** Abbreviated commit sha. */
	shortSha: string;
	/** Commit subject line. */
	subject: string;
	/** Author name. */
	author: string;
	/** Relative commit date, e.g. '3 days ago'. */
	relDate: string;
}

/** A changed file plus its single-letter git status (M/A/D/R/C/U/T). */
export interface ChangedFile {
	/** Repo-relative, forward-slash path (the NEW path for renames/copies). */
	relPath: string;
	/** Single-letter status: M(odified) A(dded) D(eleted) R(enamed) C(opied) U(nmerged) T(ype-change). */
	status: string;
}

/**
 * Files changed between `base` and `compare` using the symmetric-difference (three-dot) range
 * `git diff --name-status base...compare` — i.e. changes on `compare` since it diverged from `base`.
 * `--name-status` is a single pass returning the same file list as `--name-only` plus a leading
 * status column (no extra git op). Returns `{ relPath, status }` per file, or `[]` on any failure.
 *
 * Line formats: `M\tpath`, `A\tpath`, `D\tpath`, `T\tpath` (one path); `R100\told\tnew`,
 * `C075\told\tnew` (two paths — the NEW path is used). The similarity score on R/C is stripped so
 * status collapses to a single letter.
 */
export async function changedFiles(cwd: string, base: string, compare: string): Promise<ChangedFile[]> {
	const out = await gitv(['diff', '--name-status', `${base}...${compare}`], cwd);
	if (!out) {
		return [];
	}
	const results: ChangedFile[] = [];
	for (const raw of out.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		const fields = line.split('\t');
		if (fields.length < 2) {
			continue;
		}
		// First char of the status field; for `R100`/`C075` this is `R`/`C` (score dropped).
		const status = fields[0].charAt(0).toUpperCase();
		// Renames/copies carry old+new paths; the NEW (last) field is the current path.
		const relPath = fields[fields.length - 1].trim();
		if (relPath.length === 0) {
			continue;
		}
		results.push({ relPath, status });
	}
	return results;
}

/**
 * Commits on `compare` not on `base` using the two-dot range `git log base..compare`.
 * Uses execFile (`gitv`) because the pretty-format string contains `%` specifiers.
 * Fields are split on the \x1f unit separator. Returns `[]` on any failure.
 *
 * Bounded to `cap` commits (default 200) to keep first render fast on large divergences:
 * we fetch `cap + 1` so we can tell the caller whether the log was truncated.
 */
export async function logRange(
	cwd: string,
	base: string,
	compare: string,
	cap = 200,
): Promise<{ commits: CommitEntry[]; truncated: boolean }> {
	const out = await gitv(
		[
			'log',
			`${base}..${compare}`,
			`--max-count=${cap + 1}`,
			'--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cr',
		],
		cwd,
	);
	if (!out) {
		return { commits: [], truncated: false };
	}
	const entries: CommitEntry[] = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line) {
			continue;
		}
		const [sha, shortSha, subject, author, relDate] = line.split('\x1f');
		if (!sha) {
			continue;
		}
		entries.push({
			sha,
			shortSha: shortSha ?? '',
			subject: subject ?? '',
			author: author ?? '',
			relDate: relDate ?? '',
		});
	}
	const truncated = entries.length > cap;
	return { commits: truncated ? entries.slice(0, cap) : entries, truncated };
}

/** Resolve a ref to its full commit sha (`git rev-parse <ref>`), or undefined on failure. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
	return gitv(['rev-parse', ref], cwd);
}

/**
 * Pick a sensible default TARGET (base) branch:
 * prefer a local `main`, else the remote default (origin/HEAD target), else the first branch.
 * Returns a branch name (e.g. 'main' or 'origin/develop'), or undefined when none can be found.
 */
export async function defaultBaseBranch(cwd: string): Promise<string | undefined> {
	// Prefer a local `main`.
	const localMain = await gitv(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], cwd);
	if (localMain) {
		return 'main';
	}
	// Else the remote default branch that origin/HEAD points at.
	const originHead = await gitv(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
	if (originHead) {
		return originHead.replace(/^refs\/remotes\//, '');
	}
	// Else the first branch we can list.
	const branches = await listBranchesCli(cwd);
	return branches.length > 0 ? branches[0].name : undefined;
}

/** Ahead/behind counts for a local `branch` versus its configured upstream. */
export interface AheadBehind {
	/** Commits on the local branch not yet on its upstream. */
	ahead: number;
	/** Commits on the upstream not yet on the local branch (stale-ness). */
	behind: number;
	/** Short upstream ref name, e.g. 'origin/main'. */
	upstream: string;
}

/**
 * How far `branch` is ahead of / behind its configured upstream. Returns undefined when the
 * branch has no upstream (nothing to compare against). Uses execFile (`gitv`) throughout;
 * the `@{upstream}` revision and `--left-right --count` avoid any `%`-format shell pitfalls.
 */
export async function aheadBehind(cwd: string, branch: string): Promise<AheadBehind | undefined> {
	// Resolve the upstream short name first; absence => no upstream configured.
	const upstream = await gitv(
		['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
		cwd,
	);
	if (!upstream) {
		return undefined;
	}
	// `git rev-list --left-right --count <branch>...<branch>@{upstream}` => "<ahead>\t<behind>".
	const counts = await gitv(
		['rev-list', '--left-right', '--count', `${branch}...${branch}@{upstream}`],
		cwd,
	);
	if (!counts) {
		return undefined;
	}
	const [aheadStr, behindStr] = counts.split(/\s+/);
	const ahead = Number.parseInt(aheadStr ?? '', 10);
	const behind = Number.parseInt(behindStr ?? '', 10);
	return {
		ahead: Number.isFinite(ahead) ? ahead : 0,
		behind: Number.isFinite(behind) ? behind : 0,
		upstream,
	};
}

/** Fetch from `remote` (default 'origin'). Returns true on success. */
export async function fetch(cwd: string, remote = 'origin'): Promise<boolean> {
	const out = await gitv(['fetch', remote], cwd);
	return out !== undefined;
}

/**
 * Fast-forward the currently checked-out `branch` to `upstream` via `git merge --ff-only`.
 * FF-only: never creates a merge commit and never rebases; returns false when not fast-forwardable
 * (i.e. the local branch has diverged), leaving the working tree untouched.
 */
export async function fastForward(cwd: string, upstream: string): Promise<boolean> {
	const out = await gitv(['merge', '--ff-only', upstream], cwd);
	return out !== undefined;
}

/**
 * Fast-forward a NON-checked-out local `branch` to `upstream` via a ref-only fetch
 * (`git fetch . <upstream>:<branch>`). Without a leading `+` the refspec is FF-only, so git
 * refuses (returns false) when the update would not be a fast-forward. Use this for a stale row
 * whose branch isn't the current HEAD; use `fastForward` when it is.
 */
export async function fastForwardRef(cwd: string, upstream: string, branch: string): Promise<boolean> {
	const out = await gitv(['fetch', '.', `${upstream}:${branch}`], cwd);
	return out !== undefined;
}

/**
 * List the files changed by a single commit `sha` (its diff against its first parent).
 * Uses `git diff-tree`, which correctly handles root commits (no parent) by listing all files,
 * unlike `sha^..sha` which errors on a parentless commit.
 */
export async function changedFilesForCommit(cwd: string, sha: string): Promise<string[]> {
	const out = await gitv(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], cwd);
	if (!out) {
		return [];
	}
	return out
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}
