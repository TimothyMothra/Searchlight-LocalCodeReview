/**
 * Review model + tolerant parser for Searchlight `comments.json` files.
 *
 * Supports BOTH schema versions:
 *   v1 — `author` is a bare string; no thread `tags[]`.
 *   v2 — `author` is an object ({ kind, name, model, reasoning, version }); thread `tags[]`
 *        and comment `replyTo` are present.
 *
 * Parsing is intentionally defensive: a malformed or partial file should degrade to whatever
 * can be salvaged rather than throwing, so one bad review never blanks the whole tree.
 */

/** Normalized author, regardless of whether the source stored a string (v1) or object (v2). */
export interface ReviewAuthor {
	/** "human" | "agent" for v2; "unknown" when the source was a bare v1 string with no kind. */
	kind: string;
	/** Display name. For a v1 bare-string author this IS the string. */
	name: string;
	model?: string;
	reasoning?: string;
	version?: string;
	/** v2, agent-only: the Copilot session UUID that authored this comment. Preserved on round-trip. */
	sessionId?: string;
}

export interface ReviewComment {
	id?: string;
	body: string;
	timestamp?: string;
	/** v2 threading: the comment id this one replies to. */
	replyTo?: string;
	author?: ReviewAuthor;
	/** v2, additive: tags applied to THIS comment (e.g. from `/nit`). Absent on older files. */
	tags?: string[];
}

export interface ReviewThread {
	id?: string;
	/** Repo-relative path with forward slashes, per the schema. */
	filePath?: string;
	startLine?: number;
	endLine?: number;
	/** "unresolved" | "resolved". */
	state?: string;
	/** Per-review sequential display id (1-based). Absent on legacy threads; back-filled by array order. */
	seq?: number;
	/** v2 only. */
	tags: string[];
	/**
	 * v2, additive: trimmed text of the anchored line captured at thread-create time. Used to
	 * relocate uncommitted-file threads that drift as the working tree changes. Absent on older
	 * files and on committed-diff threads that never needed relocation.
	 */
	anchorText?: string;
	comments: ReviewComment[];
}

export interface Review {
	/** Schema version as found in the file (1 or 2); defaults to 1 when absent. */
	version: number;
	sourceBranch?: string;
	targetBranch?: string;
	sourceCommit?: string;
	targetCommit?: string;
	threads: ReviewThread[];
	/** Repo-relative paths (forward slashes) the reviewer has marked as reviewed. */
	reviewedFiles?: string[];
	/** Monotonic high-water mark for thread.seq. Never decremented; new threads use ++seqCounter. Absent in pre-counter (legacy) files → triggers one-time migration. */
	seqCounter?: number;
	/** Absolute path to the comments.json this review was parsed from. */
	sourceFile: string;
}

/**
 * Ensures every thread has a stable, unique `seq` and the review has a durable `seqCounter`.
 * Legacy files (no seqCounter) get a ONE-TIME migration: threads renumbered 1..N by array
 * (creation) order, so display ids are contiguous and match creation order. Once seqCounter
 * exists we never renumber existing threads (prevents id reuse after a thread is deleted);
 * we only backfill a thread that somehow lacks a seq and keep the counter at/above the max.
 */
export function normalizeSeq(review: Review): void {
	if (review.seqCounter === undefined) {
		let n = 0;
		for (const t of review.threads) { t.seq = ++n; }
		review.seqCounter = n;
		return;
	}
	for (const t of review.threads) {
		if (typeof t.seq !== 'number') { t.seq = ++review.seqCounter!; }
	}
	for (const t of review.threads) {
		if (typeof t.seq === 'number' && t.seq > review.seqCounter!) { review.seqCounter = t.seq; }
	}
}

/** Coerce an unknown `author` field (string | object | undefined) into a normalized ReviewAuthor. */
function parseAuthor(raw: unknown): ReviewAuthor | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	// v1: author is a bare string.
	if (typeof raw === 'string') {
		return { kind: 'unknown', name: raw };
	}
	// v2: author is an object.
	if (typeof raw === 'object') {
		const o = raw as Record<string, unknown>;
		return {
			kind: typeof o.kind === 'string' ? o.kind : 'unknown',
			name: typeof o.name === 'string' ? o.name : '(unknown)',
			model: typeof o.model === 'string' ? o.model : undefined,
			reasoning: typeof o.reasoning === 'string' ? o.reasoning : undefined,
			version: typeof o.version === 'string' ? o.version : undefined,
			sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
		};
	}
	return undefined;
}

/** Human-readable fallback labels, used only when an author has no explicit `name`. */
const AUTHOR_KIND_LABELS: Record<string, string> = {
	human: 'Human',
	agent: 'Agent',
	unknown: 'Unknown',
};

/** Friendly local time for display, e.g. "Jul 4, 7:12 PM". Falls back to the raw string if unparseable. */
export function formatTimestamp(iso: string | undefined): string {
	if (!iso) { return ''; }
	const d = new Date(iso);
	if (isNaN(d.getTime())) { return iso; }
	return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Resolve an author to a user-facing display name + codicon id, identically for every view.
 * - name: prefer the explicit `name`; fall back to a humanized kind ("Human"/"Agent"/"Unknown") —
 *   NEVER the raw lowercase kind string.
 * - iconId: 'hubot' for agents, 'account' for humans/unknown — visually distinct AI vs human.
 * Returns an `iconId` string (not a `vscode.ThemeIcon`) so this model module stays free of a
 * `vscode` import and remains unit-testable; callers wrap it with `new vscode.ThemeIcon(iconId)`.
 */
export function authorDisplay(author: ReviewAuthor | undefined): { name: string; iconId: string } {
	const kind = author?.kind ?? 'unknown';
	const raw = author?.name?.trim();
	// parseAuthor stores '(unknown)' as the placeholder for a v2 object with no name.
	const hasName = !!raw && raw !== '(unknown)';
	const name = hasName ? (raw as string) : (AUTHOR_KIND_LABELS[kind] ?? 'Unknown');
	return { name, iconId: kind === 'agent' ? 'hubot' : 'account' };
}

function parseComment(raw: unknown): ReviewComment {
	const o = (raw ?? {}) as Record<string, unknown>;
	return {
		id: typeof o.id === 'string' ? o.id : undefined,
		body: typeof o.body === 'string' ? o.body : '',
		timestamp: typeof o.timestamp === 'string' ? o.timestamp : undefined,
		replyTo: typeof o.replyTo === 'string' ? o.replyTo : undefined,
		author: parseAuthor(o.author),
		// Additive/back-compat: tolerate absence (older files have no per-comment tags).
		tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : undefined,
	};
}

function parseThread(raw: unknown): ReviewThread {
	const o = (raw ?? {}) as Record<string, unknown>;
	const tags = Array.isArray(o.tags)
		? o.tags.filter((t): t is string => typeof t === 'string')
		: [];
	const comments = Array.isArray(o.comments) ? o.comments.map(parseComment) : [];
	return {
		id: typeof o.id === 'string' ? o.id : undefined,
		filePath: typeof o.filePath === 'string' ? o.filePath : undefined,
		startLine: typeof o.startLine === 'number' ? o.startLine : undefined,
		endLine: typeof o.endLine === 'number' ? o.endLine : undefined,
		state: typeof o.state === 'string' ? o.state : undefined,
		seq: typeof o.seq === 'number' ? o.seq : undefined,
		tags,
		anchorText: typeof o.anchorText === 'string' ? o.anchorText : undefined,
		comments,
	};
}

/**
 * Parse the raw JSON text of a comments.json file into a Review.
 * Returns undefined only when the text is not valid JSON; structurally partial data is tolerated.
 */
export function parseReview(text: string, sourceFile: string): Review | undefined {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (typeof data !== 'object' || data === null) {
		return undefined;
	}
	const threads = Array.isArray(data.threads) ? data.threads.map(parseThread) : [];
	const review: Review = {
		version: typeof data.version === 'number' ? data.version : 1,
		sourceBranch: typeof data.sourceBranch === 'string' ? data.sourceBranch : undefined,
		targetBranch: typeof data.targetBranch === 'string' ? data.targetBranch : undefined,
		sourceCommit: typeof data.sourceCommit === 'string' ? data.sourceCommit : undefined,
		targetCommit: typeof data.targetCommit === 'string' ? data.targetCommit : undefined,
		threads,
		reviewedFiles: Array.isArray(data.reviewedFiles)
			? data.reviewedFiles.filter((f): f is string => typeof f === 'string')
			: [],
		seqCounter: typeof data.seqCounter === 'number' ? data.seqCounter : undefined,
		sourceFile,
	};
	normalizeSeq(review);
	return review;
}
