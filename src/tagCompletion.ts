/**
 * `/tag` autocomplete for the comment reply box.
 *
 * Registers a CompletionItemProvider on the `comment` document scheme (the scheme VS Code uses for
 * comment-thread input editors), triggered by `/`. Offers the configured tag set
 * (`searchlight.tags`, default: idea question bug change todo nit praise). The selected tag is
 * inserted as `/tag`; the CommentController's reply handler later extracts `/tag` tokens into the
 * thread's `tags[]` on submit.
 */

import * as vscode from 'vscode';

const DEFAULT_TAGS = ['idea', 'question', 'bug', 'change', 'todo', 'nit', 'praise'];

/** Short descriptions surfaced in the completion detail. */
const TAG_DETAIL: Record<string, string> = {
	idea: 'A suggestion or possibility',
	question: 'Asking for clarification',
	bug: 'A defect that should be fixed',
	change: 'A requested change',
	todo: 'Follow-up work',
	nit: 'Minor / non-blocking',
	praise: 'Positive feedback',
};

class TagCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.CompletionItem[] {
		const line = document.lineAt(position.line).text.slice(0, position.character);
		const slash = line.lastIndexOf('/');
		if (slash < 0) {
			return [];
		}
		const typed = line.slice(slash + 1);
		// Only offer while still typing a bare word right after the slash.
		if (/[^\w-]/.test(typed)) {
			return [];
		}

		const configured = vscode.workspace
			.getConfiguration('searchlight')
			.get<string[]>('tags', DEFAULT_TAGS);
		const tags = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_TAGS;

		const replaceStart = new vscode.Position(position.line, slash);
		const replaceRange = new vscode.Range(replaceStart, position);

		return tags.map((tag, i) => {
			const item = new vscode.CompletionItem(`/${tag}`, vscode.CompletionItemKind.Keyword);
			item.insertText = `/${tag}`;
			item.filterText = `/${tag}`;
			item.range = replaceRange;
			item.detail = TAG_DETAIL[tag] ?? 'Searchlight tag';
			item.sortText = String(i).padStart(3, '0');
			return item;
		});
	}
}

/** Register the provider; returns a Disposable for the extension's subscriptions. */
export function registerTagCompletion(): vscode.Disposable {
	return vscode.languages.registerCompletionItemProvider(
		{ scheme: 'comment' },
		new TagCompletionProvider(),
		'/',
	);
}
