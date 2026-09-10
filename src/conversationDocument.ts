import * as path from 'path';
import * as vscode from 'vscode';
import { ConversationTarget, conversationFingerprint, formatConversation } from './conversationModel';
import { loadReview } from './reviewStore';
import { event, trace } from './diagnostics';

export const CONVERSATION_SCHEME = 'searchlight-conversation';

function targetFrom(value: unknown): ConversationTarget {
	if (typeof value !== 'object' || value === null ||
		!('reviewFile' in value) || typeof value.reviewFile !== 'string' ||
		!('seq' in value) || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1 ||
		('threadId' in value && value.threadId !== undefined && typeof value.threadId !== 'string')) {
		throw new Error('Invalid conversation reference. Reopen the discussion from Conversations.');
	}
	const target: ConversationTarget = {
		reviewFile: value.reviewFile, seq: value.seq,
		threadId: 'threadId' in value && typeof value.threadId === 'string' ? value.threadId || undefined : undefined,
		legacyFingerprint: 'legacyFingerprint' in value && typeof value.legacyFingerprint === 'string' ? value.legacyFingerprint : undefined,
	};
	if (!target.threadId && !/^[a-f0-9]{64}$/.test(target.legacyFingerprint ?? '')) {
		throw new Error('This legacy conversation reference is incomplete. Reopen it from Conversations.');
	}
	return target;
}

interface OpenConversation {
	uri: vscode.Uri;
	target: ConversationTarget;
	text?: string;
}

export class ConversationDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changed.event;
	private readonly documents = new Map<string, OpenConversation>();
	private readonly closed = vscode.workspace.onDidCloseTextDocument((document) => {
		if (document.uri.scheme === CONVERSATION_SCHEME) { this.documents.delete(document.uri.toString()); }
	});

	private validateSource(target: ConversationTarget): void {
		if (!path.isAbsolute(target.reviewFile)) { throw new Error('The review file must be an absolute workspace path.'); }
		const valid = vscode.workspace.workspaceFolders?.some((folder) => {
			const relative = path.relative(folder.uri.fsPath, target.reviewFile);
			const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
			const parts = normalized.split(path.sep);
			return !path.isAbsolute(relative) && parts.length >= 3 &&
				parts[0] === '.vscode' && parts[1] === 'searchlight-reviews' && parts[parts.length - 1] === 'comments.json';
		});
		if (!valid) { throw new Error('The conversation must belong to a Searchlight review in this workspace.'); }
	}

	async open(value: unknown): Promise<void> {
		const target = targetFrom(value);
		this.validateSource(target);
		const uri = vscode.Uri.from({
			scheme: CONVERSATION_SCHEME,
			path: `/Conversation-${String(target.seq).padStart(2, '0')}.md`,
			query: JSON.stringify(target),
		});
		// A virtual Markdown document is read-only and does not execute HTML or links from replies.
		if (this.documents.has(uri.toString())) { this.changed.fire(uri); }
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let value: unknown;
		try { value = JSON.parse(uri.query); }
		catch { throw new Error('Invalid conversation reference. Reopen the discussion from Conversations.'); }
		const target = targetFrom(value);
		this.validateSource(target);
		const key = uri.toString();
		let entry = this.documents.get(key);
		if (!entry) {
			entry = { uri, target };
			this.documents.set(key, entry);
		}
		// ASSUMPTION: legacy threads without IDs can only be safely identified within a snapshot.
		// Do not silently switch a restored snapshot to another legacy thread after array reordering.
		if (!target.threadId && entry.text !== undefined) { return entry.text; }
		const review = await trace('conversation.load', () => loadReview(vscode.Uri.file(target.reviewFile)));
		const thread = target.threadId
			? review?.threads.find((item) => item.id === target.threadId)
			: review?.threads.find((item) => item.seq === target.seq);
		if (!review || !thread || (!target.threadId && conversationFingerprint(thread) !== target.legacyFingerprint)) {
			event('conversation.unavailable', { cached: entry.text !== undefined });
			if (entry.text !== undefined) {
				return '> Saved review data or this thread is currently unavailable. Showing the last successfully loaded transcript.\n\n' + entry.text;
			}
			throw new Error('The saved conversation is unavailable. Its review data may have been removed or changed.');
		}
		entry.text = formatConversation(review, thread, thread.seq ?? target.seq);
		if (!target.threadId) {
			entry.text = '> Legacy conversation snapshot (no stable thread ID). Close and reopen this tab to load changes.\n\n' + entry.text;
		}
		event('conversation.loaded', { count: thread.comments.length, legacy: !target.threadId });
		return entry.text;
	}

	refresh(reviewFile?: vscode.Uri): void {
		const fileKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
		for (const entry of this.documents.values()) {
			if (!reviewFile || fileKey(entry.target.reviewFile) === fileKey(reviewFile.fsPath)) {
				this.changed.fire(entry.uri);
			}
		}
	}

	dispose(): void {
		this.closed.dispose();
		this.changed.dispose();
		this.documents.clear();
	}
}
