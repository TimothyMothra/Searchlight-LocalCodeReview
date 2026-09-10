/**
 * The in-memory "active comparison" — the single source of truth all four Searchlight views read.
 *
 * A comparison is defined by a `base` (TARGET branch) and a `compare` (SOURCE branch = the changes
 * under review). It maps onto the on-disk review schema as `sourceBranch = compare`,
 * `targetBranch = base`. The review file is created lazily: only a mutation (a reviewed-file
 * checkbox toggle, or a comment add/reply) persists `comments.json` to disk.
 */

import * as vscode from 'vscode';
import { getHead } from './gitApi';
import { changedFiles, changedFilesCumulative, ChangedFile, CommitEntry, defaultBaseBranch, logRange, resolveCommit } from './git';
import { Baseline, resolveBaseline, resolveBaselinePin } from './baseline';
import { computeReviewPaths, emptyReview, loadReview } from './reviewStore';
import { Review } from './reviewModel';
import { perfCount } from './perf';

/** Holds and resolves the active base/compare comparison + its review. */
export class ActiveComparison {
	/** TARGET branch (maps to review.targetBranch). Undefined until selected/defaulted. */
	base?: string;
	/** SOURCE branch under review (maps to review.sourceBranch). */
	compare?: string;
	/** Full sha `base` resolves to. */
	baseCommit?: string;
	/** Full sha `compare` resolves to. */
	compareCommit?: string;
	/**
	 * Effective baseline: inferred shared ancestor or explicit pinned commit.
	 * ASSUMPTION: every branch comparison uses this SHA, never the target branch tip.
	 */
	baselineCommit?: string;
	baselinePin?: string;
	baselineReason = '';
	baselineError?: string;
	private resolveVersion = 0;

	/** Current HEAD branch of the repo (undefined when detached). */
	headBranch?: string;
	/** Current HEAD commit sha. */
	headCommit?: string;

	/** Storage dir + comments.json path for the current comparison. */
	reviewDir = '';
	sourceFile = '';

	/** The active in-memory review (loaded from disk or freshly built, not yet persisted). */
	review?: Review;

	/**
	 * True once the user explicitly chose a compare branch (setCompare/swap). While false, `resolve()`
	 * auto-follows the checked-out HEAD so a `git checkout` updates the pane; once true, the explicit
	 * choice is preserved until the next explicit change.
	 */
	private compareExplicit = false;

	/** Memoized changedFiles/logRange results, keyed by the resolved commit pair. */
	private changedFilesKey?: string;
	private changedFilesValue: ChangedFile[] = [];
	private commitsKey?: string;
	private commitsValue: CommitEntry[] = [];
	private commitsTruncated = false;

	constructor(
		/** Workspace folder that owns `.vscode/searchlight-reviews`. */
		public readonly workspaceFolderFsPath: string,
		/**
		 * Git repository root (cwd for all git operations). Mutable so activation can construct
		 * `ActiveComparison` synchronously with a `workspaceFolder` placeholder and fill in the real
		 * root from the background init (getRepoRoot is a slow git spawn we don't want on the
		 * activation critical path — see the environmental-AV note in extension.ts).
		 */
		public repoRootFsPath: string,
		private readonly workspaceState: vscode.Memento,
	) {}

	get comparisonKey(): string {
		return JSON.stringify([this.base, this.compare, this.baselineCommit, this.compareCommit, this.baselineError]);
	}

	private pinKey(base: string, compare: string): string {
		return `searchlight.baselinePin.${JSON.stringify([base, compare])}`;
	}

	private targetKey(compare: string): string {
		return `searchlight.target.${JSON.stringify(compare)}`;
	}

	private invalidateBaseline(): void {
		++this.resolveVersion;
		this.baselineCommit = undefined;
		this.baselinePin = undefined;
		this.baselineReason = '';
		this.baselineError = undefined;
	}

	/** True when `compare` is the currently checked-out HEAD (so its side is the editable working tree). */
	get compareIsHead(): boolean {
		return (
			(this.headBranch !== undefined && this.compare === this.headBranch) ||
			(this.compareCommit !== undefined && this.compareCommit === this.headCommit)
		);
	}

	/**
	 * Populate base/compare with sensible defaults when nothing is selected:
	 * base = default branch (prefer local `main`), compare = current HEAD branch (or short commit
	 * when detached). Silent — never shows a popup.
	 */
	async computeDefaults(): Promise<void> {
		// getHead and defaultBaseBranch are independent — resolve them together.
		const [head, defBase] = await Promise.all([
			getHead(this.repoRootFsPath),
			defaultBaseBranch(this.repoRootFsPath),
		]);
		this.headBranch = head.detached ? undefined : head.branch;
		this.headCommit = head.commit;

		if (this.compare === undefined) {
			if (!head.detached && head.branch) {
				this.compare = head.branch;
			} else if (head.commit) {
				this.compare = head.commit.slice(0, 7);
			}
		}
		if (this.base === undefined) {
			this.base = (this.compare ? this.workspaceState.get<string>(this.targetKey(this.compare)) : undefined) ?? defBase;
		}
	}

	/**
	 * Re-resolve the current base/compare: refresh HEAD info, resolve both commits, recompute the
	 * storage paths, and load an existing `comments.json` (or build an in-memory review that is NOT
	 * yet written to disk).
	 */
	async resolve(): Promise<void> {
		const version = ++this.resolveVersion;
		// HEAD must be resolved BEFORE the commits: auto-follow below can change `compare`, and
		// resolving `compareCommit` from a stale branch name would show the new branch with the old
		// commit. Apply the resolved comparison atomically after all queries complete.
		const head = await getHead(this.repoRootFsPath);
		if (version !== this.resolveVersion) { return; }
		const headBranch = head.detached ? undefined : head.branch;
		let base = this.base;
		let compare = this.compare;

		// Auto-follow the checked-out branch: when the user has NOT explicitly picked a compare
		// branch, `compare` tracks HEAD so a `git checkout` is reflected instead of leaving a stale
		// branch shown. An explicit setCompare/swap opts out until the next explicit change.
		// Skipped while detached so a transient detach doesn't clobber a branch name with a short sha.
		if (!this.compareExplicit && !head.detached && headBranch && compare !== headBranch) {
			compare = headBranch;
			base = this.workspaceState.get<string>(this.targetKey(compare)) ?? await defaultBaseBranch(this.repoRootFsPath);
		}

		if (version !== this.resolveVersion) { return; }
		if (!base || !compare) {
			this.headBranch = headBranch;
			this.headCommit = head.commit;
			this.baseCommit = undefined;
			this.compareCommit = undefined;
			this.baselineCommit = undefined;
			this.baselinePin = undefined;
			this.baselineReason = '';
			this.baselineError = undefined;
			this.reviewDir = '';
			this.sourceFile = '';
			this.review = undefined;
			return;
		}

		const compareCommit = await resolveCommit(this.repoRootFsPath, compare);
		const pin = this.workspaceState.get<string>(this.pinKey(base, compare));
		let baseline: Baseline | undefined;
		let baselineError: string | undefined;
		try {
			if (!compareCommit) {
				throw new Error(`Compare ref '${compare}' cannot be resolved to a commit.`);
			}
			baseline = await resolveBaseline(this.repoRootFsPath, base, compareCommit, pin);
		} catch (error) {
			// Resolution failures are visible in Comparison; never substitute the target tip.
			baselineError = error instanceof Error ? error.message : String(error);
		}
		const paths = computeReviewPaths(this.workspaceFolderFsPath, compare, base);
		const existing = await loadReview(vscode.Uri.file(paths.sourceFile));
		// A rebase/ref change or user selection can overtake an earlier git query.
		if (version !== this.resolveVersion) { return; }
		this.base = base;
		this.compare = compare;
		this.headBranch = headBranch;
		this.headCommit = head.commit;
		this.baseCommit = baseline?.targetCommit;
		this.compareCommit = compareCommit;
		this.baselineCommit = baseline?.commit;
		this.baselinePin = pin;
		this.baselineReason = baseline?.reason ?? '';
		this.baselineError = baselineError;
		this.reviewDir = paths.reviewDir;
		this.sourceFile = paths.sourceFile;
		if (existing) {
			// Ensure the runtime-only path is populated (parseReview sets it from the file uri).
			existing.sourceFile = this.sourceFile;
			if (!existing.reviewedFiles) {
				existing.reviewedFiles = [];
			}
			this.review = existing;
		} else {
			this.review = emptyReview(
				this.workspaceFolderFsPath,
				this.compare,
				this.base,
				this.compareCommit,
				this.baseCommit,
			);
		}
	}

	/**
	 * Cheap in-memory re-sync of `this.review` from `comments.json` — re-reads the review file into
	 * the in-memory object WITHOUT any git/commit resolution. This is the lightweight counterpart to
	 * the heavy git-backed `resolve()`: use it after a state mutation (resolve/unresolve a thread) so
	 * the views that read `active.review` (esp. the Conversations pane) see the freshly-persisted
	 * state without paying for a full comparison re-resolve. Adds exactly one file read, no git.
	 */
	async reloadReview(): Promise<void> {
		if (!this.sourceFile) {
			return;
		}
		const r = await loadReview(vscode.Uri.file(this.sourceFile));
		if (r) {
			// Mirror the load branch in resolve(): populate the runtime-only path + default array.
			r.sourceFile = this.sourceFile;
			if (!r.reviewedFiles) {
				r.reviewedFiles = [];
			}
			this.review = r;
		}
	}

	/** Set the base (target) branch and re-resolve. */
	async setBase(base: string): Promise<void> {
		this.invalidateBaseline();
		this.base = base;
		if (this.compare) {
			await this.workspaceState.update(this.targetKey(this.compare), base);
		}
		await this.resolve();
	}

	/** Pins are scoped to target/source, so changing comparisons cannot reuse an unrelated pin. */
	async setBaselinePin(value: string | undefined): Promise<void> {
		const { base, compare, compareCommit } = this;
		if (!base || !compare || (value !== undefined && !compareCommit)) {
			throw new Error('Select a target and a resolvable compare branch first.');
		}
		const pin = value !== undefined && compareCommit
			? await resolveBaselinePin(this.repoRootFsPath, value, compareCommit)
			: undefined;
		if (base !== this.base || compare !== this.compare || compareCommit !== this.compareCommit) {
			throw new Error('The comparison changed while selecting a baseline. Try again.');
		}
		this.invalidateBaseline();
		await this.workspaceState.update(this.pinKey(base, compare), pin);
		await this.resolve();
	}

	/** Set the compare (source) branch and re-resolve. */
	async setCompare(compare: string): Promise<void> {
		this.invalidateBaseline();
		this.compare = compare;
		this.base = this.workspaceState.get<string>(this.targetKey(compare)) ?? this.base;
		this.compareExplicit = true;   // opt out of auto-follow — the user chose this branch
		await this.resolve();
	}

	/** Swap base and compare, then re-resolve. */
	async swap(): Promise<void> {
		this.invalidateBaseline();
		const oldBase = this.base;
		this.base = this.compare;
		this.compare = oldBase;
		this.compareExplicit = true;   // opt out of auto-follow — the user chose this branch
		if (this.base && this.compare) {
			await this.workspaceState.update(this.targetKey(this.compare), this.base);
		}
		await this.resolve();
	}

	/** Cache key for the current comparison — the resolved commit pair (falls back to branch names). */
	private pairKey(): string {
		return this.comparisonKey;
	}

	/**
	 * Changed files between base…compare, memoized by the resolved commit pair. A checkbox toggle or
	 * comment save does not change the shas, so it hits the cache (the diff is genuinely unchanged);
	 * picking a different base/compare re-resolves → new shas → cache refetch.
	 */
	async getChangedFiles(): Promise<ChangedFile[]> {
		if (!this.baselineCommit || !this.compareCommit) {
			return [];
		}
		const key = this.pairKey();
		if (this.changedFilesKey === key) {
			return this.changedFilesValue;
		}
		const t = Date.now();
		this.changedFilesValue = await changedFiles(this.repoRootFsPath, this.baselineCommit, this.compareCommit);
		this.changedFilesKey = key;
		perfCount('files.data-load', t, this.changedFilesValue.length);
		return this.changedFilesValue;
	}

	/**
	 * CUMULATIVE changed files: committed-on-branch + staged + unstaged in one diff per file
	 * (effective baseline → working tree). Deliberately NOT memoized: unlike `getChangedFiles()`, this result
	 * changes whenever the working tree changes, with no commit sha moving, so the `pairKey` memo
	 * would serve a stale list forever. One extra `git diff --name-status` per render matches what
	 * `changedFilesUncommitted()` already costs.
	 *
	 * With no baseline the UI displays the resolution error instead of a branch comparison.
	 */
	async getChangedFilesCumulative(): Promise<ChangedFile[]> {
		if (!this.baselineCommit) {
			return [];
		}
		const t = Date.now();
		const files = await changedFilesCumulative(this.repoRootFsPath, this.baselineCommit);
		perfCount('files.data-load-cumulative', t, files.length);
		return files;
	}

	/** Commits in base..compare, memoized by the resolved commit pair (see getChangedFiles). */
	async getCommits(): Promise<{ commits: CommitEntry[]; truncated: boolean }> {
		if (!this.baselineCommit || !this.compareCommit) {
			return { commits: [], truncated: false };
		}
		const key = this.pairKey();
		if (this.commitsKey === key) {
			return { commits: this.commitsValue, truncated: this.commitsTruncated };
		}
		const t = Date.now();
		const result = await logRange(this.repoRootFsPath, this.baselineCommit, this.compareCommit);
		this.commitsValue = result.commits;
		this.commitsTruncated = result.truncated;
		this.commitsKey = key;
		perfCount('commits.data-load', t, this.commitsValue.length, `truncated=${this.commitsTruncated}`);
		return { commits: this.commitsValue, truncated: this.commitsTruncated };
	}
}
