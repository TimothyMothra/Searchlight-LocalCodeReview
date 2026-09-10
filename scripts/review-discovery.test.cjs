const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const diagnostics = require('../out/diagnostics');

function fixture(names = ['workspace']) {
	const folders = names.map((name) => path.resolve(name));
	const roots = folders.map((folder) => path.join(folder, '.vscode', 'searchlight-reviews'));
	const directories = new Map(), files = new Map(), reads = [];
	const uri = (fsPath) => ({ fsPath, toString: () => fsPath });
	let readDirectory = async (value) => {
		const result = directories.get(value.fsPath);
		if (result instanceof Error) { throw result; }
		if (!result) { throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); }
		return result;
	};
	const vscode = {
		FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
		Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
		workspace: {
			workspaceFolders: folders.map((folder) => ({ uri: uri(folder) })),
			findFiles: async () => assert.fail('Workspace-wide search must not be used'),
			fs: {
				readDirectory: async (value) => { reads.push(value.fsPath); return readDirectory(value); },
				readFile: async (value) => {
					assert.ok(files.has(value.fsPath), `Unexpected review read: ${value.fsPath}`);
					return Buffer.from(files.get(value.fsPath));
				},
			},
		},
	};
	const filename = path.resolve(__dirname, '..', 'out', 'reviewStore.js');
	const module = { exports: {} };
	const nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => id === 'vscode' ? vscode : nativeRequire(id), module, filename, path.dirname(filename),
	);
	return { roots, directories, files, reads, store: module.exports, setReader(fn) { readDirectory = fn; } };
}

test('discovery reads only review subtrees, preserves nested/multi-root reviews, and sorts the results', async () => {
	const f = fixture(['workspace-b', 'workspace-a']);
	for (const root of f.roots) {
		f.directories.set(root, [['nested', 2], ['notes.txt', 1], ['comments.json', 1]]);
		f.directories.set(path.join(root, 'nested'), [['feature', 2]]);
		f.directories.set(path.join(root, 'nested', 'feature'), [['comments.json', 1], ['other.json', 1]]);
		f.files.set(path.join(root, 'comments.json'), '{"threads":[]}');
		f.files.set(path.join(root, 'nested', 'feature', 'comments.json'), '{"threads":[]}');
	}
	const reviews = await f.store.scanReviews();
	assert.equal(reviews.length, 4);
	const paths = reviews.map((review) => review.sourceFile);
	assert.deepEqual(paths, [...f.files.keys()].sort((a, b) => a.localeCompare(b)));
	assert.equal(f.reads.length, 6);
	assert.ok(f.reads.every((directory) => f.roots.some((root) => directory === root || directory.startsWith(root + path.sep))));
});

test('missing stores are empty, but permission failures are propagated rather than hidden', async () => {
	const f = fixture();
	assert.deepEqual(await f.store.scanReviews(), []);
	assert.deepEqual(f.reads, f.roots);
	const failure = Object.assign(new Error('access denied'), { code: 'NoPermissions' });
	f.directories.set(f.roots[0], failure);
	await assert.rejects(f.store.scanReviews(), (error) => error === failure);
});

test('concurrent readers share discovery, get independent review models, and see new folders on later scans', async () => {
	const f = fixture();
	const root = f.roots[0];
	const review = path.join(root, 'comments.json');
	f.files.set(review, '{"threads":[]}');
	let release;
	let rootReads = 0;
	f.setReader(async () => {
		rootReads++;
		return new Promise((resolve) => { release = resolve; });
	});
	const first = f.store.scanReviews();
	const second = f.store.scanReviews();
	assert.equal(rootReads, 1);
	release([['comments.json', 1]]);
	const [left, right] = await Promise.all([first, second]);
	assert.deepEqual(left, right);
	assert.notEqual(left[0], right[0]);
	f.setReader(async (uri) => uri.fsPath === root ? [['comments.json', 1], ['new', 2]] : [['comments.json', 1]]);
	f.files.set(path.join(root, 'new', 'comments.json'), '{"threads":[]}');
	assert.equal((await f.store.scanReviews()).length, 2);
	assert.equal(f.reads.filter((directory) => directory === root).length, 2);
});

test('directory links cannot escape the store or create cycles, and skipped links are reported', async () => {
	const lines = [];
	diagnostics.startDiagnostics(diagnostics.now(), true, (line) => lines.push(line), {});
	const f = fixture();
	const root = f.roots[0];
	f.directories.set(root, [['cycle', 66], ['normal', 2]]);
	f.directories.set(path.join(root, 'normal'), [['comments.json', 65]]);
	f.files.set(path.join(root, 'normal', 'comments.json'), '{"threads":[]}');
	assert.equal((await f.store.scanReviews()).length, 1);
	assert.ok(!f.reads.some((directory) => directory.endsWith('cycle')));
	assert.ok(lines.some((line) => line.includes('"skippedLinks":1')));
});
