/**
 * Small git helpers used by Searchlight.
 *
 * These intentionally shell out to `git` (rather than depending on the built-in vscode.git
 * extension API) so they work headlessly and in the Extension Development Host without waiting
 * for the git extension to activate. Legacy helpers degrade gracefully; ancestry helpers throw so
 * callers can distinguish a failed read from an empty history.
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { event, trace } from './diagnostics';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const diagnosticCommands = new Set([
	'config', 'rev-parse', 'for-each-ref', 'worktree', 'pull', 'push', 'diff', 'log',
	'symbolic-ref', 'rev-list', 'fetch', 'merge', 'diff-tree', 'merge-base', 'ls-files',
]);
const diagnosticOptions = new Set([
	'--abbrev-ref', '--show-toplevel', '--format', '--porcelain', '--name-status',
	'--max-count', '--pretty', '--verify', '--end-of-options', '--quiet', '--left-right',
	'--count', '--ff-only', '--no-commit-id', '--name-only', '-r', '--cached',
	'--others', '--exclude-standard', '--is-ancestor', '--all',
	'--include-root-refs',
	'--first-parent', '--root', '--diff-merges',
	'-g', '--contains', '--no-contains',
]);

function commandFields(args: string[], execution: 'shell' | 'execFile'): Record<string, string> {
	// ASSUMPTION: only allowlisted command/option names are diagnostic data; argument values
	// (including format strings, refs, paths and user config) must never enter the trace.
	const options: string[] = [];
	for (const arg of args.slice(1)) {
		if (arg === '--' || arg === '--end-of-options') {
			if (arg === '--end-of-options') { options.push(arg); }
			break;
		}
		const option = arg.split('=', 1)[0];
		if (diagnosticOptions.has(option)) { options.push(option); }
	}
	return {
		execution,
		command: diagnosticCommands.has(args[0]) ? args[0] : 'other',
		options: options.join(' '),
		...(args[0] === 'worktree' && args[1] === 'list' ? { subcommand: 'list' } : {}),
	};
}

/** Run a git command in `cwd`; return trimmed stdout, or undefined on any failure. */
async function git(args: string, cwd: string): Promise<string | undefined> {
	const fields = commandFields(args.split(/\s+/), 'shell');
	try {
		const { stdout } = await trace('git.command',
			() => execAsync(`git ${args}`, { cwd, windowsHide: true }), fields);
		return stdout.trim();
	} catch {
		event('git.fallback', { ...fields, outcome: 'undefined' });
		return undefined;
	}
}

/** The configured git user.name for `cwd`, falling back to 'user' when unset. */
export async function getGitUserName(cwd: string): Promise<string> {
	const name = await git('config user.name', cwd);
	if (!name) { event('git.missing', { operation: 'userName', fallback: 'default' }); }
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
	/** Configured tracking upstream (not necessarily the review target). */
	upstream?: string;
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
async function gitv(args: string[], cwd: string, maxBuffer?: number): Promise<string | undefined> {
	try {
		return await runGitQuery(cwd, args, maxBuffer);
	} catch {
		event('git.fallback', { ...commandFields(args, 'execFile'), outcome: 'undefined' });
		return undefined;
	}
}

/** Read-only queries whose failures must be surfaced rather than treated as empty results. */
export async function runGitQuery(cwd: string, args: string[], maxBuffer?: number): Promise<string> {
	const { stdout } = await trace('git.command',
		() => execFileAsync('git', args, { cwd, windowsHide: true, ...(maxBuffer === undefined ? {} : { maxBuffer }) }),
		commandFields(args, 'execFile'));
	return stdout.trim();
}

/** The repository root for `cwd` (`git rev-parse --show-toplevel`), or undefined. */
export async function getRepoRoot(cwd: string): Promise<string | undefined> {
	return gitv(['rev-parse', '--show-toplevel'], cwd);
}

let supportsRootRefEnumeration: boolean | undefined;

/**
 * List local + remote branches via the git CLI (fallback when the vscode.git API is unavailable).
 * Remote HEAD pointers (e.g. `origin/HEAD`) are skipped.
 */
export async function listBranchesCli(cwd: string): Promise<BranchRef[]> {
	// %(refname:short) performs ambiguity lookups for each ref. On Windows these filesystem
	// probes dominated startup. Enumerate ordinary refs once and check common names in memory.
	const args = ['for-each-ref', '--format=%(refname)\t%(objectname)'];
	let out: string | undefined;
	if (supportsRootRefEnumeration !== false) {
		try {
			out = await runGitQuery(cwd, [...args, '--include-root-refs'], 16 * 1024 * 1024);
			supportsRootRefEnumeration = true;
		} catch (error) {
			// Older Git versions reject this optional flag with usage exit 129. Do not mask
			// repository/permission failures or change any Git configuration.
			if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 129) {
				event('git.fallback', { operation: 'branchCatalog', outcome: 'undefined' });
				return [];
			}
			supportsRootRefEnumeration = false;
			event('git.rootRefEnumerationUnsupported');
		}
	}
	if (supportsRootRefEnumeration === false) { out = await gitv(args, cwd, 16 * 1024 * 1024); }
	if (!out) { return []; }
	const rows = out.split(/\r?\n/).map((line) => line.split('\t'));
	// Windows loose-ref lookups may be case-insensitive; conservatively delegate those
	// collisions to Git rather than assuming packed-ref case behavior.
	const lookupKey = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
	const names = new Set(rows.map(([name]) => lookupKey(name)));
	const candidates: { fullName: string; ref: BranchRef; needsGit: boolean }[] = [];
	for (const [fullName, commit] of rows) {
		const kind = fullName.startsWith('refs/heads/') ? 'local' :
			fullName.startsWith('refs/remotes/') ? 'remote' : undefined;
		if (!kind || fullName.endsWith('/HEAD')) { continue; }
		const name = fullName.slice(kind === 'local' ? 'refs/heads/'.length : 'refs/remotes/'.length);
		const alternatives = [
			name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`,
			`refs/remotes/${name}`, `refs/remotes/${name}/HEAD`,
		];
		// ASSUMPTION: old Git cannot enumerate root refs. Delegate simple names in that case;
		// known collisions always use Git's own core.warnAmbiguousRefs-dependent shortening.
		const needsGit = (supportsRootRefEnumeration === false && !name.includes('/')) ||
			alternatives.some((candidate) => candidate !== fullName && names.has(lookupKey(candidate)));
		candidates.push({ fullName, ref: { name, kind, commit: commit || undefined }, needsGit });
	}
	const ambiguous = candidates.filter((candidate) => candidate.needsGit);
	const shortened = new Map<string, string>();
	// Bound argv length for Windows without truncating the catalog. Exact ref names cannot
	// have child refs (Git rejects file/directory ref conflicts), so these select only the exceptions.
	for (let index = 0; index < ambiguous.length;) {
		const batch: string[] = [];
		let length = 0;
		while (index < ambiguous.length && (batch.length === 0 || length + ambiguous[index].fullName.length < 12000)) {
			const name = ambiguous[index++].fullName;
			batch.push(name);
			length += name.length + 3;
		}
		const result = await gitv(['for-each-ref', '--format=%(refname)\t%(refname:short)', ...batch], cwd, 16 * 1024 * 1024);
		if (result === undefined) { return []; }
		for (const line of result.split(/\r?\n/)) {
			const [fullName, name] = line.split('\t');
			if (name) { shortened.set(fullName, name); }
		}
	}
	const refs: BranchRef[] = [];
	for (const candidate of candidates) {
		if (candidate.needsGit) {
			const name = shortened.get(candidate.fullName);
			// A ref removed during enumeration must not reappear under an invented shorthand.
			if (!name) {
				event('git.branchCatalogRemovedRef');
				continue;
			}
			candidate.ref.name = name;
		}
		refs.push(candidate.ref);
	}
	event('git.branchCatalog', {
		refCount: rows.length, branchCount: refs.length, shortenedByGit: ambiguous.length,
		rootRefsIncluded: supportsRootRefEnumeration,
	});
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
	await trace('git.command', () => execFileAsync('git', ['pull'], { cwd, windowsHide: true }),
		commandFields(['pull'], 'execFile'));
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
	await trace('git.command', () => execFileAsync('git', args, { cwd, windowsHide: true }),
		commandFields(args, 'execFile'));
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
 * Files changed between an already-resolved baseline commit and the compare commit.
 * ASSUMPTION: callers resolve the effective baseline once; do not recompute a merge-base here,
 * because an explicit baseline must be used exactly as selected.
 * `--name-status` is a single pass returning the same file list as `--name-only` plus a leading
 * status column (no extra git op). Returns `{ relPath, status }` per file, or `[]` on any failure.
 *
 * Line formats: `M\tpath`, `A\tpath`, `D\tpath`, `T\tpath` (one path); `R100\told\tnew`,
 * `C075\told\tnew` (two paths — the NEW path is used). The similarity score on R/C is stripped so
 * status collapses to a single letter.
 */
export async function changedFiles(cwd: string, base: string, compare: string): Promise<ChangedFile[]> {
	const out = await gitv(['diff', '--name-status', base, compare, '--'], cwd);
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
	return gitv(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd);
}

const branchRefArgs = [
	'for-each-ref', '--format=%(refname)\t%(objectname)\t%(upstream)\t%(symref)',
	'refs/heads', 'refs/remotes',
];

function parseBranchRefs(out: string): BranchRef[] {
	return out.split(/\r?\n/).flatMap((line): BranchRef[] => {
		const [ref, commit, upstream, symbolic] = line.split('\t');
		if (!ref || symbolic) { return []; }
		const kind = ref.startsWith('refs/heads/') ? 'local' : 'remote';
		const name = ref.replace(/^refs\/(heads|remotes)\//, '');
		return [{
			name, kind, commit: commit || undefined,
			upstream: upstream ? upstream.replace(/^refs\/(heads|remotes)\//, '') : undefined,
		}];
	});
}

export interface AncestryCommit extends CommitEntry {
	/** All parents; browsing follows only the first parent through merges. */
	parents: string[];
}

export interface AncestryPage {
	commits: AncestryCommit[];
	/** Inclusive start SHA for the next page, pinned independently of moving refs. */
	next?: string;
}

/** Read a bounded first-parent history page. Failures are surfaced by the caller, not empty history. */
export async function commitAncestry(cwd: string, startSha: string, cap = 50): Promise<AncestryPage> {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(startSha)) {
		throw new Error('Ancestry requires a resolved commit SHA.');
	}
	if (!Number.isInteger(cap) || cap < 1) {
		throw new Error('Ancestry page size must be a positive integer.');
	}
	const stdout = await runGitQuery(cwd, [
		'log', '--first-parent', `--max-count=${cap + 1}`,
		'--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1f%P', startSha, '--',
	]);
	const entries = stdout.trim().split(/\r?\n/).filter(Boolean).map((line): AncestryCommit => {
		const [sha, shortSha, subject, author, relDate, parents] = line.split('\x1f');
		return { sha, shortSha, subject, author, relDate, parents: parents ? parents.split(' ') : [] };
	});
	return { commits: entries.slice(0, cap), next: entries[cap]?.sha };
}

export interface BaseSuggestion {
	branch?: string;
	explanation: string;
}

/** Rebase/creation evidence can identify a parent whose live ref has advanced past the fork. */
async function recordedForkTarget(
	cwd: string, compare: string, sourceSha: string, refs: BranchRef[], candidates: BranchRef[],
): Promise<BranchRef | undefined> {
	const source = refs.find((ref) => ref.kind === 'local' &&
		ref.name === compare.replace(/^refs\/heads\//, ''));
	if (!source) { return undefined; }
	const log = await gitv(['log', '-g', '--max-count=200', '--pretty=format:%H%x1f%gs',
		`refs/heads/${source.name}`, '--'], cwd);
	for (const line of log?.split(/\r?\n/) ?? []) {
		const [commit, message = ''] = line.split('\x1f');
		const rebased = message.match(/^rebase \(finish\): .+ onto ([0-9a-f]{40}|[0-9a-f]{64})$/i);
		const created = message.match(/^branch: Created from (.+)$/);
		const fork = rebased?.[1] ?? (created ? commit : undefined);
		if (!fork || fork === sourceSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(fork)) { continue; }
		// ASSUMPTION: an old reflog entry is evidence only while its fork remains a source ancestor.
		if (await gitv(['merge-base', '--is-ancestor', fork, sourceSha], cwd) === undefined) { continue; }
		const output = await runGitQuery(cwd, ['for-each-ref', `--contains=${fork}`,
			`--no-contains=${sourceSha}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'],
			16 * 1024 * 1024);
		const qualified = new Set(output.split(/\r?\n/).map((name) => name.replace(/^refs\/(heads|remotes)\//, '')));
		const eligible = candidates.filter((ref) => qualified.has(ref.name));
		const named = created?.[1].replace(/^refs\/(heads|remotes)\//, '');
		const recorded = eligible.find((ref) => ref.name === named);
		if (recorded) { return recorded; }
		if (new Set(eligible.map((ref) => ref.commit)).size !== 1) { return undefined; }
		const locals = eligible.filter((ref) => ref.kind === 'local');
		const choices = locals.length ? locals : eligible;
		return choices.length === 1 ? choices[0] : undefined;
	}
	return undefined;
}

/**
 * Suggest a stacked-branch target only when the nearest first-parent branch tip is unambiguous.
 * ASSUMPTION: a nearby ancestor tip is useful evidence, not proof of the intended PR target.
 * Bound discovery to 200 commits; moved/deleted targets and ambiguous aliases require manual choice.
 */
export async function suggestBaseBranch(cwd: string, compare: string): Promise<BaseSuggestion> {
	const sha = await resolveCommit(cwd, compare);
	if (!sha) {
		throw new Error(`Cannot resolve source ${compare}.`);
	}
	const [page, refsResult, fallback] = await Promise.all([
		commitAncestry(cwd, sha, 200),
		runGitQuery(cwd, branchRefArgs, 16 * 1024 * 1024),
		defaultBaseBranch(cwd),
	]);
	const refs = parseBranchRefs(refsResult);
	const sourceLocals = refs.filter((ref) =>
		ref.kind === 'local' && (ref.name === compare || ref.commit === sha),
	);
	const sourceNames = new Set([compare, ...sourceLocals.map((ref) => ref.name)]);
	const sourceRemote = refs.find((ref) => ref.kind === 'remote' && ref.name === compare);
	if (sourceRemote) {
		sourceNames.add(compare.slice(compare.indexOf('/') + 1));
	}
	const upstreams = new Set(sourceLocals.map((ref) => ref.upstream).filter(Boolean));
	// A tracking copy of the source can lag behind HEAD. It must never become the target.
	// Local tips at a detached source SHA also supply tracking aliases to exclude.
	const candidates = refs.filter((ref) =>
		!sourceNames.has(ref.name) && !upstreams.has(ref.name) && ref.commit !== sha &&
		!(ref.kind === 'remote' && sourceNames.has(ref.name.slice(ref.name.indexOf('/') + 1))),
	);
	const recorded = await recordedForkTarget(cwd, compare, sha, refs, candidates);
	if (recorded) {
		return { branch: recorded.name,
			explanation: 'Suggested target: validated branch creation/rebase point, even though its tip has advanced.' };
	}
	for (const commit of page.commits.slice(1)) {
		const atCommit = candidates.filter((ref) => ref.commit === commit.sha);
		if (atCommit.length === 0) {
			continue;
		}
		// Local + remote copies of one tip are aliases; prefer a single local branch.
		const locals = atCommit.filter((ref) => ref.kind === 'local');
		const choices = locals.length > 0 ? locals : atCommit;
		if (choices.length === 1) {
			return {
				branch: choices[0].name,
				explanation: `Suggested target: nearest first-parent branch tip (${commit.shortSha}).`,
			};
		}
		return {
			branch: fallback,
			explanation: 'Default target: multiple branches label the nearest ancestor. Right-click a History commit to Set as Base.',
		};
	}
	return {
		branch: fallback,
		explanation: 'Default target: no unambiguous branch tip in the first 200 first-parent commits. Right-click a History commit to Set as Base.',
	};
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
		event('git.defaultBase', { source: 'localDefault' });
		return 'main';
	}
	event('git.fallback', { operation: 'defaultBase', reason: 'localDefaultUnavailable' });
	// Else the remote default branch that origin/HEAD points at.
	const originHead = await gitv(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
	if (originHead) {
		event('git.defaultBase', { source: 'remoteDefault' });
		return originHead.replace(/^refs\/remotes\//, '');
	}
	event('git.fallback', { operation: 'defaultBase', reason: 'remoteDefaultUnavailable' });
	// Else the first branch we can list.
	const branches = await listBranchesCli(cwd);
	event('git.defaultBase', { source: branches.length > 0 ? 'firstBranch' : 'missing', branchCount: branches.length });
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
		event('git.missing', { operation: 'aheadBehind', reason: 'upstreamUnavailable' });
		return undefined;
	}
	// `git rev-list --left-right --count <branch>...<branch>@{upstream}` => "<ahead>\t<behind>".
	const counts = await gitv(
		['rev-list', '--left-right', '--count', `${branch}...${branch}@{upstream}`],
		cwd,
	);
	if (!counts) {
		event('git.missing', { operation: 'aheadBehind', reason: 'countsUnavailable' });
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
 * Throws on failure so the commit tree can show an error instead of an empty expansion.
 */
export async function changedFilesForCommit(cwd: string, sha: string): Promise<string[]> {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
		throw new Error('Commit file expansion requires a resolved commit SHA.');
	}
	const stdout = await runGitQuery(cwd,
		['diff-tree', '--root', '--diff-merges=first-parent', '--no-commit-id', '--name-only', '-r', sha, '--'],
	);
	return stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Tracked working-tree changes, split into staged (index vs HEAD) + unstaged (worktree vs index). */
export interface UncommittedChanges {
	/** Files with staged changes: `git diff --cached --name-status` (index vs HEAD). */
	staged: ChangedFile[];
	/** Files with unstaged changes: `git diff --name-status` (worktree vs index). */
	unstaged: ChangedFile[];
	/** Untracked (new, un-added) files honoring `.gitignore`: `git ls-files --others --exclude-standard`. */
	untracked: ChangedFile[];
}

/**
 * Parse `git diff --name-status` output into `ChangedFile[]`, reusing the exact status/path rules
 * from `changedFiles`: first char of the status field (score dropped for `R100`/`C075`), and the
 * NEW (last) path for renames/copies. Blank/short lines are skipped.
 */
function parseNameStatus(out: string | undefined): ChangedFile[] {
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
		const status = fields[0].charAt(0).toUpperCase();
		const relPath = fields[fields.length - 1].trim();
		if (relPath.length === 0) {
			continue;
		}
		results.push({ relPath, status });
	}
	return results;
}

/**
 * The merge-base (common ancestor) of `base` and `compare` — the point the branch diverged.
 * Returns undefined on any failure (unrelated histories, bad ref, no repo); never throws.
 */
export async function mergeBase(cwd: string, base: string, compare: string): Promise<string | undefined> {
	const out = await gitv(['merge-base', base, compare], cwd);
	const sha = out?.trim();
	return sha && sha.length > 0 ? sha : undefined;
}

/**
 * CUMULATIVE changed files: everything on the branch since it diverged, committed AND uncommitted,
 * as ONE diff per file — `git diff --name-status <mergeBaseSha>`.
 *
 * The TWO-dot form with no right-hand ref diffs a commit against the WORKING TREE, so a file touched
 * by a branch commit and then edited further appears once, with the combined change. Untracked files
 * are invisible to `git diff` and must still come from `ls-files --others` (see
 * `changedFilesUncommitted().untracked`).
 *
 * Parsing is delegated to the shared `parseNameStatus` so rename/copy score stripping and new-path
 * selection stay identical to `changedFiles`. Returns `[]` on any failure.
 */
export async function changedFilesCumulative(cwd: string, mergeBaseSha: string): Promise<ChangedFile[]> {
	return parseNameStatus(await gitv(['diff', '--name-status', mergeBaseSha], cwd));
}

/**
 * Uncommitted changes in the working tree, split into three SCM-style groups:
 *   - `staged`    → `git diff --cached --name-status` (index vs HEAD)
 *   - `unstaged`  → `git diff --name-status`          (worktree vs index)
 *   - `untracked` → `git ls-files --others --exclude-standard` (new, un-added files, honoring .gitignore)
 *
 * `staged`/`unstaged` are TRACKED-only (neither diff reports untracked files); `untracked` closes that
 * gap via `ls-files --others`, which lists brand-new files while respecting `.gitignore`. Its output is
 * bare newline-separated paths (no status column), so each is mapped to status `'U'`. All three ops run
 * against the live index/worktree/HEAD, independent of any ActiveComparison base/compare shas — so they
 * reflect the repo's real current edit state regardless of which comparison is selected. Returns empty
 * groups on any failure.
 */
export async function changedFilesUncommitted(cwd: string): Promise<UncommittedChanges> {
	// The three ops are independent — run them together.
	const [stagedOut, unstagedOut, untrackedOut] = await Promise.all([
		gitv(['diff', '--cached', '--name-status'], cwd),
		gitv(['diff', '--name-status'], cwd),
		gitv(['ls-files', '--others', '--exclude-standard'], cwd),
	]);
	return {
		staged: parseNameStatus(stagedOut),
		unstaged: parseNameStatus(unstagedOut),
		untracked: parseUntracked(untrackedOut),
	};
}

/** Parse bare newline-separated paths from `git ls-files --others` into `ChangedFile[]` with status `'U'`. */
function parseUntracked(out: string | undefined): ChangedFile[] {
	if (!out) {
		return [];
	}
	const results: ChangedFile[] = [];
	for (const raw of out.split(/\r?\n/)) {
		const relPath = raw.trim();
		if (relPath.length === 0) {
			continue;
		}
		results.push({ relPath, status: 'U' });
	}
	return results;
}
