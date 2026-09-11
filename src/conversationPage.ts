import * as vscode from 'vscode';
import { Review, ReviewThread } from './reviewModel';
import { conversationTarget, findConversationThread } from './conversationModel';
import { parseConversationTarget, validateConversationReviewFile } from './conversationDocument';
import { addGeneralThread, addReply, humanAuthor, setThreadState } from './reviewStore';
import { getGitUserName } from './git';
import { ConversationUpdates, newPageReference, PageReference, parsePageReference, readPageReview, reviewFileKey } from './conversationPageStore';
import { buildConversationPageData, ConversationPageData, renderConversationMarkdown } from './conversationPageModel';
import { conversationPageHtml } from './conversationPageHtml';
import { recordUsage } from './usage';
import { errorFields, event, trace } from './diagnostics';

export const CONVERSATION_PAGE_TYPE = 'searchlight.conversationPage';

interface Page {
	panel: vscode.WebviewPanel;
	reference: PageReference;
	data?: ConversationPageData;
	busy: boolean;
	version: number;
	disposed: boolean;
}

interface PageHooks {
	changed(): Promise<void>;
	askCopilot(reviewFile: string, threadId: string): void | Promise<void>;
	openCode(thread: ReviewThread): Promise<void>;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One focused page per saved conversation, plus one unsent draft per review. */
export class ConversationPages implements vscode.Disposable, vscode.WebviewPanelSerializer {
	private readonly pages = new Map<string, Page>();
	private readonly updates = new ConversationUpdates();

	constructor(private readonly hooks: PageHooks) {}

	private key(reference: PageReference): string {
		const target = reference.target;
		return JSON.stringify([
			reviewFileKey(reference.reviewFile), target ? target.threadId ? 'id' : 'legacy' : 'draft',
			target?.threadId ?? target?.legacyFingerprint ?? '',
		]);
	}

	async open(value: unknown): Promise<void> {
		const target = parseConversationTarget(value);
		validateConversationReviewFile(target.reviewFile);
		await this.show({ reviewFile: target.reviewFile, target });
	}

	async openNew(review: Review): Promise<void> {
		await this.show(newPageReference(review));
	}

	private async show(reference: PageReference): Promise<void> {
		const existing = this.pages.get(this.key(reference));
		if (existing) {
			existing.panel.reveal();
			await this.refreshPage(existing);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			CONVERSATION_PAGE_TYPE, reference.target ? 'Thread' : 'New thread', vscode.ViewColumn.Active,
			{ enableScripts: true, enableCommandUris: false, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [] },
		);
		await this.attach(panel, reference);
	}

	private async attach(panel: vscode.WebviewPanel, reference: PageReference): Promise<void> {
		const page: Page = { panel, reference, busy: false, version: 0, disposed: false };
		this.pages.set(this.key(reference), page);
		panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
		const messages = panel.webview.onDidReceiveMessage((message: unknown) => { void this.handle(page, message); });
		panel.onDidDispose(() => {
			page.disposed = true;
			messages.dispose();
			if (this.pages.get(this.key(page.reference)) === page) { this.pages.delete(this.key(page.reference)); }
		});
		panel.webview.html = conversationPageHtml(panel.webview);
		await this.refreshPage(page);
	}

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
		try {
			if (typeof state !== 'object' || state === null || !('reference' in state)) { throw new Error('No saved thread reference.'); }
			const reference = parsePageReference(state.reference);
			await this.attach(panel, reference);
		} catch (error) {
			panel.dispose();
			void vscode.window.showErrorMessage(`Searchlight: could not restore the thread: ${messageOf(error)}`);
		}
	}

	private async sendState(page: Page): Promise<void> {
		if (page.disposed || !page.data) { return; }
		await page.panel.webview.postMessage({
			type: 'state', reference: page.reference, data: { ...page.data, busy: page.busy },
		});
	}

	private async refreshPage(page: Page): Promise<boolean> {
		const version = ++page.version;
		return trace('conversation.pageRefresh', async () => {
			let loaded = false;
			try {
				const { review } = await readPageReview(page.reference);
				const target = page.reference.target;
				const thread = target ? findConversationThread(review, target) : undefined;
				if (target && !thread) { throw new Error('This thread is no longer present in the saved review. Showing the last loaded messages.'); }
				if (version !== page.version || page.disposed) { return false; }
				const data = await buildConversationPageData(review, thread);
				if (version !== page.version || page.disposed) { return false; }
				page.data = data;
				loaded = true;
				page.panel.title = page.data.title.slice(0, 80);
			} catch (error) {
				if (version !== page.version || page.disposed) { return false; }
				event('conversation.pageUnavailable', { ...errorFields(error), snapshotAvailable: !!page.data });
				page.data = {
					...(page.data ?? {
						mode: page.reference.target ? 'thread' : 'new', title: 'Thread unavailable',
						reviewLabel: 'Local review', resolved: false, legacy: false, tags: [], comments: [], busy: false,
					}),
					writable: false, canAskCopilot: false, banner: messageOf(error),
				};
			}
			await this.sendState(page);
			return loaded;
		});
	}

	refresh(reviewFile?: vscode.Uri): void {
		for (const page of this.pages.values()) {
			if (!reviewFile || reviewFileKey(page.reference.reviewFile) === reviewFileKey(reviewFile.fsPath)) {
				void this.refreshPage(page);
			}
		}
	}

	private async result(page: Page, action: string, ok: boolean, message?: string, clearDraft = false): Promise<void> {
		if (!page.disposed) { await page.panel.webview.postMessage({ type: 'result', action, ok, message, clearDraft }); }
	}

	private async savedThread(page: Page): Promise<{ review: Review; thread: ReviewThread }> {
		const { review } = await readPageReview(page.reference);
		const thread = page.reference.target ? findConversationThread(review, page.reference.target) : undefined;
		if (!thread) { throw new Error('Save a thread before using this action.'); }
		return { review, thread };
	}

	private async launchCopilot(page: Page): Promise<void> {
		const { thread } = await this.savedThread(page);
		if (!thread.id) { throw new Error('This legacy thread has no stable ID. Start a new thread to ask Copilot.'); }
		await this.hooks.askCopilot(page.reference.reviewFile, thread.id);
	}

	private async handle(page: Page, message: unknown): Promise<void> {
		if (page.disposed || typeof message !== 'object' || message === null || !('type' in message) || typeof message.type !== 'string') { return; }
		const action = message.type;
		if (action === 'ready') { await this.refreshPage(page); return; }
		if (action === 'usage') {
			if ('action' in message && typeof message.action === 'string' && ['quote', 'copyCode', 'copyMessage', 'previewDraft'].includes(message.action)) {
				recordUsage('pane.action', { pane: 'conversations', action: message.action });
			}
			return;
		}
		if (!['post', 'askCopilot', 'setResolved', 'refresh', 'openCode', 'copyText', 'openLink', 'preview'].includes(action)) { return; }
		const mutation = action === 'post' || action === 'setResolved' || action === 'askCopilot';
		if (mutation && page.busy) {
			await this.result(page, action, false, 'An action is already in progress. Your draft is retained.');
			return;
		}
		let saved = false;
		if (mutation) { page.busy = true; await this.sendState(page); }
		try {
			if (action === 'preview') {
				if (!('body' in message) || typeof message.body !== 'string' || !('requestId' in message) ||
					typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)) {
					throw new Error('Invalid preview request.');
				}
				const html = await renderConversationMarkdown(message.body);
				if (!page.disposed) { await page.panel.webview.postMessage({ type: 'preview', requestId: message.requestId, html }); }
			} else if (action === 'post') {
				if (!('body' in message) || typeof message.body !== 'string' || !message.body.trim()) {
					throw new Error('Write a message before posting.');
				}
				if (page.reference.target && !page.reference.target.threadId) { throw new Error('This legacy thread is read-only.'); }
				const body = message.body;
				const title = 'title' in message && typeof message.title === 'string' ? message.title : undefined;
				const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(page.reference.reviewFile));
				if (!folder) { throw new Error('The thread workspace is no longer open.'); }
				const author = humanAuthor(await getGitUserName(folder.uri.fsPath));
				const wasNew = !page.reference.target;
				const previousKey = this.key(page.reference);
				recordUsage('pane.action', { pane: 'conversations', action: 'postMessage' });
				const updated = await this.updates.update(page.reference, (review) => {
					if (!page.reference.target) { return addGeneralThread(review, body, author, title); }
					const thread = findConversationThread(review, page.reference.target);
					if (!thread?.id || !addReply(review, thread.id, undefined, body, author)) { throw new Error('The thread changed before the reply could be saved.'); }
					return thread;
				});
				saved = true;
				page.reference = { reviewFile: updated.review.sourceFile, target: conversationTarget(updated.review.sourceFile, updated.value, updated.review.threads.indexOf(updated.value)) };
				if (this.pages.get(previousKey) === page) { this.pages.delete(previousKey); }
				if (!page.disposed) { this.pages.set(this.key(page.reference), page); }
				page.data = await buildConversationPageData(updated.review, updated.value);
				recordUsage(wasNew ? 'discussion.created' : 'discussion.replied');
				await this.hooks.changed();
				if ('askCopilot' in message && message.askCopilot === true) {
					recordUsage('pane.action', { pane: 'conversations', action: 'askCopilot' });
					await this.launchCopilot(page);
				}
				await this.result(page, action, true,
					'askCopilot' in message && message.askCopilot === true
						? 'Saved locally. Copilot was launched in the terminal; saved replies will appear here.'
						: 'Message saved locally.', true);
			} else if (action === 'setResolved') {
				if (!('resolved' in message) || typeof message.resolved !== 'boolean' || !page.reference.target?.threadId) {
					throw new Error('This thread cannot change state.');
				}
				const state = message.resolved ? 'resolved' : 'unresolved';
				const updated = await this.updates.update(page.reference, (review) => {
					const thread = page.reference.target ? findConversationThread(review, page.reference.target) : undefined;
					if (!thread?.id) { throw new Error('The saved thread is unavailable.'); }
					const changed = thread.state !== state;
					setThreadState(review, thread.id, state);
					return changed;
				});
				if (updated.value) { recordUsage(message.resolved ? 'discussion.resolved' : 'discussion.reopened'); }
				await this.hooks.changed();
				await this.result(page, action, true, message.resolved ? 'Thread resolved.' : 'Thread reopened.');
			} else if (action === 'askCopilot') {
				recordUsage('pane.action', { pane: 'conversations', action: 'askCopilot' });
				await this.launchCopilot(page);
				await this.result(page, action, true, 'Copilot was launched in the terminal. This page updates when replies are saved.');
			} else if (action === 'refresh') {
				recordUsage('pane.action', { pane: 'conversations', action: 'refreshConversation' });
				const loaded = await this.refreshPage(page);
				await this.result(page, action, loaded, loaded ? 'Thread refreshed.' : page.data?.banner ?? 'A newer refresh is in progress.');
			} else if (action === 'openCode') {
				const { thread } = await this.savedThread(page);
				if (!thread.filePath) { throw new Error('This is a review-wide thread with no code location.'); }
				await this.hooks.openCode(thread);
			} else if (action === 'copyText') {
				if (!('text' in message) || typeof message.text !== 'string') { throw new Error('There is no text to copy.'); }
				await vscode.env.clipboard.writeText(message.text);
				await this.result(page, action, true, 'Copied.');
			} else if (action === 'openLink') {
				if (!('href' in message) || typeof message.href !== 'string') { throw new Error('Invalid link.'); }
				const url = new URL(message.href);
				if (url.protocol !== 'https:' && url.protocol !== 'http:') { throw new Error('Only HTTP and HTTPS links can be opened from a thread.'); }
				await vscode.env.openExternal(vscode.Uri.parse(url.href));
			}
		} catch (error) {
			event('conversation.pageActionFailed', { action, saved, ...errorFields(error) });
			await this.result(page, action, false, saved ? `Message saved, but the follow-up action failed: ${messageOf(error)}` : messageOf(error), saved);
		} finally {
			if (mutation) { page.busy = false; await this.refreshPage(page); }
		}
	}

	dispose(): void {
		for (const page of [...this.pages.values()]) { page.panel.dispose(); }
		this.pages.clear();
	}
}
