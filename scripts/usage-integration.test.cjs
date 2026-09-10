const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { classifyEditorInput, editorInputIdentity } = require('../out/usageContext');

function loadCompiled(name, mocks) {
	const filename = path.resolve(__dirname, '..', 'out', `${name}.js`);
	const module = { exports: {} };
	const nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	return module.exports;
}

test('editor usage distinguishes Git-backed and Searchlight diffs without pretending ordinary files came from SCM', () => {
	const uri = (scheme) => ({ scheme, path: 'private-path', query: 'private-ref', fsPath: 'private-file' });
	assert.equal(classifyEditorInput({ original: uri('git'), modified: uri('file') }), 'git-diff');
	assert.equal(classifyEditorInput({ original: uri('searchlight-diff'), modified: uri('file') }), 'searchlight-diff');
	assert.equal(classifyEditorInput({ uri: uri('file') }), 'text-editor');
	assert.equal(classifyEditorInput({ uri: uri('vscode-remote') }), 'text-editor');
	assert.equal(classifyEditorInput({ uri: uri('custom-private-scheme') }), 'other');
	assert.equal(classifyEditorInput({ textDiffs: [{ original: uri('searchlight-diff'), modified: uri('file') }] }), 'searchlight-diff');
	assert.equal(classifyEditorInput(undefined), 'none');
	assert.equal(classifyEditorInput({ viewType: 'private-view-title' }), 'other');
});

test('editor identity ignores recreated API wrappers but distinguishes files and revisions', () => {
	const input = (file = '/file.ts', ref = '~') => ({
		original: { scheme: 'git', path: file, query: ref },
		modified: { scheme: 'file', path: file, query: '' },
	});
	assert.equal(editorInputIdentity(input()), editorInputIdentity(input()));
	assert.notEqual(editorInputIdentity(input()), editorInputIdentity(input('/different.ts')));
	assert.notEqual(editorInputIdentity(input()), editorInputIdentity(input('/file.ts', 'HEAD')));
	assert.equal(editorInputIdentity({ textDiffs: [input()] }), editorInputIdentity({ textDiffs: [input()] }));
});

function commentFixture() {
	const usage = [], saved = [], created = [], visibleHandlers = new Set();
	let scans = 0, initializationCount = 0;
	const uri = (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file:${fsPath}` });
	const folder = uri(path.resolve('private-workspace'));
	const file = uri(path.join(folder.fsPath, 'file.ts'));
	const review = {
		sourceFile: path.join(folder.fsPath, 'private-review.json'),
		threads: [{ id: 'private-thread-id', filePath: 'file.ts', startLine: 1, endLine: 1, tags: [], state: 'unresolved', comments: [], seq: 1 }],
	};
	const active = { review: undefined, async reloadReview() {} };
	const window = {
		visibleTextEditors: [{ document: { uri: file } }],
		onDidChangeVisibleTextEditors: (handler) => {
			visibleHandlers.add(handler);
			return { dispose: () => visibleHandlers.delete(handler) };
		},
		setStatusBarMessage() {}, showWarningMessage() {}, showInformationMessage() {},
	};
	class Range {
		constructor(startLine, startCharacter, endLine, endCharacter) {
			this.start = { line: startLine, character: startCharacter };
			this.end = { line: endLine, character: endCharacter };
		}
	}
	const vscode = {
		window, Range,
		CommentThreadState: { Resolved: 1, Unresolved: 0 },
		CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
		Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
		workspace: {
			workspaceFolders: [{ uri: folder }], textDocuments: [],
			getConfiguration: () => ({ get: (_key, fallback) => fallback }),
			getWorkspaceFolder: () => ({ uri: folder }),
			openTextDocument: async () => ({ lineCount: 1, lineAt: () => ({ text: 'private-source-code' }) }),
		},
		comments: { createCommentController: () => ({
			createCommentThread(uri, range, comments) {
				const thread = { uri, range, comments, dispose() {} };
				created.push(thread);
				return thread;
			},
			dispose() {},
		}) },
	};
	const store = {
		scanReviews: async () => { scans++; return [review]; },
		loadReview: async () => review,
		saveReview: async (value) => saved.push(value),
		humanAuthor: () => ({ kind: 'human', name: 'private-author' }),
		addReply() {}, addThreadTags() {}, addThread() {},
		setThreadState: (value, id, state) => { value.threads.find((thread) => thread.id === id).state = state; },
	};
	const { SearchlightCommentController } = loadCompiled('commentController', {
		vscode, './reviewStore': store, './git': { getGitUserName: async () => 'private-author' },
		'./perf': { perf() {}, perfLine() {} },
		'./usage': { recordUsage: (event, fields) => usage.push({ event, fields }) },
	});
	const controller = new SearchlightCommentController(() => active, async () => {
		initializationCount++;
		active.review = review;
	});
	return {
		controller, usage, saved, created, review, active, store, window, file, Range,
		scans: () => scans, initializationCount: () => initializationCount,
		changeVisible(editors) { window.visibleTextEditors = editors; for (const handler of visibleHandlers) { handler(editors); } },
	};
}

test('existing discussions materialize with an already-visible editor, without initializing a comparison', async () => {
	const f = commentFixture();
	try {
		await f.controller.render();
		assert.equal(f.controller.materialized, true);
		await f.controller.ensureMaterialized();
		assert.equal(f.created.length, 1);
		assert.equal(f.scans(), 1);
		assert.equal(f.initializationCount(), 0);
		assert.deepEqual(f.usage, [{ event: 'discussion.exposed', fields: { count: 1 } }]);
		await f.controller.ensureMaterialized();
		assert.equal(f.usage.length, 1);
		f.changeVisible([]);
		f.changeVisible([{ document: { uri: f.file } }]);
		assert.equal(f.usage.length, 2);
	} finally {
		f.controller.dispose();
	}
});

test('replying to a bound SCM discussion saves without branch initialization and logs no private text', async () => {
	const f = commentFixture();
	try {
		await f.controller.ensureMaterialized();
		await f.controller.handleReply({ thread: f.created[0], text: 'private-comment-body' });
		assert.equal(f.initializationCount(), 0);
		assert.equal(f.saved.length, 1);
		assert.ok(f.usage.some((event) => event.event === 'discussion.replied'));
		assert.ok(!JSON.stringify(f.usage).includes('private-'));
		await f.controller.setState(f.created[0], 'resolved');
		assert.ok(f.usage.some((event) => event.event === 'discussion.resolved'));
		assert.equal(f.initializationCount(), 0);
	} finally {
		f.controller.dispose();
	}
});

test('a first new inline discussion initializes its current comparison without requiring any pane', async () => {
	const f = commentFixture();
	try {
		await f.controller.handleReply({
			thread: { uri: f.file, range: new f.Range(0, 0, 0, 0), dispose() {} },
			text: 'private-new-comment',
		});
		assert.equal(f.initializationCount(), 1);
		assert.equal(f.saved[0], f.active.review);
		assert.ok(f.usage.some((event) => event.event === 'discussion.created'));
		assert.ok(!JSON.stringify(f.usage).includes('private-'));
	} finally {
		f.controller.dispose();
	}
});

test('failed discussion persistence does not count as a completed feature mutation', async () => {
	const f = commentFixture();
	try {
		f.store.saveReview = async () => { throw new Error('write failed'); };
		await assert.rejects(f.controller.handleReply({
			thread: { uri: f.file, range: new f.Range(0, 0, 0, 0), dispose() {} },
			text: 'private-new-comment',
		}), /write failed/);
		assert.equal(f.initializationCount(), 1);
		assert.ok(!f.usage.some((event) => event.event === 'discussion.created'));
	} finally {
		f.controller.dispose();
	}
});
