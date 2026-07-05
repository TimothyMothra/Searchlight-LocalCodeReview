/**
 * Status-bar item showing the active review as `src → tgt`. Clicking it runs the
 * `searchlight.switchReview` command. Hidden when no review exists.
 *
 * The "active review" is persisted per-workspace in a Memento (keyed by the review's directory).
 * When the stored dir no longer resolves to a review, the first discovered review is used.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Review } from './reviewModel';
import { scanReviews } from './reviewStore';

const ACTIVE_KEY = 'searchlight.activeReviewDir';

export class ReviewStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor(private readonly memento: vscode.Memento) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.item.command = 'searchlight.switchReview';
	}

	/** The persisted active-review directory, if any. */
	getActiveDir(): string | undefined {
		return this.memento.get<string>(ACTIVE_KEY);
	}

	/** Persist the active-review directory. */
	async setActiveDir(dir: string | undefined): Promise<void> {
		await this.memento.update(ACTIVE_KEY, dir);
	}

	/**
	 * Resolve the active review: the one whose directory matches the persisted dir, else the first
	 * discovered review, else undefined.
	 */
	async getActiveReview(): Promise<Review | undefined> {
		const reviews = await scanReviews();
		if (reviews.length === 0) {
			return undefined;
		}
		const dir = this.getActiveDir();
		if (dir) {
			const match = reviews.find((r) => path.dirname(r.sourceFile) === dir);
			if (match) {
				return match;
			}
		}
		return reviews[0];
	}

	/** Refresh the status-bar label/visibility from disk. */
	async update(): Promise<void> {
		const review = await this.getActiveReview();
		if (!review) {
			this.item.hide();
			return;
		}
		const src = review.sourceBranch ?? '?';
		const tgt = review.targetBranch ?? '?';
		this.item.text = `$(git-pull-request) ${src} → ${tgt}`;
		this.item.tooltip = `Searchlight active review: ${src} → ${tgt}\nClick to switch review / branches`;
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}
}
