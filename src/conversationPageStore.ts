import * as path from 'path';
import * as vscode from 'vscode';
import { Review, parseReview } from './reviewModel';
import { ConversationTarget } from './conversationModel';
import { parseConversationTarget, validateConversationReviewFile } from './conversationDocument';
import { computeReviewPaths, emptyReview, saveReview } from './reviewStore';
import { trace } from './diagnostics';

interface ReviewSeed {
	sourceBranch: string;
	targetBranch: string;
	sourceCommit?: string;
	targetCommit?: string;
}

export interface PageReference {
	reviewFile: string;
	target?: ConversationTarget;
	seed?: ReviewSeed;
	allowCreate?: boolean;
}

export const reviewFileKey = (file: string): string =>
	process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

export function newPageReference(review: Review): PageReference {
	if (!review.sourceBranch || !review.targetBranch) { throw new Error('Select a source and target branch before starting a thread.'); }
	validateConversationReviewFile(review.sourceFile);
	return {
		reviewFile: review.sourceFile, allowCreate: true,
		seed: {
			sourceBranch: review.sourceBranch, targetBranch: review.targetBranch,
			sourceCommit: review.sourceCommit, targetCommit: review.targetCommit,
		},
	};
}

export function parsePageReference(value: unknown): PageReference {
	if (typeof value !== 'object' || value === null || !('reviewFile' in value) || typeof value.reviewFile !== 'string') {
		throw new Error('This thread cannot be restored. Reopen it from Threads.');
	}
	validateConversationReviewFile(value.reviewFile);
	if ('target' in value && value.target !== undefined) {
		const target = parseConversationTarget(value.target);
		if (reviewFileKey(target.reviewFile) !== reviewFileKey(value.reviewFile)) { throw new Error('Thread review references do not match.'); }
		return { reviewFile: value.reviewFile, target };
	}
	if (!('seed' in value) || typeof value.seed !== 'object' || value.seed === null ||
		!('sourceBranch' in value.seed) || typeof value.seed.sourceBranch !== 'string' ||
		!('targetBranch' in value.seed) || typeof value.seed.targetBranch !== 'string') {
		throw new Error('This draft has no review context. Start a new thread from Threads.');
	}
	const seed = value.seed;
	const sourceBranch = value.seed.sourceBranch;
	const targetBranch = value.seed.targetBranch;
	if (!sourceBranch.trim() || !targetBranch.trim()) { throw new Error('The draft requires a source and target branch.'); }
	return {
		reviewFile: value.reviewFile, allowCreate: 'allowCreate' in value && value.allowCreate === true,
		seed: {
			sourceBranch, targetBranch,
			sourceCommit: 'sourceCommit' in seed && typeof seed.sourceCommit === 'string' ? seed.sourceCommit : undefined,
			targetCommit: 'targetCommit' in seed && typeof seed.targetCommit === 'string' ? seed.targetCommit : undefined,
		},
	};
}

async function readRaw(file: string): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
		return Buffer.from(bytes).toString('utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error &&
			(error.code === 'FileNotFound' || error.code === 'ENOENT')) { return undefined; }
		throw error;
	}
}

export async function readPageReview(reference: PageReference): Promise<{ review: Review; raw?: string }> {
	validateConversationReviewFile(reference.reviewFile);
	return trace('conversation.pageRead', async () => {
		const raw = await readRaw(reference.reviewFile);
		if (raw !== undefined) {
			reference.allowCreate = false;
			const review = parseReview(raw, reference.reviewFile);
			if (!review) { throw new Error('The saved review is currently invalid. Refresh after the writer finishes; your draft is retained.'); }
			return { review, raw };
		}
		const seed = reference.seed;
		if (reference.target || !reference.allowCreate || !seed) {
			throw new Error('The saved review is unavailable. Your draft has not been written or discarded.');
		}
		const folder = vscode.workspace.workspaceFolders?.find((folder) =>
			reviewFileKey(computeReviewPaths(folder.uri.fsPath, seed.sourceBranch, seed.targetBranch).sourceFile) === reviewFileKey(reference.reviewFile));
		if (!folder) { throw new Error('The draft no longer matches its original branch review. Start a new thread.'); }
		return { review: emptyReview(folder.uri.fsPath, seed.sourceBranch, seed.targetBranch, seed.sourceCommit, seed.targetCommit) };
	});
}

/** Serialize page mutations per review and reload the latest saved replies before every mutation. */
export class ConversationUpdates {
	private readonly tails = new Map<string, Promise<void>>();

	update<T>(reference: PageReference, mutate: (review: Review) => T): Promise<{ review: Review; value: T }> {
		const key = reviewFileKey(reference.reviewFile);
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(async () => {
			const snapshot = await readPageReview(reference);
			const value = mutate(snapshot.review);
			// ASSUMPTION: VS Code has no cross-process compare-and-swap file API. Detect observed
			// external edits instead of overwriting them; this queue serializes page actions only.
			await saveReview(snapshot.review, async () => {
				if (await readRaw(reference.reviewFile) !== snapshot.raw) {
					throw new Error('The review changed while saving. Refresh and try again; your draft is retained.');
				}
			});
			reference.allowCreate = false;
			return { review: snapshot.review, value };
		});
		// A failed operation must not block the next attempt; callers still receive its rejection.
		const tail = result.then(() => undefined, () => undefined);
		this.tails.set(key, tail);
		void tail.then(() => { if (this.tails.get(key) === tail) { this.tails.delete(key); } });
		return result;
	}
}
