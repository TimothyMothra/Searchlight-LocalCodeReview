const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const Module = require('node:module');

// ASSUMPTION: Node's test runner has no extension host. Stub only the VS Code boundary;
// Git reads real disposable object databases without staging or committing in the user's repo.
const vscode = {
	commands: { executeCommand: async () => {} },
	extensions: { getExtension: () => undefined },
	Uri: { file: (fsPath) => ({ fsPath }) },
	workspace: {
		fs: { readFile: (uri) => fs.readFile(uri.fsPath) },
		getConfiguration: () => ({ get: () => false }),
	},
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
};
const git = require('../out/git');
const { ActiveComparison } = require('../out/activeComparison');
const { ComparisonWebviewProvider } = require('../out/comparisonView');
Module._load = originalLoad;

function memento() {
	const values = new Map();
	return {
		get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
		update: async (key, value) => value === undefined ? values.delete(key) : values.set(key, value),
	};
}

async function repository(t) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'searchlight-ancestry-'));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	const metadata = path.join(cwd, '.git');
	await fs.mkdir(path.join(metadata, 'objects'), { recursive: true });
	await fs.mkdir(path.join(metadata, 'refs', 'heads'), { recursive: true });
	await fs.writeFile(path.join(metadata, 'HEAD'), 'ref: refs/heads/feature/child\n');
	await fs.writeFile(path.join(metadata, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
	async function object(type, content) {
		const body = Buffer.from(content);
		const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
		const sha = crypto.createHash('sha1').update(bytes).digest('hex');
		const dir = path.join(metadata, 'objects', sha.slice(0, 2));
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, sha.slice(2)), zlib.deflateSync(bytes));
		return sha;
	}
	const tree = await object('tree', '');
	let timestamp = 1700000000;
	async function commit(subject, parents = [], treeSha = tree) {
		const date = timestamp++;
		return object('commit', `tree ${treeSha}\n${parents.map((p) => `parent ${p}\n`).join('')}` +
			`author Test <test@example.invalid> ${date} +0000\n` +
			`committer Test <test@example.invalid> ${date} +0000\n\n${subject}\n`);
	}
	async function ref(name, sha, kind = 'heads') {
		const file = path.join(metadata, 'refs', kind, ...name.split('/'));
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `${sha}\n`);
	}
	const main = await commit('main');
	const parent = await commit('parent work', [main]);
	const child = await commit('child work', [parent]);
	await ref('main', main);
	await ref('feature/parent', parent);
	await ref('feature/child', child);
	return { cwd, metadata, main, parent, child, commit, ref, object };
}

test('suggests the closest stacked target, preferring its local alias', async (t) => {
	const r = await repository(t);
	await r.ref('origin/feature/parent', r.parent, 'remotes');
	const suggestion = await git.suggestBaseBranch(r.cwd, 'feature/child');
	assert.equal(suggestion.branch, 'feature/parent');
	assert.match(suggestion.explanation, /Suggested target/);
});

test('does not mistake a lagging tracking upstream for the target', async (t) => {
	const r = await repository(t);
	const head = await r.commit('second child commit', [r.child]);
	await r.ref('feature/child', head);
	await r.ref('origin/published-child', r.child, 'remotes');
	await r.ref('other/feature/child', r.child, 'remotes');
	await fs.appendFile(path.join(r.metadata, 'config'),
		'[remote "origin"]\n\turl = .\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
		'[branch "feature/child"]\n\tremote = origin\n\tmerge = refs/heads/published-child\n');
	assert.equal((await git.suggestBaseBranch(r.cwd, 'feature/child')).branch, 'feature/parent');
	assert.equal((await git.suggestBaseBranch(r.cwd, head)).branch, 'feature/parent');
});

test('ambiguous ancestor labels fall back with an explicit explanation', async (t) => {
	const r = await repository(t);
	await r.ref('another-parent', r.parent);
	const suggestion = await git.suggestBaseBranch(r.cwd, 'feature/child');
	assert.equal(suggestion.branch, 'main');
	assert.match(suggestion.explanation, /multiple branches/);
});

test('follows first parents, not a merged side branch', async (t) => {
	const r = await repository(t);
	const side = await r.commit('side work', [r.main]);
	const merge = await r.commit('merge side', [r.child, side]);
	await r.ref('side', side);
	await r.ref('feature/child', merge);
	const page = await git.commitAncestry(r.cwd, merge);
	assert.deepEqual(page.commits.map((c) => c.sha), [merge, r.child, r.parent, r.main]);
	assert.deepEqual(page.commits[0].parents, [r.child, side]);
	assert.equal((await git.suggestBaseBranch(r.cwd, 'feature/child')).branch, 'feature/parent');
});

test('moved targets are not presented as a proven fork branch', async (t) => {
	const r = await repository(t);
	const advanced = await r.commit('parent advanced', [r.parent]);
	await r.ref('feature/parent', advanced);
	const suggestion = await git.suggestBaseBranch(r.cwd, 'feature/child');
	assert.equal(suggestion.branch, 'main');
	assert.equal(await git.mergeBase(r.cwd, 'feature/parent', 'feature/child'), r.parent);
});

test('a validated rebase point identifies the parent after live branch tips advance', async (t) => {
	const r = await repository(t);
	await r.ref('feature/parent', await r.commit('parent advanced', [r.parent]));
	await r.ref('main', await r.commit('main advanced', [r.main]));
	const directory = path.join(r.metadata, 'logs', 'refs', 'heads', 'feature');
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, 'child'),
		`${r.child} ${r.child} Test <test@example.invalid> 1700000000 +0000\t` +
		`rebase (finish): refs/heads/feature/child onto ${r.parent}\n`);
	const suggestion = await git.suggestBaseBranch(r.cwd, 'feature/child');
	assert.equal(suggestion.branch, 'feature/parent');
	const active = new ActiveComparison(r.cwd, r.cwd, memento());
	await active.computeDefaults();
	await active.resolve();
	assert.equal(active.base, 'feature/parent');
	assert.equal(active.baselineCommit, r.parent);
	assert.equal(active.baselineError, undefined);
	await active.setBase(r.parent);
	await active.useAutomaticBase();
	assert.equal(active.base, 'feature/parent');
	assert.equal(active.baselineCommit, r.parent);
});

test('paginates through the root without duplicates or skipped commits', async (t) => {
	const r = await repository(t);
	const expected = [r.child, r.parent, r.main];
	for (let i = 0; i < 101; i++) {
		expected.unshift(await r.commit(`commit ${i}`, [expected[0]]));
	}
	const actual = [];
	let start = expected[0];
	do {
		const page = await git.commitAncestry(r.cwd, start);
		assert.ok(page.commits.length <= 50);
		actual.push(...page.commits.map((c) => c.sha));
		start = page.next;
	} while (start);
	assert.deepEqual(actual, expected);
	const root = await git.commitAncestry(r.cwd, r.main);
	assert.deepEqual(root.commits[0].parents, []);
	assert.equal(root.next, undefined);
});

test('automatic discovery is bounded and ignores symbolic remote HEAD', async (t) => {
	const r = await repository(t);
	let head = r.parent;
	for (let i = 0; i < 200; i++) {
		head = await r.commit(`long branch ${i}`, [head]);
	}
	await r.ref('feature/child', head);
	await r.ref('origin/main', r.main, 'remotes');
	await r.ref('origin/HEAD', 'ref: refs/remotes/origin/main', 'remotes');
	assert.ok(!(await git.listBranchesCli(r.cwd)).some((b) => b.name === 'origin/HEAD'));
	const suggestion = await git.suggestBaseBranch(r.cwd, 'feature/child');
	assert.equal(suggestion.branch, 'main');
	assert.match(suggestion.explanation, /first 200/);
});

test('supports detached source snapshots and rejects invalid revisions explicitly', async (t) => {
	const r = await repository(t);
	assert.equal((await git.suggestBaseBranch(r.cwd, r.child)).branch, 'feature/parent');
	assert.equal(await git.resolveCommit(r.cwd, '--all'), undefined);
	await assert.rejects(git.commitAncestry(r.cwd, '--all'), /resolved commit SHA/);
	await assert.rejects(git.commitAncestry(r.cwd, '0'.repeat(40)));
});

test('defaults follow source switches but explicit commit bases remain pinned', async (t) => {
	const r = await repository(t);
	const active = new ActiveComparison(r.cwd, r.cwd, memento());
	await active.computeDefaults();
	await active.resolve();
	assert.equal(active.base, 'feature/parent');
	assert.equal(active.mergeBaseCommit, r.parent);
	await active.setCompare('feature/parent');
	assert.equal(active.base, 'main');
	await active.setBase(r.parent);
	await active.setCompare('feature/child');
	assert.equal(active.base, r.parent);
	assert.equal(active.baseCommit, r.parent);
	assert.equal(active.baseExplanation, undefined);
	assert.equal(active.review.targetBranch, r.parent);
	assert.equal(active.review.targetCommit, r.parent);
	assert.deepEqual((await active.getCommits()).commits.map((commit) => commit.sha), [r.child]);
	assert.ok(active.sourceFile.includes(`feature-child_${r.parent}`));
	await assert.rejects(active.setBase('missing-branch'), /Cannot resolve base/);
	assert.equal(active.base, r.parent);
	await assert.rejects(fs.access(path.join(r.cwd, '.vscode')));
});

test('explicit branch bases, swaps, and disabled defaults preserve existing choices', async (t) => {
	const r = await repository(t);
	const active = new ActiveComparison(r.cwd, r.cwd, memento());
	await active.resolve();
	assert.equal(active.base, undefined);
	await active.setBase('main');
	await active.setCompare('feature/parent');
	assert.equal(active.base, 'main');
	await active.swap();
	assert.equal(active.base, 'feature/parent');
	assert.equal(active.compare, 'main');
	await active.setCompare('feature/child');
	assert.equal(active.base, 'feature/parent');
});

test('automatic source tracking re-suggests the target after a checkout', async (t) => {
	const r = await repository(t);
	const active = new ActiveComparison(r.cwd, r.cwd, memento());
	await active.computeDefaults();
	await active.resolve();
	await fs.writeFile(path.join(r.metadata, 'HEAD'), 'ref: refs/heads/feature/parent\n');
	await active.resolve();
	assert.equal(active.compare, 'feature/parent');
	assert.equal(active.base, 'main');
});

test('provider transports history, pinned selections, and explicit stale-source errors', async (t) => {
	const r = await repository(t);
	const active = new ActiveComparison(r.cwd, r.cwd, memento());
	await active.computeDefaults();
	await active.resolve();
	const messages = [];
	let receive;
	const provider = new ComparisonWebviewProvider(() => active,
		(base) => active.setBase(base), (compare) => active.setCompare(compare), () => {}, () => {});
	provider.resolveWebviewView({
		onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
		webview: {
		postMessage: (message) => { messages.push(message); return Promise.resolve(true); },
		onDidReceiveMessage: (handler) => { receive = handler; },
	} });
	await receive({ type: 'ready' });
	assert.equal(messages.at(-1).base, 'feature/parent');
	assert.ok(messages.at(-1).branches.some((b) => b.name === 'feature/parent' && b.commit === r.parent));
	await receive({ type: 'loadCommits', mode: 'history', sourceSha: r.child, startSha: r.child, requestId: 1 });
	assert.deepEqual(messages.at(-1).commits.map((c) => c.sha), [r.child, r.parent, r.main]);
	await provider.setCommitAsBase({ sha: r.parent, webviewSection: 'commit' });
	t.mock.method(vscode.commands, 'executeCommand', async (command) => {
		assert.equal(command, 'searchlight.unpinBase');
		await active.useAutomaticBase();
	});
	await receive({ type: 'unpinBase' });
	assert.equal(active.base, 'feature/parent');
	assert.equal(messages.at(-1).type, 'unpinComplete');
	await provider.setCommitAsBase({ sha: r.parent, webviewSection: 'commit' });
	assert.equal(active.base, r.parent);
	await receive({ type: 'loadCommits', mode: 'review', sourceSha: r.child, baseSha: r.parent, requestId: 2 });
	assert.deepEqual(messages.at(-1).commits.map((c) => c.sha), [r.child]);
	await active.setBase('main');
	await active.setBaselinePin(r.parent);
	await receive({ type: 'ready' });
	assert.equal(messages.at(-1).baseCommit, r.parent);
	assert.equal(messages.at(-1).targetCommit, r.main);
	await receive({ type: 'loadCommits', mode: 'review', sourceSha: r.child, baseSha: r.parent, requestId: 3 });
	assert.deepEqual(messages.at(-1).commits.map((c) => c.sha), [r.child]);
	await provider.setCommitAsBase({ sha: r.parent, webviewSection: 'commit' });
	await assert.rejects(provider.setCommitAsBase({ sha: 'missing' }), /full commit SHA/);
	t.mock.method(console, 'error', () => {});
	await receive({ type: 'loadCommits', mode: 'history', sourceSha: r.main, startSha: r.main, requestId: 3 });
	assert.match(messages.at(-1).error, /comparison changed/);
	await receive({ type: 'selectBase', branch: 'missing' });
	assert.equal(messages.at(-1).type, 'selectionError');
	assert.match(messages.at(-1).message, /Cannot resolve base/);
	assert.equal(active.base, r.parent);
});

test('commit file expansion handles roots and surfaces invalid commits', async (t) => {
	const r = await repository(t);
	const blob = await r.object('blob', 'first file\n');
	const tree = await r.object('tree', Buffer.concat([
		Buffer.from('100644 fixture.txt\0'), Buffer.from(blob, 'hex'),
	]));
	const root = await r.commit('root with file', [], tree);
	assert.deepEqual(await git.changedFilesForCommit(r.cwd, root), ['fixture.txt']);
	const side = await r.commit('side with file', [r.main], tree);
	const merge = await r.commit('merge side into child', [r.child, side], tree);
	assert.deepEqual(await git.changedFilesForCommit(r.cwd, merge), ['fixture.txt']);
	await assert.rejects(git.changedFilesForCommit(r.cwd, '0'.repeat(40)));
	await assert.rejects(git.changedFilesForCommit(r.cwd, '--all'), /resolved commit SHA/);
});

// Minimal DOM boundary for executing the actual shipped webview script without extra dependencies.
class Element {
	constructor(tagName = 'div') {
		this.tagName = tagName;
		this.children = [];
		this.listeners = {};
		this.attributes = new Map();
		this.value = '';
		this.textContent = '';
		this.open = false;
		this.classList = { add() {}, remove() {}, toggle() {} };
	}
	addEventListener(type, handler) { this.listeners[type] = handler; }
	appendChild(child) {
		this.children.push(...(child.tagName === '#fragment' ? child.children : [child]));
	}
	append(...children) { children.forEach((child) => this.appendChild(child)); }
	insertBefore(child, reference) {
		const index = this.children.indexOf(reference);
		assert.ok(index >= 0);
		this.children.splice(index, 0, child);
	}
	replaceChildren(...children) { this.children = children; }
	setAttribute(name, value) { this.attributes.set(name, value); }
	getAttribute(name) { return this.attributes.get(name) ?? null; }
	focus() { Element.activeElement = this; }
	set innerHTML(html) {
		this.children = [...html.matchAll(/<span class="([^"]+)">/g)].map((match) => {
			const span = new Element('span');
			span.className = match[1];
			return span;
		});
	}
	querySelectorAll(selector) {
		const [base, focused] = selector.split(':');
		const matches = (element) => (base.startsWith('.')
			? (element.className || '').split(' ').includes(base.slice(1)) : element.tagName === base) &&
			(!focused || Element.activeElement === element);
		return this.children.flatMap((child) => [
			...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
		]);
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function webview() {
	Element.activeElement = null;
	const elements = new Map();
	const get = (key) => {
		if (!elements.has(key)) { elements.set(key, new Element()); }
		return elements.get(key);
	};
	const messages = [];
	const listeners = {};
	const provider = new ComparisonWebviewProvider(() => undefined, () => {}, () => {}, () => {}, () => {});
	const html = provider.html();
	const context = {
		document: {
			querySelector: get, getElementById: get, createElement: (tag) => new Element(tag),
			createDocumentFragment: () => new Element('#fragment'),
			get activeElement() { return Element.activeElement; },
		},
		window: { addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); } },
		acquireVsCodeApi: () => ({ postMessage: (msg) => messages.push(msg) }),
		performance,
		requestAnimationFrame: (callback) => callback(),
		setTimeout,
	};
	vm.createContext(context);
	for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
		vm.runInContext(match[1], context);
	}
	const state = (value) => listeners.message.forEach((handler) => handler({ data: value }));
	return { get, messages, state, html };
}

test('compact history carries immutable native-menu context and loads older pages', () => {
	const ui = webview();
	const sha = 'a'.repeat(40);
	const parent = 'b'.repeat(40);
	const older = 'c'.repeat(40);
	ui.state({ type: 'state', branches: [{ name: 'feature/parent', commit: parent }],
		base: 'main', compare: 'child', compareCommit: sha, mergeBaseCommit: parent, ready: true });
	ui.get('commit-toggle').listeners.click();
	const request = ui.messages.at(-1);
	assert.equal(request.type, 'loadCommits');
	assert.equal(request.mode, 'history');
	assert.equal(request.startSha, sha);
	ui.state({ ...request, type: 'commitPage',
		commits: [{ sha: parent, shortSha: 'bbbbbbb', subject: '<not HTML>', author: 'Test',
			relDate: 'now', parents: [older] }], next: older });
	const row = ui.get('commit-rows').children[0].children[0];
	assert.equal(row.className, 'commit-row');
	const nativeContext = JSON.parse(row.getAttribute('data-vscode-context'));
	assert.equal(nativeContext.sha, parent);
	assert.equal(nativeContext.webviewSection, 'commit');
	assert.equal(row.querySelector('.commit-label').textContent, '<not HTML>');
	assert.equal(row.querySelectorAll('button').length, 0);
	ui.get('commit-more').listeners.click();
	assert.equal(ui.messages.at(-1).startSha, older);
	assert.equal(ui.get('commit-more').disabled, true);
});

test('compact comparison badges precede both SHA and subject text', () => {
	const ui = webview();
	const source = 'a'.repeat(40), base = 'b'.repeat(40), common = 'c'.repeat(40);
	ui.state({ type: 'state', branches: [], compareCommit: source,
		baseCommit: base, mergeBaseCommit: common });
	ui.get('commit-toggle').listeners.click();
	const request = ui.messages.at(-1);
	ui.state({ ...request, type: 'commitPage', commits: [source, base, common].map((sha) => ({
		sha, shortSha: sha.slice(0, 7), subject: 'Long subject that may be truncated',
		author: 'Test', relDate: 'now',
	})) });
	for (const [index, label] of ['SOURCE', 'BASE', 'COMMON'].entries()) {
		const row = ui.get('commit-rows').children[index].children[0];
		const badge = row.querySelector('.commit-badge');
		assert.equal(badge.textContent, label);
		assert.ok(badge.className.includes('commit-role'));
		assert.ok(row.children.indexOf(badge) < row.children.indexOf(row.querySelector('.commit-sha')));
		assert.ok(row.children.indexOf(badge) < row.children.indexOf(row.querySelector('.commit-label')));
	}
});

test('comparison role outlines match icon color and remain the original badge height', () => {
	const ui = webview();
	const role = ui.html.match(/\.commit-role\s*\{([^}]+)\}/)[1];
	assert.match(role, /border-width:\s*1px/);
	assert.match(role, /border-color:\s*var\(--vscode-icon-foreground,\s*var\(--vscode-foreground\)\)/);
	assert.match(role, /line-height:\s*16px/);
	const generic = ui.html.match(/\.commit-badge\s*\{([^}]+)\}/)[1];
	assert.match(generic, /border:\s*1px solid var\(--vscode-panel-border\)/);
	const roleWidth = Number(role.match(/border-width:\s*(\d+)px/)[1]);
	const roleHeight = Number(role.match(/line-height:\s*(\d+)px/)[1]);
	const genericWidth = Number(generic.match(/border:\s*(\d+)px/)[1]);
	const genericHeight = Number(generic.match(/line-height:\s*(\d+)px/)[1]);
	assert.equal(roleHeight + 2 * roleWidth, genericHeight + 2 * genericWidth);
});

test('history ignores stale replies and displays retryable errors', () => {
	const ui = webview();
	const first = 'a'.repeat(40);
	const second = 'b'.repeat(40);
	ui.state({ type: 'state', branches: [], compareCommit: first });
	ui.get('commit-toggle').listeners.click();
	const oldRequest = ui.messages.at(-1);
	ui.state({ type: 'state', branches: [], compareCommit: second });
	const newRequest = ui.messages.at(-1);
	ui.state({ ...oldRequest, type: 'commitPage', error: 'old error' });
	assert.equal(ui.get('commit-status').textContent, 'Loading commits…');
	ui.state({ ...newRequest, type: 'commitPage', error: 'Git read failed' });
	assert.equal(ui.get('commit-status').textContent, 'Git read failed');
	assert.equal(ui.get('commit-more').textContent, '↻ Retry');
	ui.get('commit-more').listeners.click();
	assert.equal(ui.messages.at(-1).startSha, second);
});

test('pinned commits and common ancestors are explained, not claimed as original forks', () => {
	const ui = webview();
	const sha = 'b'.repeat(40);
	ui.state({ type: 'state', branches: [], base: sha, baseCommit: sha,
		compare: 'child', compareCommit: 'a'.repeat(40), mergeBaseCommit: sha, ready: true });
	assert.equal(ui.get('base-explanation').textContent, '');
	assert.equal(ui.get('unpin-base').hidden, false);
	assert.match(ui.get('base-explanation').title, /does not follow a branch/);
	ui.state({ type: 'selectionError', message: 'Cannot resolve base' });
	assert.match(ui.get('status').textContent, /Cannot resolve base/);
	assert.ok(!ui.html.includes('Browse ancestry'));
	assert.ok(!ui.html.includes('Use commit'));
});

test('Unpin is conditional, prevents duplicate clicks, and hides after returning to automatic Base', () => {
	const ui = webview();
	const source = 'a'.repeat(40), base = 'b'.repeat(40);
	ui.state({ type: 'state', branches: [], base, compareCommit: source });
	assert.equal(ui.get('unpin-base').hidden, false);
	ui.get('unpin-base').listeners.click();
	ui.get('unpin-base').listeners.click();
	assert.equal(ui.messages.filter((message) => message.type === 'unpinBase').length, 1);
	assert.equal(ui.get('unpin-base').disabled, true);
	ui.state({ type: 'state', branches: [], base: 'feature/parent', compareCommit: source,
		baseExplanation: 'Suggested target: automatic parent.' });
	assert.equal(ui.get('unpin-base').hidden, true);
	ui.state({ type: 'unpinComplete' });
	assert.equal(ui.get('unpin-base').disabled, false);
	assert.equal(ui.get('base-explanation').textContent, 'Suggested target');
});

test('Unpin errors retain the action for retry and display failure explicitly', () => {
	const ui = webview();
	ui.state({ type: 'state', branches: [], base: 'b'.repeat(40), compareCommit: 'a'.repeat(40) });
	ui.get('unpin-base').listeners.click();
	ui.state({ type: 'selectionError', message: 'Cannot detect automatic Base.' });
	assert.equal(ui.get('unpin-base').disabled, false);
	assert.equal(ui.get('unpin-base').hidden, false);
	assert.match(ui.get('status').textContent, /Cannot detect automatic Base/);
});
test('Review preserves the old commit range and changing base reloads only that mode', () => {
	const ui = webview();
	const source = 'a'.repeat(40), base = 'b'.repeat(40), newBase = 'c'.repeat(40);
	const state = { type: 'state', branches: [], baseCommit: base, compareCommit: source };
	ui.state(state);
	ui.get('commit-toggle').listeners.click();
	const history = ui.messages.at(-1);
	ui.state({ ...history, type: 'commitPage', commits: [], next: null });
	const before = ui.messages.length;
	ui.state({ ...state, baseCommit: newBase });
	assert.equal(ui.messages.length, before);
	ui.get('commit-review').listeners.click();
	const review = ui.messages.at(-1);
	assert.equal(review.mode, 'review');
	assert.equal(review.baseSha, newBase);
	ui.state({ ...review, type: 'commitPage', commits: [], truncated: false });
	ui.state({ ...state, baseCommit: base });
	assert.equal(ui.messages.at(-1).baseSha, base);
	assert.equal(ui.get('commit-review').getAttribute('aria-pressed'), 'true');
});

test('Review invalidates on a baseline pin change even when the target tip stays unchanged', () => {
	const ui = webview();
	const source = 'a'.repeat(40), target = 'b'.repeat(40), first = 'c'.repeat(40), second = 'd'.repeat(40);
	const state = { type: 'state', branches: [], compareCommit: source,
		baseCommit: first, targetCommit: target, baselineCommit: first };
	ui.state(state);
	ui.get('commit-toggle').listeners.click();
	ui.get('commit-review').listeners.click();
	const old = ui.messages.at(-1);
	ui.state({ ...state, baseCommit: second, baselineCommit: second, baselinePin: second });
	assert.equal(ui.messages.at(-1).baseSha, second);
	ui.state({ ...old, type: 'commitPage', commits: [] });
	assert.equal(ui.get('commit-status').textContent, 'Loading commits…');
});

test('baseline errors block Review while History remains available to select a valid base', () => {
	const ui = webview();
	const source = 'a'.repeat(40), base = 'b'.repeat(40);
	ui.state({ type: 'state', branches: [], compareCommit: source, baseCommit: base });
	ui.get('commit-toggle').listeners.click();
	ui.get('commit-review').listeners.click();
	const count = ui.messages.filter((message) => message.type === 'loadCommits').length;
	ui.state({ type: 'state', branches: [], compareCommit: source, baseCommit: null, baselineError: 'Invalid ancestor pin.' });
	assert.equal(ui.get('commit-status').textContent, 'Invalid ancestor pin.');
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, count);
	ui.get('commit-history').listeners.click();
	assert.equal(ui.messages.at(-1).mode, 'history');
});
test('compact commit expansion preserves file diffs, focus and collapse-all', () => {
	const ui = webview();
	const sha = 'a'.repeat(40);
	ui.state({ type: 'state', branches: [], compareCommit: sha });
	ui.get('commit-toggle').listeners.click();
	const request = ui.messages.at(-1);
	ui.state({ ...request, type: 'commitPage', commits: [
		{ sha, shortSha: 'aaaaaaa', subject: 'Change', author: 'Test', relDate: 'now' },
	] });
	let row = ui.get('commit-rows').children[0].children[0];
	row.focus();
	row.listeners.click();
	assert.equal(ui.messages.at(-1).type, 'expand');
	assert.equal(Element.activeElement.getAttribute('data-vscode-context'), row.getAttribute('data-vscode-context'));
	ui.state({ type: 'files', sha, files: ['src/file.ts'] });
	const file = ui.get('commit-rows').querySelector('.commit-file');
	file.listeners.click({ stopPropagation() {} });
	assert.equal(ui.messages.at(-1).type, 'openCommitFile');
	assert.equal(ui.messages.at(-1).relPath, 'src/file.ts');
	assert.equal(JSON.parse(file.getAttribute('data-vscode-context')).webviewSection, 'commitFile');
	ui.state({ type: 'setExpanded', value: false });
	assert.match(ui.get('commit-rows').children[0].className, /collapsed/);
});

test('manifest folds Commits into Comparison and scopes Set as Base to commit rows', () => {
	const manifest = require('../package.json');
	assert.deepEqual(manifest.contributes.views.searchlight.map((view) => view.id),
		['searchlight.comparison', 'searchlight.files', 'searchlight.conversations']);
	const menu = manifest.contributes.menus['webview/context'].find((item) => item.command === 'searchlight.setCommitAsBase');
	assert.equal(menu.when, 'webviewId == searchlight.comparison && webviewSection == commit');
	assert.equal(manifest.contributes.commands.find((command) => command.command === menu.command).title, 'Set as Base');
});

test('lazy commits start collapsed with no page requests or rendered rows', () => {
	const ui = webview();
	assert.match(ui.html, /id="commit-toggle"[^>]*aria-expanded="false"/);
	assert.match(ui.html, /id="commit-content" hidden/);
	ui.state({ type: 'state', branches: [], compareCommit: 'a'.repeat(40) });
	ui.state({ type: 'state', branches: [], compareCommit: 'b'.repeat(40) });
	assert.equal(ui.get('commit-toggle').getAttribute('aria-expanded'), 'false');
	assert.equal(ui.get('commit-content').hidden, true);
	assert.equal(ui.get('commit-rows').children.length, 0);
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 0);
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.messages.at(-1).sourceSha, 'b'.repeat(40));
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
	assert.equal(ui.get('commit-toggle').getAttribute('aria-expanded'), 'true');
	assert.equal(ui.get('commit-content').hidden, false);
});

test('lazy commits reuse loaded rows without requests or rendering while collapsed', () => {
	const ui = webview();
	const source = 'a'.repeat(40);
	const state = { type: 'state', branches: [], compareCommit: source };
	ui.state(state);
	ui.get('commit-toggle').listeners.click();
	const request = ui.messages.at(-1);
	ui.state({ ...request, type: 'commitPage', commits: [
		{ sha: source, shortSha: 'aaaaaaa', subject: 'Change', author: 'Test', relDate: 'now' },
	] });
	const rendered = ui.get('commit-rows').children[0];
	ui.get('commit-toggle').listeners.click();
	ui.state(state);
	assert.equal(ui.get('commit-rows').children[0], rendered);
	assert.equal(ui.get('commit-content').hidden, true);
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.get('commit-rows').children.length, 1);
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
});

test('lazy commits cache in-flight results without painting a collapsed section', () => {
	const ui = webview();
	const source = 'a'.repeat(40);
	ui.state({ type: 'state', branches: [], compareCommit: source });
	ui.get('commit-toggle').listeners.click();
	const request = ui.messages.at(-1);
	ui.get('commit-toggle').listeners.click();
	ui.state({ ...request, type: 'commitPage', commits: [
		{ sha: source, shortSha: 'aaaaaaa', subject: 'Change', author: 'Test', relDate: 'now' },
	] });
	assert.equal(ui.get('commit-rows').children.length, 0);
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.get('commit-rows').children.length, 1);
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
});

test('lazy commits cache empty results and do not duplicate pending requests on reopen', () => {
	const ui = webview();
	ui.state({ type: 'state', branches: [], compareCommit: 'a'.repeat(40) });
	ui.get('commit-toggle').listeners.click();
	const request = ui.messages.at(-1);
	ui.get('commit-toggle').listeners.click();
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
	ui.state({ ...request, type: 'commitPage', commits: [] });
	ui.get('commit-toggle').listeners.click();
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
	assert.equal(ui.get('commit-status').textContent, 'No commits in range.');
});

test('lazy commits invalidate a changed source while closed and load only on expansion', () => {
	const ui = webview();
	ui.state({ type: 'state', branches: [], compareCommit: 'a'.repeat(40) });
	ui.get('commit-toggle').listeners.click();
	const old = ui.messages.at(-1);
	ui.get('commit-toggle').listeners.click();
	ui.state({ type: 'state', branches: [], compareCommit: 'b'.repeat(40) });
	ui.state({ ...old, type: 'commitPage', commits: [
		{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Old', author: 'Test', relDate: 'now' },
	] });
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.messages.at(-1).sourceSha, 'b'.repeat(40));
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 2);
	assert.equal(ui.get('commit-rows').children.length, 0);
});

test('lazy commits defer a changed Review base until expansion', () => {
	const ui = webview();
	const source = 'a'.repeat(40), base = 'b'.repeat(40), newBase = 'c'.repeat(40);
	ui.state({ type: 'state', branches: [], compareCommit: source, baseCommit: base });
	ui.get('commit-toggle').listeners.click();
	ui.get('commit-review').listeners.click();
	const request = ui.messages.at(-1);
	ui.state({ ...request, type: 'commitPage', commits: [] });
	ui.get('commit-toggle').listeners.click();
	const count = ui.messages.filter((message) => message.type === 'loadCommits').length;
	ui.state({ type: 'state', branches: [], compareCommit: source, baseCommit: newBase });
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, count);
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.messages.at(-1).mode, 'review');
	assert.equal(ui.messages.at(-1).baseSha, newBase);
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, count + 1);
});

test('lazy commits opened before source resolution wait for the first valid state', () => {
	const ui = webview();
	ui.get('commit-toggle').listeners.click();
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 0);
	assert.equal(ui.get('commit-status').textContent, 'Select a source branch.');
	ui.state({ type: 'state', branches: [], compareCommit: 'a'.repeat(40) });
	assert.equal(ui.messages.filter((message) => message.type === 'loadCommits').length, 1);
	assert.equal(ui.get('commit-status').textContent, 'Loading commits…');
});
