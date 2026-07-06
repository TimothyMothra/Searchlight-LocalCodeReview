/**
 * TreeDataProvider for the "Commits" view — a list of commits between base and compare
 * (`git log base..compare`). Each commit node is expandable: expanding it lazily lists that
 * commit's changed files. Clicking an individual file opens just that file's diff (`sha^..sha`).
 * The whole-commit multi-file diff is no longer opened eagerly on click (slow for big commits).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ActiveComparison } from './activeComparison';
import { CommitEntry, changedFilesForCommit } from './git';
import { perfCount } from './perf';

export class CommitNode extends vscode.TreeItem {
	constructor(label: string, public readonly sha: string) {
		super(label, vscode.TreeItemCollapsibleState.Collapsed);
	}
}

/** A single changed file within a commit — clicking it opens that file's `sha^..sha` diff. */
export class CommitFileNode extends vscode.TreeItem {
	constructor(
		public readonly sha: string,
		public readonly relPath: string,
	) {
		super(path.basename(relPath), vscode.TreeItemCollapsibleState.None);
	}
}

type CommitTreeNode = CommitNode | CommitFileNode | vscode.TreeItem;

export class CommitsViewProvider implements vscode.TreeDataProvider<CommitTreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<CommitTreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly getActive: () => ActiveComparison | undefined) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: CommitTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: CommitTreeNode): Promise<CommitTreeNode[]> {
		const active = this.getActive();
		if (!active || !active.base || !active.compare) {
			return [];
		}

		// Expanding a commit → lazily list its changed files.
		if (element instanceof CommitNode) {
			const cwd = active.repoRootFsPath;
			if (!cwd) {
				return [];
			}
			const tExpand = Date.now();
			const files = await changedFilesForCommit(cwd, element.sha);
			perfCount('commits.expand', tExpand, files.length);
			return files.map((rel) => this.makeFileNode(element.sha, rel));
		}

		// File leaves have no children.
		if (element instanceof CommitFileNode) {
			return [];
		}

		// Root → the flat commit list (bounded; a trailing info node marks truncation).
		const tBuild = Date.now();
		const { commits, truncated } = await active.getCommits();
		const nodes: CommitTreeNode[] = commits.map((c) => this.makeNode(c));
		if (truncated) {
			const more = new vscode.TreeItem(
				`(${commits.length}+ commits — showing ${commits.length})`,
				vscode.TreeItemCollapsibleState.None,
			);
			more.iconPath = new vscode.ThemeIcon('ellipsis');
			more.tooltip = 'The commit log was truncated for performance. Use the terminal for the full history.';
			nodes.push(more);
		}
		perfCount('commits.build', tBuild, nodes.length);
		return nodes;
	}

	private makeNode(commit: CommitEntry): CommitNode {
		const node = new CommitNode(`${commit.shortSha} ${commit.subject}`, commit.sha);
		node.description = `${commit.author}, ${commit.relDate}`;
		node.iconPath = new vscode.ThemeIcon('git-commit');
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`\`${commit.sha}\`\n\n${commit.subject}`);
		node.tooltip = md;
		node.contextValue = 'searchlight.commit';
		return node;
	}

	private makeFileNode(sha: string, relPath: string): CommitFileNode {
		const node = new CommitFileNode(sha, relPath);
		node.description = path.dirname(relPath) === '.' ? undefined : path.dirname(relPath);
		node.resourceUri = vscode.Uri.file(relPath);
		node.tooltip = relPath;
		node.contextValue = 'searchlight.commitFile';
		node.command = {
			command: 'searchlight.openCommitFileDiff',
			title: 'Open File Diff',
			arguments: [sha, relPath],
		};
		return node;
	}
}
