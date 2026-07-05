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
import { changedFiles, CommitEntry, defaultBaseBranch, logRange, resolveCommit } from './git';
import { computeReviewPaths, emptyReview, loadReview } from './reviewStore';
import { Review } from './reviewModel';
import { perf } from './perf';

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

	/** Current HEAD branch of the repo (undefined when detached). */
	headBranch?: string;
	/** Current HEAD commit sha. */
	headCommit?: string;

	/** Storage dir + comments.json path for the current comparison. */
	reviewDir = '';
	sourceFile = '';

	/** The active in-memory review (loaded from disk or freshly built, not yet persisted). */
	review?: Review;

	/** Memoized changedFiles/logRange results, keyed by the resolved commit pair. */
	private changedFilesKey?: string;
	private changedFilesValue: string[] = [];
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
	) {}

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

		if (this.base === undefined) {
			this.base = defBase;
		}
		if (this.compare === undefined) {
			if (!head.detached && head.branch) {
				this.compare = head.branch;
			} else if (head.commit) {
				this.compare = head.commit.slice(0, 7);
			}
		}
	}

	/**
	 * Re-resolve the current base/compare: refresh HEAD info, resolve both commits, recompute the
	 * storage paths, and load an existing `comments.json` (or build an in-memory review that is NOT
	 * yet written to disk).
	 */
	async resolve(): Promise<void> {
		// getHead and the two resolveCommit calls are independent — overlap them.
		const [head, baseCommit, compareCommit] = await Promise.all([
			getHead(this.repoRootFsPath),
			this.base
				? resolveCommit(this.repoRootFsPath, this.base)
				: Promise.resolve<string | undefined>(undefined),
			this.compare
				? resolveCommit(this.repoRootFsPath, this.compare)
				: Promise.resolve<string | undefined>(undefined),
		]);
		this.headBranch = head.detached ? undefined : head.branch;
		this.headCommit = head.commit;
		this.baseCommit = baseCommit;
		this.compareCommit = compareCommit;

		if (!this.base || !this.compare) {
			this.reviewDir = '';
			this.sourceFile = '';
			this.review = undefined;
			return;
		}

		const paths = computeReviewPaths(this.workspaceFolderFsPath, this.compare, this.base);
		this.reviewDir = paths.reviewDir;
		this.sourceFile = paths.sourceFile;

		const existing = await loadReview(vscode.Uri.file(this.sourceFile));
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
		this.base = base;
		await this.resolve();
	}

	/** Set the compare (source) branch and re-resolve. */
	async setCompare(compare: string): Promise<void> {
		this.compare = compare;
		await this.resolve();
	}

	/** Swap base and compare, then re-resolve. */
	async swap(): Promise<void> {
		const oldBase = this.base;
		this.base = this.compare;
		this.compare = oldBase;
		await this.resolve();
	}

	/** Cache key for the current comparison — the resolved commit pair (falls back to branch names). */
	private pairKey(): string {
		return `${this.baseCommit ?? this.base ?? ''}...${this.compareCommit ?? this.compare ?? ''}`;
	}

	/**
	 * Changed files between base…compare, memoized by the resolved commit pair. A checkbox toggle or
	 * comment save does not change the shas, so it hits the cache (the diff is genuinely unchanged);
	 * picking a different base/compare re-resolves → new shas → cache refetch.
	 */
	async getChangedFiles(): Promise<string[]> {
		if (!this.base || !this.compare) {
			return [];
		}
		const key = this.pairKey();
		if (this.changedFilesKey === key) {
			return this.changedFilesValue;
		}
		const t = Date.now();
		this.changedFilesValue = await changedFiles(this.repoRootFsPath, this.base, this.compare);
		this.changedFilesKey = key;
		perf('changedFiles (git diff)', t, `${this.changedFilesValue.length} files`);
		return this.changedFilesValue;
	}

	/** Commits in base..compare, memoized by the resolved commit pair (see getChangedFiles). */
	async getCommits(): Promise<{ commits: CommitEntry[]; truncated: boolean }> {
		if (!this.base || !this.compare) {
			return { commits: [], truncated: false };
		}
		const key = this.pairKey();
		if (this.commitsKey === key) {
			return { commits: this.commitsValue, truncated: this.commitsTruncated };
		}
		const t = Date.now();
		const result = await logRange(this.repoRootFsPath, this.base, this.compare);
		this.commitsValue = result.commits;
		this.commitsTruncated = result.truncated;
		this.commitsKey = key;
		perf('logRange (git log)', t, `${this.commitsValue.length} commits, truncated=${this.commitsTruncated}`);
		return { commits: this.commitsValue, truncated: this.commitsTruncated };
	}
}
