import { createHash } from 'crypto';
import { authorDisplay, formatTimestamp, Review, ReviewThread } from './reviewModel';

export interface ConversationTarget {
	reviewFile: string;
	threadId?: string;
	seq: number;
	legacyFingerprint?: string;
}

export function conversationFingerprint(thread: ReviewThread): string {
	return createHash('sha256').update(JSON.stringify(thread)).digest('hex');
}

export function conversationTarget(reviewFile: string, thread: ReviewThread, index: number): ConversationTarget {
	return {
		reviewFile, threadId: thread.id || undefined, seq: thread.seq ?? index + 1,
		legacyFingerprint: thread.id ? undefined : conversationFingerprint(thread),
	};
}

function inline(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]()<>#|]/g, '\\$&');
}

function codeBlock(text: string): string {
	const longest = (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 2);
	const fence = '`'.repeat(longest + 1);
	return `${fence}\n${text}\n${fence}`;
}

/** Saved discussion data is authoritative; never require a working file or Git blob to read it. */
export function formatConversation(review: Review, thread: ReviewThread, seq: number): string {
	const location = thread.filePath
		? `${thread.filePath}:${thread.startLine ?? 1}${thread.endLine !== undefined && thread.endLine !== thread.startLine ? `-${thread.endLine}` : ''}`
		: 'No file location was recorded.';
	const lines = [
		`# Conversation #${String(seq).padStart(2, '0')}`, '',
		'Read-only conversation transcript. Reading it does not resolve or modify the discussion.', '',
		`**Status:** ${inline(thread.state ?? 'unresolved')}`,
		`**Original code location:** ${inline(location)}`,
		`**Review:** ${inline(review.sourceBranch ?? '(unknown source)')} -> ${inline(review.targetBranch ?? '(unknown target)')}`,
		'', '## Saved code context', '',
	];
	if (thread.anchorText) {
		lines.push(
			'Captured anchor line (trimmed when recorded), not the current file contents:',
			'', codeBlock(thread.anchorText), '',
			'This is only the saved anchor, not a snapshot of the whole file or uncommitted diff.',
		);
	} else {
		lines.push('No code anchor was saved for this conversation.');
	}
	lines.push(
		'',
		'The replies below remain available even if the file or original change was removed. ' +
			'Deleted uncommitted code may never have existed in Git; this transcript does not reconstruct it.',
		'', '## Discussion', '',
	);
	if (!thread.comments.length) { lines.push('No replies have been saved yet.'); }
	thread.comments.forEach((comment, index) => {
		lines.push(`### ${index + 1}. ${inline(authorDisplay(comment.author).name)}`, '');
		if (comment.timestamp) { lines.push(`**When:** ${inline(formatTimestamp(comment.timestamp))}`); }
		const details = [comment.author?.model, comment.author?.version, comment.author?.reasoning].filter(
			(value): value is string => !!value,
		);
		if (details.length) { lines.push(`**Agent details:** ${inline(details.join(' / '))}`); }
		if (comment.tags?.length) { lines.push(`**Tags:** ${inline(comment.tags.join(', '))}`); }
		if (comment.replyTo) {
			const parent = thread.comments.findIndex((item) => item.id === comment.replyTo);
			lines.push(parent >= 0 ? `**Reply to:** comment ${parent + 1}` : '**Reply to:** an earlier comment no longer present');
		}
		lines.push('', comment.body, '', '---', '');
	});
	return lines.join('\n');
}
