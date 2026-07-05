/**
 * Read-only diff support for the active comparison.
 *
 * Registers a `TextDocumentContentProvider` for the `searchlight-diff` scheme that serves a file's
 * contents at an arbitrary git ref (via `git show <ref>:<path>`), and exposes `openFileDiff` which
 * opens VS Code's native diff editor comparing base ↔ compare for a single changed file.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActiveComparison } from './activeComparison';
import { changedFilesForCommit } from './git';

const execFileAsync = promisify(execFile);

/** URI scheme used to serve historical file content for the diff editor. */
export const DIFF_SCHEME = 'searchlight-diff';

/**
 * Serves file content at a given git ref for the diff editor.
 *
 * // ASSUMPTION: mirrors how the built-in git extension serves historical file content for its diffs
 * // (`git show <ref>:<path>`); this is not a public VS Code API contract, just the same mechanism.
 */
export class ReviewDiffContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = new URLSearchParams(uri.query);
		const ref = params.get('ref');
		const cwd = params.get('cwd');
		// uri.path is '/'-prefixed and forward-slashed; strip the leading slash for `git show`.
		const relPath = uri.path.replace(/^\//, '');
		if (!ref || !cwd || !relPath) {
			return '';
		}
		try {
			const { stdout } = await execFileAsync('git', ['show', `${ref}:${relPath}`], {
				cwd,
				maxBuffer: 50 * 1024 * 1024,
				windowsHide: true,
			});
			return stdout;
		} catch {
			// Added/deleted files won't exist on one side — show as empty rather than erroring.
			return '';
		}
	}
}

/** Build a `searchlight-diff` URI that serves `relPath` at `ref` from the repo at `cwd`. */
function diffUri(relPath: string, ref: string, cwd: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: DIFF_SCHEME,
		path: '/' + relPath,
		query: 'ref=' + encodeURIComponent(ref) + '&cwd=' + encodeURIComponent(cwd),
	});
}

function short(ref: string): string {
	// Abbreviate a 40-char sha; leave branch names as-is.
	return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/**
 * Open the native diff editor for a single changed file in the active comparison.
 * Left = base ref (read-only). Right = the working-tree file when `compare` is the checked-out HEAD
 * (so the user can edit and comment inline), otherwise the compare ref (read-only).
 */
export async function openFileDiff(active: ActiveComparison, relPath: string): Promise<void> {
	const cwd = active.repoRootFsPath;
	const base = active.base;
	const compare = active.compare;
	if (!cwd || !base || !compare) {
		return;
	}

	const leftUri = diffUri(relPath, base, cwd);

	const compareIsHead =
		(active.headBranch !== undefined && compare === active.headBranch) ||
		(active.compareCommit !== undefined && active.compareCommit === active.headCommit);

	const rightUri = compareIsHead
		? vscode.Uri.file(path.join(cwd, relPath))
		: diffUri(relPath, compare, cwd);

	const title = `${relPath} (${short(base)} \u2194 ${short(compare)})`;
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: false });
}

/** Compute whether the compare side is the checked-out HEAD (working tree = right side). */
function compareIsHead(active: ActiveComparison): boolean {
	return (
		(active.headBranch !== undefined && active.compare === active.headBranch) ||
		(active.compareCommit !== undefined && active.compareCommit === active.headCommit)
	);
}

/**
 * Open a multi-file diff (VS Code's `vscode.changes`) of ALL changed files in the active
 * comparison: base content (left) ↔ compare content (right). When compare is the checked-out HEAD
 * the right side is the working-tree file so edits/comments stay live.
 */
export async function openAllChangesDiff(active: ActiveComparison): Promise<void> {
	const cwd = active.repoRootFsPath;
	const base = active.base;
	const compare = active.compare;
	if (!cwd || !base || !compare) {
		return;
	}
	const files = await active.getChangedFiles();
	if (files.length === 0) {
		void vscode.window.showInformationMessage('Searchlight: no changed files between base and compare.');
		return;
	}
	const rightIsHead = compareIsHead(active);
	const resources = files.map((rel) => {
		const resourceUri = vscode.Uri.file(path.join(cwd, rel));
		const leftUri = diffUri(rel, base, cwd);
		const rightUri = rightIsHead ? vscode.Uri.file(path.join(cwd, rel)) : diffUri(rel, compare, cwd);
		return [resourceUri, leftUri, rightUri] as [vscode.Uri, vscode.Uri, vscode.Uri];
	});
	const title = `Changes: ${short(base)} \u2194 ${short(compare)}`;
	await vscode.commands.executeCommand('vscode.changes', title, resources);
}

/**
 * Open a multi-file diff of a single commit `sha`: its parent content (left) ↔ its content (right).
 * Both sides are historical (read-only). Root commits have no parent, so `sha^` errors in the
 * content provider and is served as empty — correctly rendering every file as "added".
 */
export async function openCommitDiff(active: ActiveComparison, sha: string): Promise<void> {
	const cwd = active.repoRootFsPath;
	if (!cwd || !sha) {
		return;
	}
	const files = await changedFilesForCommit(cwd, sha);
	if (files.length === 0) {
		void vscode.window.showInformationMessage(`Searchlight: commit ${short(sha)} changed no files.`);
		return;
	}
	const resources = files.map((rel) => {
		const resourceUri = vscode.Uri.file(path.join(cwd, rel));
		const leftUri = diffUri(rel, `${sha}^`, cwd);
		const rightUri = diffUri(rel, sha, cwd);
		return [resourceUri, leftUri, rightUri] as [vscode.Uri, vscode.Uri, vscode.Uri];
	});
	const title = `Commit ${short(sha)}: ${files.length} file(s)`;
	await vscode.commands.executeCommand('vscode.changes', title, resources);
}

/**
 * Open the native diff editor for a single file within a single commit `sha`: its parent content
 * (left, `sha^`) ↔ its content (right, `sha`). Both sides are historical (read-only). Root commits
 * have no parent, so `sha^` errors in the content provider and is served as empty — correctly
 * rendering the file as "added".
 */
export async function openCommitFileDiff(
	active: ActiveComparison,
	sha: string,
	relPath: string,
): Promise<void> {
	const cwd = active.repoRootFsPath;
	if (!cwd || !sha || !relPath) {
		return;
	}
	const leftUri = diffUri(relPath, `${sha}^`, cwd);
	const rightUri = diffUri(relPath, sha, cwd);
	const title = `${relPath} (${short(sha)}^ \u2194 ${short(sha)})`;
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: false });
}
