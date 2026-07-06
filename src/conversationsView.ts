/**
 * TreeDataProvider for the "Conversations" view — the comment threads of the ACTIVE review only.
 *
 *   Thread (filePath:startLine  [state + tags])
 *     └─ Comment (author name: first line of body)
 *
 * Clicking a Thread or Comment jumps to the referenced file:line. Rendering is ported from the old
 * reviewsTreeProvider, but scoped to the single active review and using the spec icons
 * (`comment` / `check`).
 */

import * as vscode from 'vscode';
import { authorDisplay, formatTimestamp, ReviewComment, ReviewThread } from './reviewModel';
import { ActiveComparison } from './activeComparison';
import { perfCount } from './perf';

type NodeKind = 'thread' | 'comment';

export class ConversationNode extends vscode.TreeItem {
	constructor(
		public readonly kind: NodeKind,
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly thread?: ReviewThread,
		public readonly comment?: ReviewComment,
	) {
		super(label, collapsibleState);
	}
}

export class ConversationsViewProvider implements vscode.TreeDataProvider<ConversationNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ConversationNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly getActive: () => ActiveComparison | undefined) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ConversationNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ConversationNode): ConversationNode[] {
		const active = this.getActive();
		const review = active?.review;
		if (!review) {
			return [];
		}

		if (!element) {
			// Root build — pure in-memory thread map (no git op), so ms is expected to be ~0.
			const tBuild = Date.now();
			const nodes = review.threads.map((t, i) => this.makeThreadNode(t, i));
			perfCount('conversations.build', tBuild, nodes.length);
			return nodes;
		}

		if (element.kind === 'thread' && element.thread) {
			return element.thread.comments.map((c) => this.makeCommentNode(element.thread!, c));
		}

		return [];
	}

	// ── Node factories ────────────────────────────────────────────────────────

	private makeThreadNode(thread: ReviewThread, index: number): ConversationNode {
		const num = String(thread.seq ?? index + 1).padStart(2, '0');
		const loc = thread.filePath ? `${thread.filePath}:${thread.startLine ?? '?'}` : '(no file)';
		const resolved = thread.state === 'resolved';
		const node = new ConversationNode(
			'thread',
			`Thread #${num}  ·  ${loc}`,
			// Resolved threads collapse; open threads stay expanded.
			resolved
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.Expanded,
			thread,
		);

		const bits: string[] = [];
		if (thread.state) {
			bits.push(thread.state);
		}
		if (thread.tags.length > 0) {
			bits.push(thread.tags.map((t) => `#${t}`).join(' '));
		}
		node.description = bits.join('  ');

		node.iconPath = new vscode.ThemeIcon(resolved ? 'check' : 'comment');
		node.tooltip = this.threadTooltip(thread);
		// Distinct contextValues so resolve/unresolve menus can target the right state.
		node.contextValue = resolved ? 'searchlight.thread.resolved' : 'searchlight.thread.unresolved';
		node.command = this.jumpCommand(thread);
		return node;
	}

	private makeCommentNode(thread: ReviewThread, comment: ReviewComment): ConversationNode {
		const disp = authorDisplay(comment.author);
		const firstLine = comment.body.split('\n')[0] ?? '';
		const node = new ConversationNode(
			'comment',
			`${disp.name}: ${firstLine}`,
			vscode.TreeItemCollapsibleState.None,
			thread,
			comment,
		);

		node.iconPath = new vscode.ThemeIcon(disp.iconId);
		const when = formatTimestamp(comment.timestamp);
		if (comment.author?.kind === 'agent') {
			const modelBits = [comment.author.model, comment.author.version].filter(Boolean);
			node.description = [when, ...modelBits].filter(Boolean).join(' · ');
		} else {
			// Never leak the raw lowercase kind string to the description.
			node.description = when;
		}

		node.tooltip = this.commentTooltip(comment);
		node.contextValue = 'searchlight.comment';
		node.command = this.jumpCommand(thread);
		return node;
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private jumpCommand(thread: ReviewThread): vscode.Command | undefined {
		if (!thread.filePath) {
			return undefined;
		}
		return {
			command: 'searchlight.openThreadLocation',
			title: 'Open Location',
			arguments: [thread.filePath, thread.startLine ?? 1, thread.endLine ?? thread.startLine ?? 1],
		};
	}

	private threadTooltip(thread: ReviewThread): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${thread.filePath ?? '(no file)'}**\n\n`);
		if (thread.startLine) {
			md.appendMarkdown(`Lines ${thread.startLine}–${thread.endLine ?? thread.startLine}\n\n`);
		}
		if (thread.state) {
			md.appendMarkdown(`State: \`${thread.state}\`\n\n`);
		}
		if (thread.tags.length > 0) {
			md.appendMarkdown(`Tags: ${thread.tags.map((t) => `\`${t}\``).join(', ')}\n\n`);
		}
		md.appendMarkdown(`${thread.comments.length} comment(s)`);
		return md;
	}

	private commentTooltip(comment: ReviewComment): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		const a = comment.author;
		if (a) {
			const disp = authorDisplay(a);
			// Show the humanized display name in bold — never the raw lowercase kind.
			const idBits = [a.model, a.reasoning, a.version].filter(Boolean).join(' · ');
			md.appendMarkdown(idBits ? `**${disp.name}** — ${idBits}\n\n` : `**${disp.name}**\n\n`);
		}
		if (a && a.kind === 'agent' && a.sessionId) {
			md.appendMarkdown(`_session ${a.sessionId}_\n\n`);
		}
		md.appendMarkdown(comment.body || '_(empty)_');
		return md;
	}
}
