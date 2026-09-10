const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { formatConversation, conversationTarget } = require('../out/conversationModel');
const { classifyEditorInput } = require('../out/usageContext');

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

function reviewFixture() {
	const root = path.resolve('fixture-workspace');
	return {
		root,
		review: {
			version: 2, sourceFile: path.join(root, '.vscode', 'searchlight-reviews', 'feature_main', 'comments.json'),
			sourceBranch: 'feature', targetBranch: 'main',
			threads: [{
				id: 'thread-1', seq: 3, filePath: 'deleted-never-committed.ts', startLine: 12, endLine: 12,
				anchorText: 'const original = `saved anchor`;', tags: [], state: 'unresolved',
				comments: [
					{ id: 'question', author: { kind: 'human', name: 'Reviewer' }, body: 'Question\nwith a second line' },
					{ id: 'answer', replyTo: 'question', author: { kind: 'agent', name: 'Copilot', model: 'Model', version: '1.2' },
						timestamp: '2026-09-10T10:00:00Z', body: 'Full explanation\n\n```ts\nconst answer = 42;\n```\n\nFinal recommendation.' },
				],
			}],
		},
	};
}

test('full Copilot replies and saved context remain readable without reconstructing deleted uncommitted code', () => {
	const { review } = reviewFixture();
	const original = JSON.stringify(review);
	const text = formatConversation(review, review.threads[0], 3);
	assert.ok(text.includes(review.threads[0].comments[1].body));
	assert.ok(text.includes(review.threads[0].anchorText));
	assert.match(text, /Original code location.*deleted-never-committed\.ts:12/);
	assert.match(text, /Model \/ 1\.2/);
	assert.match(text, /Reply to:\*\* comment 1/);
	assert.match(text, /may never have existed in Git/);
	assert.equal(JSON.stringify(review), original);
	delete review.threads[0].anchorText;
	assert.match(formatConversation(review, review.threads[0], 3), /No code anchor was saved/);
});

function providerFixture() {
	const fixture = reviewFixture();
	let current = fixture.review;
	const loads = [], shown = [], closedHandlers = new Set();
	function uri(scheme, fsPath, query = '') {
		return { scheme, path: fsPath, fsPath, query, toString: () => `${scheme}:${fsPath}?${encodeURIComponent(query)}` };
	}
	let provider;
	const vscode = {
		EventEmitter: class {
			constructor() {
				this.handlers = new Set();
				this.event = (handler) => { this.handlers.add(handler); return { dispose: () => this.handlers.delete(handler) }; };
			}
			fire(value) { for (const handler of this.handlers) { handler(value); } }
			dispose() { this.handlers.clear(); }
		},
		Uri: { file: (file) => uri('file', file), from: (value) => uri(value.scheme, value.path, value.query) },
		workspace: {
			workspaceFolders: [{ uri: uri('file', fixture.root) }],
			onDidCloseTextDocument: (handler) => { closedHandlers.add(handler); return { dispose: () => closedHandlers.delete(handler) }; },
			openTextDocument: async (uri) => {
				assert.equal(uri.scheme, 'searchlight-conversation', 'opening a transcript must not open the code file');
				const text = await provider.provideTextDocumentContent(uri);
				return { uri, getText: () => text };
			},
		},
		window: { showTextDocument: async (document, options) => shown.push({ document, options }) },
	};
	const module = loadCompiled('conversationDocument', {
		vscode, './reviewStore': { loadReview: async (uri) => { loads.push(uri.fsPath); return current; } },
	});
	provider = new module.ConversationDocumentProvider();
	return {
		...fixture, provider, loads, shown, vscode,
		setReview(value) { current = value; },
		close(uri) { for (const handler of closedHandlers) { handler({ uri }); } },
		uri(target) { return vscode.Uri.from({ scheme: module.CONVERSATION_SCHEME, path: '/Conversation-03.md', query: JSON.stringify(target) }); },
	};
}

test('conversation tabs read only saved review data, refresh on replies, and preserve a labeled last snapshot', async () => {
	const f = providerFixture();
	try {
		await f.provider.open(conversationTarget(f.review.sourceFile, f.review.threads[0], 0));
		const { document, options } = f.shown[0];
		assert.equal(options.preview, false);
		assert.equal(classifyEditorInput({ uri: document.uri }), 'searchlight-conversation');
		assert.ok(document.getText().includes('Final recommendation.'));
		assert.deepEqual(f.loads, [f.review.sourceFile]);
		const changed = [];
		f.provider.onDidChange((uri) => changed.push(uri.toString()));
		f.review.threads[0].comments.push({ body: 'A newly saved Copilot response.', author: { kind: 'agent', name: 'Copilot' } });
		f.provider.refresh(f.vscode.Uri.file(f.review.sourceFile));
		assert.deepEqual(changed, [document.uri.toString()]);
		assert.match(await f.provider.provideTextDocumentContent(document.uri), /newly saved Copilot response/);
		f.setReview(undefined);
		const cached = await f.provider.provideTextDocumentContent(document.uri);
		assert.match(cached, /last successfully loaded transcript/);
		assert.match(cached, /newly saved Copilot response/);
		f.close(document.uri);
		await assert.rejects(f.provider.provideTextDocumentContent(document.uri), /saved conversation is unavailable/);
	} finally { f.provider.dispose(); }
});

test('stable IDs never fall back to another thread, and identical IDs in different reviews have separate tabs', async () => {
	const f = providerFixture();
	try {
		const originalTarget = conversationTarget(f.review.sourceFile, f.review.threads[0], 0);
		await f.provider.open(originalTarget);
		f.review.sourceFile = path.join(f.root, '.vscode', 'searchlight-reviews', 'other_main', 'comments.json');
		f.review.threads[0].comments[0].body = 'Different review';
		await f.provider.open(conversationTarget(f.review.sourceFile, f.review.threads[0], 0));
		assert.notEqual(f.shown[0].document.uri.toString(), f.shown[1].document.uri.toString());
		const bad = { ...originalTarget, threadId: 'unknown-id' };
		await assert.rejects(f.provider.provideTextDocumentContent(f.uri(bad)), /saved conversation is unavailable/);
	} finally { f.provider.dispose(); }
});

test('legacy snapshots cannot silently change identity after reordered or edited review data', async () => {
	const f = providerFixture();
	try {
		delete f.review.threads[0].id;
		const target = conversationTarget(f.review.sourceFile, f.review.threads[0], 0);
		const uri = f.uri(target);
		const first = await f.provider.provideTextDocumentContent(uri);
		assert.match(first, /Legacy conversation snapshot/);
		f.review.threads[0].comments[0].body = 'Different legacy thread at this sequence';
		assert.equal(await f.provider.provideTextDocumentContent(uri), first);
		f.close(uri);
		await assert.rejects(f.provider.provideTextDocumentContent(uri), /saved conversation is unavailable/);
	} finally { f.provider.dispose(); }
});

test('invalid or out-of-workspace conversation references are rejected before any reads', async () => {
	const f = providerFixture();
	try {
		const target = conversationTarget(f.review.sourceFile, f.review.threads[0], 0);
		for (const bad of [
			{ ...target, reviewFile: path.resolve(f.root, '..', 'comments.json') },
			{ ...target, reviewFile: path.join(f.root, '.vscode', 'settings.json') },
			{ ...target, seq: 0 },
		]) {
			await assert.rejects(f.provider.open(bad));
		}
		assert.equal(f.loads.length, 0);
	} finally { f.provider.dispose(); }
});

test('flat review files discovered directly under the review store can also be read', async () => {
	const f = providerFixture();
	try {
		f.review.sourceFile = path.join(f.root, '.vscode', 'searchlight-reviews', 'comments.json');
		await f.provider.open(conversationTarget(f.review.sourceFile, f.review.threads[0], 0));
		assert.ok(f.shown[0].document.getText().includes('Final recommendation.'));
	} finally { f.provider.dispose(); }
});

class Element {
	constructor() { this.children = []; this.handlers = {}; this.selected = new Map(); }
	set innerHTML(html) {
		this.children = [];
		this.selected.clear();
		for (const match of html.matchAll(/class="([^"]+)"/g)) {
			const child = new Element();
			for (const name of match[1].split(' ')) { this.selected.set(`.${name}`, child); }
		}
	}
	querySelector(selector) { return this.selected.get(selector); }
	appendChild(child) { this.children.push(child); return child; }
	addEventListener(name, handler) { this.handlers[name] = handler; }
	setAttribute() {}
}

test('thread and reply clicks default to code while Read remains independent of file availability', () => {
	const messages = [];
	const { ConversationsWebviewProvider } = loadCompiled('conversationsWebview', {
		vscode: {},
		'./webviewMetrics': { PaneMetrics: class {} },
	});
	const provider = new ConversationsWebviewProvider(() => undefined, {});
	const scripts = [...provider.html({ cspSource: 'fixture' }).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
	const context = {
		document: { getElementById: () => new Element(), createElement: () => new Element(), createDocumentFragment: () => new Element() },
		window: { addEventListener() {} }, performance: { now: () => 0 }, reportRendered() {},
		vscode: { postMessage: (message) => messages.push(message) },
	};
	vm.runInNewContext(scripts.at(-1)[1], context);
	messages.length = 0;
	const { review } = reviewFixture();
	const wire = {
		num: '03', target: conversationTarget(review.sourceFile, review.threads[0], 0), resolved: true,
		threadId: 'thread-1', drift: 'orphaned', hasFile: true, filePath: 'deleted-never-committed.ts',
		loc: 'deleted-never-committed.ts:12', navStart: 12, navEnd: 12, comments: [],
	};
	const row = context.renderThread(wire).children[0];
	row.handlers.click();
	row.querySelector('.read-action').handlers.click({ stopPropagation() {} });
	const reply = context.renderComment({ name: 'Copilot', firstLine: 'Full explanation', tags: [] }, wire);
	reply.handlers.click({ stopPropagation() {} });
	assert.deepEqual(messages.map((message) => message.type), ['navigate', 'viewConversation', 'navigate']);
	assert.equal(messages[1].target.reviewFile, review.sourceFile);
	reply.handlers.keydown({ key: 'Enter', preventDefault() {} });
	assert.equal(messages.at(-1).type, 'navigate');
	row.querySelector('.code-action').handlers.click({ stopPropagation() {} });
	assert.equal(messages.at(-1).type, 'navigate');
	row.querySelector('.action').handlers.click({ stopPropagation() {} });
	assert.equal(messages.at(-1).type, 'unresolve');
	const unlocated = context.renderThread({ ...wire, hasFile: false, filePath: undefined }).children[0];
	assert.ok(unlocated.querySelector('.read-action'));
	assert.equal(unlocated.querySelector('.code-action'), undefined);
	unlocated.handlers.click();
	assert.equal(messages.at(-1).type, 'viewConversation');
});
