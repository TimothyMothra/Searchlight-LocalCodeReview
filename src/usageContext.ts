import type { EditorContext } from './usage';

function scheme(value: unknown): string | undefined {
	return typeof value === 'object' && value !== null && 'scheme' in value && typeof value.scheme === 'string'
		? value.scheme : undefined;
}

function uriIdentity(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null || !scheme(value)) { return undefined; }
	return JSON.stringify(['scheme', 'authority', 'path', 'query', 'fragment'].map((key) => {
		const part: unknown = Reflect.get(value, key);
		return typeof part === 'string' ? part : '';
	}));
}

/** Only for transient equality comparisons in the host. Never emit this key to logs or exports. */
export function editorInputIdentity(input: unknown): string {
	if (typeof input !== 'object' || input === null) { return 'none'; }
	if ('original' in input && 'modified' in input) {
		return JSON.stringify(['diff', uriIdentity(input.original), uriIdentity(input.modified)]);
	}
	if ('textDiffs' in input && Array.isArray(input.textDiffs)) {
		return JSON.stringify(['multi-diff', input.textDiffs.map(editorInputIdentity)]);
	}
	if ('uri' in input) { return JSON.stringify(['document', uriIdentity(input.uri)]); }
	if ('viewType' in input && typeof input.viewType === 'string') { return `view:${input.viewType}`; }
	return 'other';
}

/** Classify only URI schemes; never return a filename, query, document text, or tab title. */
export function classifyEditorInput(input: unknown): EditorContext {
	if (input === undefined || input === null) { return 'none'; }
	if (typeof input !== 'object') { return 'other'; }
	if ('viewType' in input && input.viewType === 'searchlight.conversationPage') { return 'searchlight-conversation'; }
	if ('original' in input && 'modified' in input) {
		const schemes = [scheme(input.original), scheme(input.modified)];
		if (schemes.includes('searchlight-diff')) { return 'searchlight-diff'; }
		// ASSUMPTION: git:// diffs are Git-backed editors, not proof the SCM sidebar was clicked.
		if (schemes.includes('git')) { return 'git-diff'; }
		return 'other';
	}
	if ('textDiffs' in input && Array.isArray(input.textDiffs)) {
		const contexts = input.textDiffs.map(classifyEditorInput);
		if (contexts.includes('searchlight-diff')) { return 'searchlight-diff'; }
		if (contexts.includes('git-diff')) { return 'git-diff'; }
		return 'other';
	}
	if ('uri' in input) {
		const value = scheme(input.uri);
		if (value === 'searchlight-conversation') { return 'searchlight-conversation'; }
		if (value === 'searchlight-diff') { return 'searchlight-diff'; }
		if (value === 'git') { return 'git-diff'; }
		if (value === 'file' || value === 'vscode-remote' || value === 'untitled') { return 'text-editor'; }
	}
	return 'other';
}
