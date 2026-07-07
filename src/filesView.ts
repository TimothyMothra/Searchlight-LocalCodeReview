/**
 * TreeDataProvider for the "Changed Files" view — a hierarchical folder tree of the files that
 * differ between base and compare (`git diff --name-only base...compare`). File leaves carry a
 * checkbox reflecting `review.reviewedFiles`; the checkbox handler is wired on the TreeView
 * instance in extension.ts (it needs `onDidChangeCheckboxState`).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { perfCount } from './perf';

/** A node in the changed-files tree: either an interior folder or a file leaf. */
export class FileNode extends vscode.TreeItem {
	constructor(
		public readonly kind: 'folder' | 'file',
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		/** Repo-relative, forward-slashed path. For folders, the folder path; for files, the file path. */
		public readonly relPath: string,
	) {
		super(label, collapsibleState);
	}
}

/** Internal mutable tree used while building the hierarchy. */
interface DirTree {
	dirs: Map<string, DirTree>;
	files: string[]; // basenames
}

export class FilesViewProvider implements vscode.TreeDataProvider<FileNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** Cached changed-file paths (repo-relative, forward slashes) from the last scan. */
	private paths: string[] = [];

	/** The base…compare key whose changed files are currently loaded into `paths`. */
	private loadedKey?: string;
	/** The key currently being loaded (guards against kicking a second async scan). */
	private loadingKey?: string;

	/** When true, folder rows render expanded (drives the "expand all" title action). */
	private filesExpanded = false;

	constructor(private readonly getActive: () => ActiveComparison | undefined) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/** Toggle every folder to expanded (true) or the default collapsed (false), then refresh. */
	setExpanded(expanded: boolean): void {
		this.filesExpanded = expanded;
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: FileNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: FileNode): Promise<FileNode[]> {
		const active = this.getActive();
		if (!active || !active.base || !active.compare) {
			return [];
		}

		if (!element) {
			// Root: don't block first paint on the (potentially large) changed-files diff.
			// If this comparison's files aren't loaded yet, kick off the scan asynchronously and
			// show a lightweight placeholder; fire a change event when it resolves to re-render.
			const key = `${active.baseCommit ?? active.base}...${active.compareCommit ?? active.compare}`;
			if (this.loadedKey !== key) {
				if (this.loadingKey !== key) {
					this.loadingKey = key;
					void active.getChangedFiles().then((files) => {
						this.paths = files.map((f) => f.relPath);
						this.loadedKey = key;
						this.loadingKey = undefined;
						this._onDidChangeTreeData.fire();
					});
				}
				const loading = new FileNode(
					'file',
					'Loading changes…',
					vscode.TreeItemCollapsibleState.None,
					'',
				);
				loading.iconPath = new vscode.ThemeIcon('sync~spin');
				return [loading];
			}
		}

		const tBuild = !element ? Date.now() : 0;
		const tree = this.buildTree(this.paths);
		const prefix = element && element.kind === 'folder' ? element.relPath : '';
		const subtree = prefix ? this.descend(tree, prefix) : tree;
		if (!subtree) {
			return [];
		}
		const rows = this.renderLevel(subtree, prefix, active);
		if (!element) {
			// Root build (files loaded) — capture the "before" cardinality for the webview conversion.
			perfCount('files.build', tBuild, rows.length, `paths=${this.paths.length}`);
		}
		return rows;
	}

	// ── Tree construction ───────────────────────────────────────────────────────

	private buildTree(paths: string[]): DirTree {
		const root: DirTree = { dirs: new Map(), files: [] };
		for (const p of paths) {
			const segments = p.split('/');
			let cursor = root;
			for (let i = 0; i < segments.length - 1; i++) {
				const seg = segments[i];
				let next = cursor.dirs.get(seg);
				if (!next) {
					next = { dirs: new Map(), files: [] };
					cursor.dirs.set(seg, next);
				}
				cursor = next;
			}
			cursor.files.push(segments[segments.length - 1]);
		}
		return root;
	}

	private descend(tree: DirTree, prefix: string): DirTree | undefined {
		let cursor: DirTree | undefined = tree;
		for (const seg of prefix.split('/')) {
			cursor = cursor?.dirs.get(seg);
			if (!cursor) {
				return undefined;
			}
		}
		return cursor;
	}

	private renderLevel(node: DirTree, prefix: string, active: ActiveComparison): FileNode[] {
		const out: FileNode[] = [];

		// Folders first, alphabetical.
		const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
		for (const name of dirNames) {
			const relPath = prefix ? `${prefix}/${name}` : name;
			const folder = new FileNode(
				'folder',
				name,
				this.filesExpanded
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed,
				relPath,
			);
			// Encode the expanded flag in the node id so flipping it changes every folder's
			// identity, forcing VS Code to drop already-materialized Collapsed nodes and
			// re-render them honoring the new Expanded/Collapsed state (the "expand all" fix).
			folder.id = `folder:${relPath}#${this.filesExpanded ? 'e' : 'c'}`;
			folder.iconPath = new vscode.ThemeIcon('folder');
			folder.contextValue = 'searchlight.fileFolder';
			out.push(folder);
		}

		// Then files, alphabetical.
		const reviewed = new Set(active.review?.reviewedFiles ?? []);
		const files = [...node.files].sort((a, b) => a.localeCompare(b));
		for (const name of files) {
			const relPath = prefix ? `${prefix}/${name}` : name;
			const abs = path.join(active.repoRootFsPath, relPath);
			const leaf = new FileNode('file', name, vscode.TreeItemCollapsibleState.None, relPath);
			// Keep leaf ids in lockstep with the folder id-toggle so a full re-render is
			// consistent; checkbox state is re-derived from reviewedFiles below, so this is safe.
			leaf.id = `file:${relPath}#${this.filesExpanded ? 'e' : 'c'}`;
			leaf.resourceUri = vscode.Uri.file(abs);
			leaf.description = prefix || undefined;
			leaf.checkboxState = reviewed.has(relPath)
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
			leaf.contextValue = 'searchlight.file';
			leaf.command = {
				command: 'searchlight.openFileDiff',
				title: 'Open Diff',
				arguments: [relPath],
			};
			out.push(leaf);
		}

		return out;
	}
}
