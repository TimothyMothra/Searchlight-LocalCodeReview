/**
 * Write layer for Searchlight `comments.json` files.
 *
 * Reading is handled by reviewModel.ts (tolerant of v1 + v2). This module owns MUTATION and
 * SERIALIZATION: it always writes schema **v2** (version:2, object `author`, thread `tags[]`,
 * comment `replyTo`). A v1 file read in is transparently upgraded to v2 on the next write, while
 * preserving whatever author information was present (a bare-string v1 author becomes
 * `{kind:"unknown", name:<string>}`).
 *
 * All mutations operate on the in-memory `Review` model and then persist the whole file, so the
 * on-disk JSON stays canonical and diff-friendly (2-space indent, trailing newline).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Review, ReviewAuthor, ReviewComment, ReviewThread, parseReview, normalizeSeq } from './reviewModel';

/** Glob (relative to each workspace folder) for Searchlight review storage. */
export const REVIEWS_GLOB = '.vscode/searchlight-reviews/**/comments.json';

/** A short, unique-enough id for a new comment/thread (no external uuid dependency). */
export function newId(prefix: string): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Find + parse every review file across all workspace folders (stable-sorted by path). */
export async function scanReviews(): Promise<Review[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const found: Review[] = [];
	for (const folder of folders) {
		const pattern = new vscode.RelativePattern(folder, REVIEWS_GLOB);
		const uris = await vscode.workspace.findFiles(pattern);
		for (const uri of uris) {
			const review = await loadReview(uri);
			if (review) {
				found.push(review);
			}
		}
	}
	found.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
	return found;
}

/** Read + parse a comments.json file into a Review, or undefined if missing/invalid. */
export async function loadReview(uri: vscode.Uri): Promise<Review | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		return parseReview(text, uri.fsPath);
	} catch {
		return undefined;
	}
}

// ── Serialization (always emits v2) ─────────────────────────────────────────

function serializeAuthor(author: ReviewAuthor | undefined): Record<string, unknown> | undefined {
	if (!author) {
		return undefined;
	}
	const out: Record<string, unknown> = { kind: author.kind, name: author.name };
	if (author.model) {
		out.model = author.model;
	}
	if (author.reasoning) {
		out.reasoning = author.reasoning;
	}
	if (author.version) {
		out.version = author.version;
	}
	if (author.sessionId) {
		out.sessionId = author.sessionId;
	}
	return out;
}

function serializeComment(comment: ReviewComment): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: comment.id ?? newId('c'),
		body: comment.body,
	};
	if (comment.timestamp) {
		out.timestamp = comment.timestamp;
	}
	if (comment.replyTo) {
		out.replyTo = comment.replyTo;
	}
	const author = serializeAuthor(comment.author);
	if (author) {
		out.author = author;
	}
	// Additive: only write per-comment tags when present, to keep files diff-friendly and back-compat.
	if (comment.tags && comment.tags.length > 0) {
		out.tags = comment.tags;
	}
	return out;
}

function serializeThread(thread: ReviewThread): Record<string, unknown> {
	return {
		id: thread.id ?? newId('t'),
		filePath: thread.filePath,
		startLine: thread.startLine,
		endLine: thread.endLine ?? thread.startLine,
		state: thread.state ?? 'unresolved',
		...(thread.seq !== undefined ? { seq: thread.seq } : {}),
		tags: thread.tags,
		...(thread.anchorText !== undefined ? { anchorText: thread.anchorText } : {}),
		comments: thread.comments.map(serializeComment),
	};
}

/** Produce the canonical v2 on-disk object for a Review. */
export function serializeReview(review: Review): Record<string, unknown> {
	return {
		version: 2,
		sourceBranch: review.sourceBranch,
		targetBranch: review.targetBranch,
		sourceCommit: review.sourceCommit,
		targetCommit: review.targetCommit,
		threads: review.threads.map(serializeThread),
		// Only emit reviewedFiles when non-empty, to keep files diff-friendly.
		...(review.reviewedFiles && review.reviewedFiles.length > 0
			? { reviewedFiles: review.reviewedFiles }
			: {}),
		...(review.seqCounter !== undefined ? { seqCounter: review.seqCounter } : {}),
	};
}

/** Replace `/` with `-` so a branch name is safe as a single path segment. */
function sanitizeBranch(branch: string): string {
	return branch.replace(/\//g, '-');
}

/**
 * Compute the storage directory and comments.json path for a comparison.
 * Layout: `<workspaceFolder>/.vscode/searchlight-reviews/<compare>_<base>/comments.json`
 * (branch names sanitized: `/` → `-`). `compare` maps to sourceBranch, `base` to targetBranch.
 */
export function computeReviewPaths(
	workspaceFolderFsPath: string,
	compare: string,
	base: string,
): { reviewDir: string; sourceFile: string } {
	const dirName = `${sanitizeBranch(compare)}_${sanitizeBranch(base)}`;
	const reviewDir = path.join(workspaceFolderFsPath, '.vscode', 'searchlight-reviews', dirName);
	const sourceFile = path.join(reviewDir, 'comments.json');
	return { reviewDir, sourceFile };
}

/** Build an in-memory, not-yet-persisted v2 Review for a comparison. */
export function emptyReview(
	workspaceFolderFsPath: string,
	compare: string,
	base: string,
	compareCommit?: string,
	baseCommit?: string,
): Review {
	const { sourceFile } = computeReviewPaths(workspaceFolderFsPath, compare, base);
	return {
		version: 2,
		sourceBranch: compare,
		targetBranch: base,
		sourceCommit: compareCommit,
		targetCommit: baseCommit,
		threads: [],
		reviewedFiles: [],
		seqCounter: 0,
		sourceFile,
	};
}

/** Persist a Review to its `sourceFile` as canonical v2 JSON. */
export async function saveReview(review: Review): Promise<void> {
	const obj = serializeReview(review);
	const text = JSON.stringify(obj, null, 2) + '\n';
	const uri = vscode.Uri.file(review.sourceFile);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** Build a human author block from a display name. */
export function humanAuthor(name: string): ReviewAuthor {
	return { kind: 'human', name };
}

/** Append a top-level comment to a thread (found by id). Returns the new comment, or undefined. */
export function addComment(
	review: Review,
	threadId: string,
	body: string,
	author: ReviewAuthor,
	tags: string[] = [],
): ReviewComment | undefined {
	const thread = review.threads.find((t) => t.id === threadId);
	if (!thread) {
		return undefined;
	}
	const comment: ReviewComment = {
		id: newId('c'),
		body,
		timestamp: new Date().toISOString(),
		author,
		...(tags.length > 0 ? { tags: [...tags] } : {}),
	};
	thread.comments.push(comment);
	return comment;
}

/** Append a reply (with `replyTo`) to a thread. Returns the new comment, or undefined. */
export function addReply(
	review: Review,
	threadId: string,
	replyToId: string | undefined,
	body: string,
	author: ReviewAuthor,
	tags: string[] = [],
): ReviewComment | undefined {
	const thread = review.threads.find((t) => t.id === threadId);
	if (!thread) {
		return undefined;
	}
	// Default replyTo to the last comment in the thread when not specified.
	const parent = replyToId ?? thread.comments[thread.comments.length - 1]?.id;
	const comment: ReviewComment = {
		id: newId('c'),
		body,
		timestamp: new Date().toISOString(),
		replyTo: parent,
		author,
		...(tags.length > 0 ? { tags: [...tags] } : {}),
	};
	thread.comments.push(comment);
	return comment;
}

/** Set a thread's resolved state. Returns true if the thread was found. */
export function setThreadState(
	review: Review,
	threadId: string,
	state: 'resolved' | 'unresolved',
): boolean {
	const thread = review.threads.find((t) => t.id === threadId);
	if (!thread) {
		return false;
	}
	thread.state = state;
	return true;
}

/** Merge tags into a thread's `tags[]` (deduped, order-preserving). Returns true if found. */
export function addThreadTags(review: Review, threadId: string, tags: string[]): boolean {
	const thread = review.threads.find((t) => t.id === threadId);
	if (!thread) {
		return false;
	}
	for (const tag of tags) {
		if (tag && !thread.tags.includes(tag)) {
			thread.tags.push(tag);
		}
	}
	return true;
}

/** Create a brand-new thread (with a first comment) at a file location. Returns the thread. */
export function addThread(
	review: Review,
	filePath: string,
	startLine: number,
	endLine: number,
	body: string,
	author: ReviewAuthor,
	tags: string[] = [],
	anchorText?: string,
): ReviewThread {
	if (review.seqCounter === undefined) { normalizeSeq(review); }
	const seq = (review.seqCounter ?? 0) + 1;
	review.seqCounter = seq;
	const thread: ReviewThread = {
		id: newId('t'),
		filePath,
		startLine,
		endLine,
		state: 'unresolved',
		seq,
		tags: [...tags],
		...(anchorText !== undefined ? { anchorText } : {}),
		comments: [
			{
				id: newId('c'),
				body,
				timestamp: new Date().toISOString(),
				author,
				...(tags.length > 0 ? { tags: [...tags] } : {}),
			},
		],
	};
	review.threads.push(thread);
	return thread;
}
