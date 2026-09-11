const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { parseReview } = require('../out/reviewModel');
const { conversationTarget } = require('../out/conversationModel');
const { renderConversationMarkdown, buildConversationPageData } = require('../out/conversationPageModel');
const { classifyEditorInput } = require('../out/usageContext');

function load(name, mocks) {
	const filename = path.resolve(__dirname, '..', 'out', `${name}.js`);
	const module = { exports: {} };
	const nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	return module.exports;
}

function fixture() {
	const root = path.resolve('private-workspace');
	const files = new Map(), writes = [], directories = [], panels = [], usage = [], asks = [], errors = [], clipboard = [], links = [];
	const uri = (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file:${fsPath}` });
	let readHook;
	class Emitter {
		constructor() { this.handlers = []; this.event = (handler) => { this.handlers.push(handler); return { dispose() {} }; }; }
		fire(value) { for (const handler of this.handlers) { handler(value); } }
		dispose() {}
	}
	function makePanel() {
		const messages = [];
		let disposed;
		const panel = {
			title: '', messages, disposed: false,
			webview: {
				cspSource: 'fixture',
				postMessage: async (message) => { messages.push(message); return true; },
				onDidReceiveMessage: () => ({ dispose() {} }),
			},
			onDidDispose: (handler) => { disposed = handler; return { dispose() {} }; },
			dispose() { this.disposed = true; disposed?.(); },
			reveal() { this.revealed = true; },
		};
		panels.push(panel);
		return panel;
	}
	const vscode = {
		EventEmitter: Emitter, ViewColumn: { Active: -1 },
		Uri: { file: uri, parse: (value) => ({ toString: () => value }) },
		env: {
			clipboard: { writeText: async (text) => clipboard.push(text) },
			openExternal: async (value) => links.push(value.toString()),
		},
		window: {
			createWebviewPanel: makePanel,
			showErrorMessage: (message) => errors.push(message),
		},
		workspace: {
			workspaceFolders: [{ uri: uri(root) }],
			getWorkspaceFolder: () => ({ uri: uri(root) }),
			onDidCloseTextDocument: () => ({ dispose() {} }),
			fs: {
				readFile: async (value) => {
					readHook?.(value.fsPath);
					if (!files.has(value.fsPath)) { throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); }
					return Buffer.from(files.get(value.fsPath));
				},
				createDirectory: async (value) => directories.push(value.fsPath),
				writeFile: async (value, bytes) => { writes.push(value.fsPath); files.set(value.fsPath, bytes.toString()); },
			},
		},
	};
	const store = load('reviewStore', { vscode });
	const document = load('conversationDocument', { vscode, './reviewStore': store });
	const pageStore = load('conversationPageStore', { vscode, './reviewStore': store, './conversationDocument': document });
	const hooks = {
		changed: async () => {},
		askCopilot: async (file, id) => asks.push({ file, id }),
		openCode: async () => { throw new Error('Code file was deleted'); },
	};
	const { ConversationPages } = load('conversationPage', {
		vscode, './reviewStore': store, './conversationDocument': document, './conversationPageStore': pageStore,
		'./conversationPageHtml': { conversationPageHtml: () => '<html></html>' },
		'./git': { getGitUserName: async () => 'Tester' },
		'./usage': { recordUsage: (event, details) => usage.push({ event, details }) },
	});
	const manager = new ConversationPages(hooks);
	const review = store.emptyReview(root, 'feature', 'main');
	return {
		root, files, writes, directories, panels, usage, asks, errors, clipboard, links,
		store, pageStore, manager, review, hooks, makePanel,
		page: () => [...manager.pages.values()][0],
		state: () => panels[0].messages.filter((message) => message.type === 'state').at(-1).data,
		lastResult: () => panels[0].messages.filter((message) => message.type === 'result').at(-1),
		setReadHook(hook) { readHook = hook; },
	};
}

test('general conversations preserve a subject and have no fake code location after serialization', () => {
	const f = fixture();
	const thread = f.store.addGeneralThread(f.review, 'A review-wide question', f.store.humanAuthor('Tester'), 'Build concerns');
	const serialized = JSON.stringify(f.store.serializeReview(f.review));
	const parsed = parseReview(serialized, f.review.sourceFile);
	assert.equal(parsed.threads[0].title, 'Build concerns');
	assert.equal(thread.seq, 1);
	for (const field of ['filePath', 'startLine', 'endLine', 'anchorText']) {
		assert.ok(!Object.hasOwn(JSON.parse(serialized).threads[0], field));
	}
});

test('Markdown renders structure and code without executable HTML, command links or remote images', async () => {
	const html = await renderConversationMarkdown('# Answer\n\n- One\n- Two\n\n```ts\nconst x = "<script>";\n```\n\n<script>alert(1)</script>\n![tracker](https://example.com/a.png)\n[bad](javascript:alert(1))');
	assert.match(html, /<h1>Answer<\/h1>/);
	assert.match(html, /<ul>/);
	assert.match(html, /<pre><code class="language-ts">/);
	assert.ok(!html.includes('<script>'));
	assert.ok(!html.includes('<img'));
	assert.ok(!html.includes('href="javascript:'));
	assert.match(html, /Image omitted/);
	assert.equal(classifyEditorInput({ viewType: 'searchlight.conversationPage' }), 'searchlight-conversation');
});

test('opening a draft never writes; posting creates a review-wide conversation and asks Copilot only explicitly', async () => {
	const f = fixture();
	try {
		await f.manager.openNew(f.review);
		assert.equal(f.writes.length, 0);
		assert.equal(f.directories.length, 0);
		assert.equal(f.state().mode, 'new');
		assert.equal(f.state().location, undefined);
		await f.manager.handle(f.page(), { type: 'preview', body: '**Draft preview**', requestId: 1 });
		assert.match(f.panels[0].messages.at(-1).html, /<strong>Draft preview<\/strong>/);
		assert.equal(f.writes.length, 0);
		await f.manager.handle(f.page(), { type: 'post', title: 'Review plan', body: '    Keep this indentation', askCopilot: false });
		assert.equal(f.writes.length, 1);
		assert.equal(f.asks.length, 0);
		assert.equal(f.state().title, 'Review plan');
		assert.equal(f.state().mode, 'thread');
		assert.equal(f.lastResult().clearDraft, true);
		const saved = JSON.parse(f.files.get(f.review.sourceFile));
		assert.equal(saved.threads[0].comments[0].body, '    Keep this indentation');
		assert.ok(!Object.hasOwn(saved.threads[0], 'filePath'));
		await f.manager.handle(f.page(), { type: 'post', body: 'Please evaluate this plan.', askCopilot: true });
		assert.equal(f.asks.length, 1);
		assert.equal(f.asks[0].id, saved.threads[0].id);
		assert.equal(f.state().comments.length, 2);
		assert.ok(!JSON.stringify(f.usage).includes('Please evaluate'));
	} finally { f.manager.dispose(); }
});

test('page mutations are serialized and reject observed external edits instead of overwriting them', async () => {
	const f = fixture();
	const updates = new f.pageStore.ConversationUpdates();
	const first = f.pageStore.newPageReference(f.review), second = f.pageStore.newPageReference(f.review);
	await Promise.all([
		updates.update(first, (review) => f.store.addGeneralThread(review, 'First', f.store.humanAuthor('Tester'))),
		updates.update(second, (review) => f.store.addGeneralThread(review, 'Second', f.store.humanAuthor('Tester'))),
	]);
	assert.equal(JSON.parse(f.files.get(f.review.sourceFile)).threads.length, 2);
	let reads = 0;
	f.setReadHook((file) => {
		if (++reads === 2) {
			const external = JSON.parse(f.files.get(file));
			external.threads[0].comments.push({ body: 'External Copilot reply' });
			f.files.set(file, JSON.stringify(external));
		}
	});
	const before = f.writes.length;
	await assert.rejects(updates.update(first, (review) => f.store.addGeneralThread(review, 'Keep my draft', f.store.humanAuthor('Tester'))), /review changed/);
	assert.equal(f.writes.length, before);
	assert.ok(f.files.get(f.review.sourceFile).includes('External Copilot reply'));
});

test('invalid review data is never replaced by a new empty review, and failed posting keeps the draft', async () => {
	const f = fixture();
	try {
		await f.manager.openNew(f.review);
		f.files.set(f.review.sourceFile, '{incomplete');
		await f.manager.handle(f.page(), { type: 'post', body: 'Keep this draft' });
		assert.equal(f.writes.length, 0);
		assert.equal(f.lastResult().ok, false);
		assert.equal(f.lastResult().clearDraft, false);
		assert.equal(f.state().writable, false);
		assert.equal(f.files.get(f.review.sourceFile), '{incomplete');
	} finally { f.manager.dispose(); }
});

test('blank drafts and duplicate submissions cannot create review files or discard text', async () => {
	const f = fixture();
	try {
		await f.manager.openNew(f.review);
		await f.manager.handle(f.page(), { type: 'post', body: ' \n ' });
		assert.equal(f.writes.length, 0);
		assert.equal(f.directories.length, 0);
		assert.equal(f.lastResult().clearDraft, false);
		f.page().busy = true;
		await f.manager.handle(f.page(), { type: 'post', body: 'Keep this message' });
		assert.equal(f.writes.length, 0);
		assert.match(f.lastResult().message, /already in progress/);
	} finally { f.manager.dispose(); }
});

test('saved discussions update from Copilot, work without code, and expose explicit resolve/reopen', async () => {
	const f = fixture();
	try {
		const thread = f.store.addThread(f.review, 'deleted.ts', 2, 2, 'Question', f.store.humanAuthor('Tester'), [], 'saved anchor');
		f.files.set(f.review.sourceFile, JSON.stringify(f.store.serializeReview(f.review)));
		await f.manager.open(conversationTarget(f.review.sourceFile, thread, 0));
		assert.equal(f.state().location.anchor, 'saved anchor');
		const external = JSON.parse(f.files.get(f.review.sourceFile));
		external.threads[0].comments.push({ author: { kind: 'agent', name: 'Copilot', model: 'Model' }, body: '**Answer**\n\nFull response.' });
		f.files.set(f.review.sourceFile, JSON.stringify(external));
		await f.manager.refreshPage(f.page());
		assert.match(f.state().comments[1].html, /<strong>Answer<\/strong>/);
		assert.equal(f.state().comments[1].kind, 'agent');
		await f.manager.handle(f.page(), { type: 'setResolved', resolved: true });
		assert.equal(f.state().resolved, true);
		await f.manager.handle(f.page(), { type: 'post', body: 'One more question' });
		assert.equal(f.state().resolved, true, 'Replying must not silently reopen a resolved thread');
		await f.manager.handle(f.page(), { type: 'openCode' });
		assert.equal(f.lastResult().ok, false);
		assert.equal(f.state().comments.length, 3);
	} finally { f.manager.dispose(); }
});

test('a failed Copilot launch after saving clears only the already-saved draft and reports the partial outcome', async () => {
	const f = fixture();
	try {
		await f.manager.openNew(f.review);
		f.hooks.askCopilot = async () => { throw new Error('CLI unavailable'); };
		await f.manager.handle(f.page(), { type: 'post', body: 'Saved message', askCopilot: true });
		assert.equal(f.writes.length, 1);
		assert.equal(f.lastResult().ok, false);
		assert.equal(f.lastResult().clearDraft, true);
		assert.match(f.lastResult().message, /Message saved/);
		assert.equal(f.state().comments[0].body, 'Saved message');
	} finally { f.manager.dispose(); }
});

test('legacy pages are read-only and link handling does not execute command or file URLs', async () => {
	const f = fixture();
	try {
		const legacy = parseReview(JSON.stringify({ threads: [{ comments: [{ body: 'Legacy' }] }] }), f.review.sourceFile);
		f.files.set(f.review.sourceFile, JSON.stringify({ threads: [{ comments: [{ body: 'Legacy' }] }] }));
		await f.manager.open(conversationTarget(f.review.sourceFile, legacy.threads[0], 0));
		assert.equal(f.state().legacy, true);
		assert.equal(f.state().writable, false);
		await f.manager.handle(f.page(), { type: 'post', body: 'Do not write' });
		assert.equal(f.writes.length, 0);
		await f.manager.handle(f.page(), { type: 'openLink', href: 'command:evil' });
		assert.equal(f.links.length, 0);
		await f.manager.handle(f.page(), { type: 'openLink', href: 'https://example.com/docs' });
		assert.deepEqual(f.links, ['https://example.com/docs']);
	} finally { f.manager.dispose(); }
});

test('restoring a draft keeps its original review identity without writing or following a new active branch', async () => {
	const f = fixture();
	try {
		const reference = f.pageStore.newPageReference(f.review);
		const panel = f.makePanel();
		await f.manager.deserializeWebviewPanel(panel, { reference, draftBody: 'Restored draft' });
		assert.equal(f.page().reference.reviewFile, f.review.sourceFile);
		assert.equal(f.writes.length, 0);
		assert.equal(f.state().reviewLabel, 'feature -> main');
		const general = await buildConversationPageData(f.review);
		assert.equal(general.canAskCopilot, false);
		assert.equal(general.location, undefined);
	} finally { f.manager.dispose(); }
});

test('the real webview client boots, preserves drafts on refresh/errors, and clears only confirmed submissions', async () => {
	const { conversationPageHtml } = require('../out/conversationPageHtml');
	const html = conversationPageHtml({ cspSource: 'fixture' });
	const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
	const nodes = new Map(), messages = [];
	let receive, persistent = {}, activeElement;
	class Node {
		constructor() { this.children = []; this.handlers = {}; this.dataset = {}; this.value = ''; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 300; }
		addEventListener(type, handler) { this.handlers[type] = handler; }
		dispatchEvent(event) { this.handlers[event.type]?.(event); }
		appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
		set innerHTML(html) { this.html = html; this.text = ''; this.children = []; }
		set textContent(value) { this.text = String(value ?? ''); this.children = []; }
		get textContent() { return this.text || this.children.map((node) => node.textContent).join(''); }
		get lastElementChild() { return this.children.at(-1); }
		remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
		replaceWith(node) { const parent = this.parentNode; parent.children[parent.children.indexOf(this)] = node; node.parentNode = parent; }
		querySelectorAll() { return []; }
		setAttribute(name, value) { this[name] = value; }
		focus() { activeElement = this; }
	}
	const node = (id) => {
		if (!ids.has(id)) { return null; }
		if (!nodes.has(id)) { nodes.set(id, new Node()); }
		return nodes.get(id);
	};
	const main = new Node();
	const context = vm.createContext({
		Element: Node, Event: class { constructor(type) { this.type = type; } },
		document: { getElementById: node, createElement: () => new Node(), querySelector: () => main, querySelectorAll: () => [], addEventListener() {} },
		window: { addEventListener: (type, handler) => { if (type === 'message') { receive = handler; } } },
		acquireVsCodeApi: () => ({ getState: () => persistent, setState: (state) => { persistent = state; }, postMessage: (message) => messages.push(message) }),
		setTimeout: () => 1, clearTimeout() {},
	});
	const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
	vm.runInContext(script, context);
	const f = fixture();
	const data = await buildConversationPageData(f.review);
	const state = () => receive({ data: { type: 'state', reference: { reviewFile: 'private-reference' }, data } });
	state();
	assert.equal(node('page-title').textContent, 'Start a thread');
	assert.equal(activeElement, node('composer-body'));
	node('composer-body').value = 'My **draft**';
	node('composer-title').value = 'Subject';
	node('composer-body').handlers.input();
	state();
	assert.equal(node('composer-body').value, 'My **draft**');
	assert.equal(persistent.draftBody, 'My **draft**');
	node('post-button').handlers.click();
	assert.equal(node('composer-body').disabled, true);
	assert.equal(messages.at(-1).type, 'post');
	assert.equal(messages.at(-1).askCopilot, false);
	receive({ data: { type: 'result', action: 'post', ok: false, clearDraft: false, message: 'Review changed' } });
	assert.equal(node('composer-body').value, 'My **draft**');
	assert.equal(node('page-alert').hidden, false);
	node('post-button').handlers.click();
	receive({ data: { type: 'result', action: 'post', ok: true, clearDraft: true } });
	assert.equal(node('composer-body').value, '');
	assert.equal(node('composer-title').value, '');
	assert.equal(persistent.draftBody, '');
	node('composer-body').value = 'Do not replace this';
	node('composer-body').selectionStart = node('composer-body').selectionEnd = node('composer-body').value.length;
	node('empty-chips').children[0].handlers.click();
	assert.ok(node('composer-body').value.startsWith('Do not replace this'));
	Object.assign(data, {
		mode: 'thread', title: 'Thread #11', number: 11,
		comments: [
			{ name: 'Tester', kind: 'human', details: '', timestamp: '', body: 'Hello', html: '<p>Hello</p>' },
			{ name: 'Copilot', kind: 'agent', details: 'Model / version', timestamp: '', body: 'Reply', html: '<p>Reply</p>' },
		],
	});
	state();
	assert.equal(node('sidebar-review-meta').textContent, 'Thread #11');
	const headers = node('timeline').children.map((card) => card.children[0].children[0].children[1]);
	assert.equal(headers[0].children.length, 1, 'Human headers have no redundant saved-message line');
	assert.equal(headers[0].children[0].children.length, 2);
	assert.equal(headers[1].children.length, 1, 'Agent details belong in the name row');
	assert.equal(headers[1].children[0].children[2].textContent, 'Model / version');
	assert.equal(node('resolve-button').textContent, 'Resolve');
	assert.ok(node('resolve-button').children[0].html.includes('<rect'));
	data.resolved = true;
	state();
	assert.equal(node('resolve-button').textContent, 'Reopen');
	assert.ok(!node('resolve-button').children[0].html.includes('<path'));
});

test('thread-page buttons have fixed decorative icons with visible labels and consistent terminology', async () => {
	const { conversationPageHtml } = require('../out/conversationPageHtml');
	const { THREAD_ICONS } = require('../out/threadIcons');
	const html = conversationPageHtml({ cspSource: 'fixture' });
	const buttons = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)];
	assert.ok(buttons.length >= 7);
	for (const [, attributes, title] of buttons) {
		const icon = /data-icon="([^"]+)"/.exec(attributes)?.[1];
		assert.ok(icon && THREAD_ICONS[icon], `Missing icon for ${title}`);
		assert.ok(THREAD_ICONS[icon].includes('aria-hidden="true"'));
		assert.ok(title.trim());
	}
	assert.ok(!html.includes('Saved message'));
	assert.ok(!html.includes('Conversation #'));
	const f = fixture();
	const thread = f.store.addGeneralThread(f.review, 'Question', f.store.humanAuthor('Tester'));
	assert.equal((await buildConversationPageData(f.review, thread)).title, 'Thread #01');
	const manifest = require('../package.json');
	assert.equal(manifest.contributes.views.searchlight.find((view) => view.id === 'searchlight.conversations').name, 'Threads');
	assert.equal(manifest.contributes.commands.find((command) => command.command === 'searchlight.newConversation').title, 'Searchlight: New Thread');
});
