import type MarkdownIt from 'markdown-it';
import { authorDisplay, formatTimestamp, Review, ReviewThread } from './reviewModel';

let renderer: Promise<MarkdownIt> | undefined;

export async function renderConversationMarkdown(body: string): Promise<string> {
	// ASSUMPTION: formatting is only needed in an opened conversation, not during extension startup.
	renderer ??= import('markdown-it').then(({ default: Markdown }) => {
		const markdown = new Markdown({ html: false, linkify: false, breaks: true });
		// Never load tracking images or execute raw HTML from a saved message.
		markdown.renderer.rules.image = (tokens, index) =>
			`<span class="image-placeholder">[Image omitted: ${markdown.utils.escapeHtml(tokens[index].content || 'image')}]</span>`;
		return markdown;
	});
	return (await renderer).render(body);
}

export interface ConversationPageData {
	mode: 'new' | 'thread';
	title: string;
	number?: number;
	reviewLabel: string;
	resolved: boolean;
	writable: boolean;
	legacy: boolean;
	location?: { label: string; anchor?: string };
	tags: string[];
	comments: { name: string; kind: 'human' | 'agent' | 'unknown'; details: string; timestamp: string; html: string; body: string }[];
	banner?: string;
	busy: boolean;
	canAskCopilot: boolean;
}

export async function buildConversationPageData(review: Review, thread?: ReviewThread): Promise<ConversationPageData> {
	const legacy = !!thread && !thread.id;
	return {
		mode: thread ? 'thread' : 'new',
		title: thread?.title || (thread ? `Thread #${String(thread.seq ?? 1).padStart(2, '0')}` : 'Start a thread'),
		number: thread?.seq,
		reviewLabel: `${review.sourceBranch ?? 'Source'} -> ${review.targetBranch ?? 'Target'}`,
		resolved: thread?.state === 'resolved', writable: !legacy, legacy,
		location: thread?.filePath ? {
			label: `${thread.filePath}:${thread.startLine ?? 1}`, anchor: thread.anchorText,
		} : undefined,
		tags: thread?.tags ?? [],
		comments: await Promise.all((thread?.comments ?? []).map(async (comment) => ({
			name: authorDisplay(comment.author).name,
			kind: comment.author?.kind === 'agent' ? 'agent' : comment.author?.kind === 'human' ? 'human' : 'unknown',
			details: [comment.author?.model, comment.author?.version, comment.author?.reasoning].filter(Boolean).join(' / '),
			timestamp: formatTimestamp(comment.timestamp), html: await renderConversationMarkdown(comment.body), body: comment.body,
		}))),
		banner: legacy ? 'This legacy thread has no stable ID and is read-only. Start a new thread to continue it.' : undefined,
		busy: false, canAskCopilot: !!thread?.id,
	};
}
