const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { resolveBaseline, resolveBaselinePin } = require('../out/baseline');

const sha = (n) => n.toString(16).padStart(40, '0');
const A = sha(1), B = sha(2), C = sha(3), D = sha(4), E = sha(5);
const repo = path.resolve(__dirname, '..');

// ASSUMPTION: topology, not timestamps, determines a baseline. Model git's read-only queries
// so regression tests never create refs, touch the index, or require a second checkout.
function history(refs = [
	['refs/heads/main', A, 'refs/remotes/origin/main'],
	['refs/remotes/origin/main', C, ''],
], parents = { [A]: [], [B]: [A], [C]: [B], [D]: [C], [E]: [B] }) {
	const calls = [];
	function ancestors(commit, result = new Set()) {
		assert.ok(Object.hasOwn(parents, commit), `Unknown commit ${commit}`);
		if (!result.has(commit)) {
			result.add(commit);
			for (const parent of parents[commit]) { ancestors(parent, result); }
		}
		return result;
	}
	const exit = (code, message) => { throw Object.assign(new Error(message), { code }); };
	const query = async (args) => {
		calls.push(args);
		if (args[0] === 'for-each-ref') { return refs.map((ref) => ref.join('\t')).join('\n'); }
		if (args[0] === 'rev-parse') {
			const prefix = args.at(-1).replace(/\^\{commit\}$/, '');
			const matches = Object.keys(parents).filter((id) => id.startsWith(prefix));
			if (matches.length !== 1) { return exit(128, 'Unknown or ambiguous commit'); }
			return matches[0];
		}
		assert.equal(args[0], 'merge-base');
		const left = ancestors(args[2]), right = ancestors(args[3]);
		if (args[1] === '--is-ancestor') {
			return right.has(args[2]) ? '' : exit(1, 'Not an ancestor');
		}
		assert.equal(args[1], '--all');
		const common = [...left].filter((id) => right.has(id));
		const best = common.filter((id) => !common.some((other) => other !== id && ancestors(other).has(id)));
		return best.length ? best.join('\n') : exit(1, 'No common ancestor');
	};
	return { refs, parents, query, calls };
}

test('stale local main after rebase uses the newer remote shared ancestor', async () => {
	const h = history();
	const result = await resolveBaseline(repo, 'main', D, undefined, h.query);
	assert.equal(result.commit, C);
	assert.equal(result.targetCommit, A);
	assert.match(result.reason, /shared ancestor with origin\/main/);
	assert.ok(h.calls.filter((args) => args[0] === 'merge-base').every((args) =>
		/^[0-9a-f]{40}$/.test(args[2]) && /^[0-9a-f]{40}$/.test(args[3])));
});

test('advancing main does not advance the baseline beyond the divergence', async () => {
	const h = history();
	h.refs[0][1] = C;
	assert.equal((await resolveBaseline(repo, 'main', E, undefined, h.query)).commit, B);
});

test('newer local ancestry wins over stale remote ancestry', async () => {
	const h = history();
	h.refs[0][1] = C;
	h.refs[1][1] = A;
	const result = await resolveBaseline(repo, 'main', D, undefined, h.query);
	assert.equal(result.commit, C);
	assert.match(result.reason, /shared ancestor with main;/);
});

test('equal shared ancestors keep the selected target', async () => {
	const h = history();
	h.refs[0][1] = C;
	assert.match((await resolveBaseline(repo, 'main', D, undefined, h.query)).reason, /shared ancestor with main;/);
});

test('an explicit remote selection does not consult the local branch', async () => {
	const h = history();
	h.refs[0][1] = C;
	h.refs[1][1] = A;
	assert.equal((await resolveBaseline(repo, 'origin/main', D, undefined, h.query)).commit, A);
});

test('configured upstream works for slashed/stacked targets and non-origin remotes', async () => {
	const h = history([
		['refs/heads/feature/parent', A, 'refs/remotes/upstream/integration'],
		['refs/remotes/upstream/integration', C, ''],
		['refs/remotes/origin/feature/parent', D, ''],
	]);
	assert.equal((await resolveBaseline(repo, 'feature/parent', D, undefined, h.query)).commit, C);
});

test('unconfigured targets consider matching origin refs, but never unrelated branches', async () => {
	const h = history();
	h.refs[0][2] = '';
	assert.equal((await resolveBaseline(repo, 'main', D, undefined, h.query)).commit, C);
	h.refs.splice(1, 1, ['refs/remotes/origin/unrelated', D, '']);
	assert.equal((await resolveBaseline(repo, 'main', D, undefined, h.query)).commit, A);
});

test('missing configured upstream and missing target are explicit errors', async () => {
	const h = history();
	h.refs.pop();
	await assert.rejects(resolveBaseline(repo, 'main', D, undefined, h.query), /upstream.*unavailable/);
	await assert.rejects(resolveBaseline(repo, 'missing', D, undefined, h.query), /Target branch.*unavailable/);
});

test('pins use exact ancestor commits and reject non-IDs, unknown or rewritten commits', async () => {
	const h = history();
	assert.equal((await resolveBaseline(repo, 'main', D, A, h.query)).commit, A);
	for (const bad of ['main', 'HEAD~1', '--help', 'xyz']) {
		await assert.rejects(resolveBaselinePin(repo, bad, D, h.query), /Enter a commit SHA/);
	}
	await assert.rejects(resolveBaselinePin(repo, sha(99), D, h.query), /Unknown/);
	await assert.rejects(resolveBaselinePin(repo, E, D, h.query), /no longer an ancestor/);
	h.parents[D] = [A];
	await assert.rejects(resolveBaseline(repo, 'main', D, C, h.query), /no longer an ancestor/);
});

test('unrelated histories and unexpected git failures are not empty comparisons', async () => {
	const h = history();
	h.parents[D] = [];
	await assert.rejects(resolveBaseline(repo, 'main', D, undefined, h.query), /No common ancestor/);
	await assert.rejects(resolveBaseline(repo, 'main', D, undefined, async () => {
		throw Object.assign(new Error('git failed'), { code: 128 });
	}), /git failed/);
});

test('incomparable candidate baselines require explicit selection', async () => {
	const h = history([
		['refs/heads/main', B, 'refs/remotes/origin/main'],
		['refs/remotes/origin/main', C, ''],
	], { [A]: [], [B]: [A], [C]: [A], [D]: [B, C] });
	await assert.rejects(resolveBaseline(repo, 'main', D, undefined, h.query), /incomparable/);
	assert.equal((await resolveBaseline(repo, 'origin/main', D, undefined, h.query)).commit, C);
});

test('multiple merge-bases require a pin instead of an arbitrary choice', async () => {
	const h = history([
		['refs/heads/main', E, ''],
	], { [A]: [], [B]: [A], [C]: [A], [D]: [B, C], [E]: [C, B] });
	await assert.rejects(resolveBaseline(repo, 'main', D, undefined, h.query), /Multiple merge-bases/);
	assert.equal((await resolveBaseline(repo, 'main', D, B, h.query)).commit, B);
});

function loadCompiled(name, mocks) {
	const filename = path.join(repo, 'out', `${name}.js`);
	const module = { exports: {} };
	const nativeRequire = createRequire(filename);
	const requireMock = (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, requireMock, module, filename, path.dirname(filename),
	);
	return module.exports;
}

function comparisonFixture() {
	const h = history();
	const values = new Map();
	const state = { get: (key) => values.get(key), update: async (key, value) => {
		if (value === undefined) { values.delete(key); } else { values.set(key, value); }
	} };
	const calls = [];
	const gitApi = { getHead: async () => ({ branch: 'feature', commit: D, detached: false }) };
	const git = {
		defaultBaseBranch: async () => 'main',
		resolveCommit: async (_, ref) => ref === 'feature' || ref === 'other' ? D : undefined,
		changedFiles: async (_, ...refs) => { calls.push(['files', ...refs]); return []; },
		changedFilesCumulative: async (_, ref) => { calls.push(['cumulative', ref]); return []; },
		logRange: async (_, ...refs) => { calls.push(['commits', ...refs]); return { commits: [], truncated: false }; },
	};
	const mocks = {
		vscode: { Uri: { file: (fsPath) => ({ fsPath }) } },
		'./gitApi': gitApi,
		'./git': git,
		'./baseline': {
			resolveBaseline: (...args) => resolveBaseline(...args, h.query),
			resolveBaselinePin: (...args) => resolveBaselinePin(...args, h.query),
		},
		'./reviewStore': {
			computeReviewPaths: (_, compare, base) => ({ reviewDir: `${compare}_${base}`, sourceFile: `${compare}_${base}/comments.json` }),
			loadReview: async () => undefined,
			emptyReview: (_, sourceBranch, targetBranch) => ({ sourceBranch, targetBranch, threads: [] }),
		},
		'./perf': { perfCount: () => {} },
	};
	const { ActiveComparison } = loadCompiled('activeComparison', mocks);
	const create = () => new ActiveComparison(repo, repo, state);
	return { h, state, calls, gitApi, create, active: create(), reviewStore: mocks['./reviewStore'] };
}

test('pins persist across reloads, invalidate caches, reset to Auto, and stay scoped to a comparison', async () => {
	const f = comparisonFixture();
	await f.active.computeDefaults();
	await f.active.resolve();
	assert.equal(f.active.baselineCommit, C);
	const originalKey = f.active.comparisonKey;
	await f.active.getChangedFiles();
	await f.active.setBaselinePin(A);
	assert.notEqual(f.active.comparisonKey, originalKey);
	await f.active.getChangedFiles();
	await f.active.getChangedFilesCumulative();
	await f.active.getCommits();
	assert.deepEqual(f.calls, [['files', C, D], ['files', A, D], ['cumulative', A], ['commits', A, D]]);
	const reloaded = f.create();
	await reloaded.computeDefaults();
	await reloaded.resolve();
	assert.equal(reloaded.baselineCommit, A);
	await reloaded.setCompare('other');
	assert.equal(reloaded.baselineCommit, C);
	await reloaded.setCompare('feature');
	assert.equal(reloaded.baselineCommit, A);
	await reloaded.setBaselinePin(undefined);
	assert.equal(reloaded.baselineCommit, C);
	assert.equal(reloaded.baselinePin, undefined);
});

test('invalidated pins block comparisons rather than silently falling back', async () => {
	const f = comparisonFixture();
	await f.active.computeDefaults();
	await f.active.resolve();
	await f.active.setBaselinePin(C);
	f.h.parents[D] = [A];
	await f.active.resolve();
	assert.equal(f.active.baselineCommit, undefined);
	assert.equal(f.active.baselinePin, C);
	assert.match(f.active.baselineError, /no longer an ancestor/);
	await f.active.getChangedFiles();
	await f.active.getCommits();
	assert.deepEqual(f.calls, []);
	await f.active.setBaselinePin(undefined);
	assert.equal(f.active.baselineCommit, A);
});

test('remembered target survives reload without changing review identity to the chosen upstream', async () => {
	const f = comparisonFixture();
	await f.active.computeDefaults();
	await f.active.resolve();
	assert.equal(f.active.review.targetBranch, 'main');
	assert.equal(f.active.baseCommit, A);
	await f.active.setBase('origin/main');
	const reloaded = f.create();
	await reloaded.computeDefaults();
	await reloaded.resolve();
	assert.equal(reloaded.base, 'origin/main');
});

test('a newer resolve cannot be overwritten by a delayed older HEAD query', async () => {
	const f = comparisonFixture();
	await f.active.computeDefaults();
	let release;
	f.gitApi.getHead = () => new Promise((resolve) => { release = resolve; });
	const stale = f.active.resolve();
	f.gitApi.getHead = async () => ({ branch: 'feature', commit: D, detached: false });
	await f.active.resolve();
	release({ branch: 'old', commit: A, detached: false });
	await stale;
	assert.equal(f.active.compare, 'feature');
	assert.equal(f.active.baselineCommit, C);
});

test('single-file, cumulative and all-changes diffs use the same baseline, never the target tip', async () => {
	const commands = [];
	const vscode = {
		Uri: { from: (uri) => uri, file: (fsPath) => ({ fsPath, scheme: 'file' }) },
		window: { showWarningMessage: (text) => assert.fail(text), showInformationMessage: (text) => assert.fail(text) },
		workspace: { getConfiguration: () => ({ get: () => true }) },
		commands: { executeCommand: async (...args) => { commands.push(args); } },
	};
	const diff = loadCompiled('reviewDiff', {
		vscode, './git': { changedFilesUncommitted: async () => ({ untracked: [{ relPath: 'new.txt' }] }) },
	});
	const active = {
		repoRootFsPath: repo, base: 'main', baseCommit: E, compare: 'feature',
		baselineCommit: B, compareCommit: D, headCommit: D, headBranch: 'feature',
		compareIsHead: true, comparisonKey: 'key',
		getChangedFiles: async () => [{ relPath: 'changed.txt' }],
		getChangedFilesCumulative: async () => [{ relPath: 'changed.txt' }],
	};
	await diff.openFileDiff(active, 'changed.txt');
	await diff.openCumulativeFileDiff(active, 'changed.txt');
	await diff.openAllChangesDiff(active);
	const leftRefs = commands.slice(0, 2).map((command) => new URLSearchParams(command[1].query).get('ref'));
	leftRefs.push(...commands[2][2].map((resource) => new URLSearchParams(resource[1].query).get('ref')));
	assert.deepEqual(leftRefs, [B, B, B, B]);
	assert.equal(commands[2][2].length, 2);
	active.compareIsHead = false;
	active.headCommit = E;
	active.headBranch = 'different';
	await diff.openFileDiff(active, 'changed.txt');
	assert.equal(new URLSearchParams(commands[3][2].query).get('ref'), D);
});

test('comparison helper uses exact commit endpoints, not a second merge-base calculation', async () => {
	const calls = [];
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args) => {
		calls.push(args);
		return { stdout: 'M\tfile.txt', stderr: '' };
	};
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	await git.changedFiles(repo, B, D);
	assert.deepEqual(calls, [['diff', '--name-status', B, D, '--']]);
});

test('Comparison renders baseline/error state and routes Pin and Auto controls', () => {
	const { ComparisonWebviewProvider } = loadCompiled('comparisonView', { vscode: {}, './gitApi': {} });
	const provider = new ComparisonWebviewProvider(() => undefined, () => {}, () => {}, () => {}, () => {});
	const script = provider.html().match(/<script>([\s\S]*?)<\/script>/)[1];
	const nodes = new Map();
	const node = (id) => {
		if (!nodes.has(id)) {
			nodes.set(id, {
				value: '', handlers: {}, classList: { add() {}, remove() {}, toggle() {} },
				addEventListener(event, handler) { this.handlers[event] = handler; },
			});
		}
		return nodes.get(id);
	};
	const messages = [];
	let receive;
	new vm.Script(script).runInNewContext({
		performance: { now: () => 0 },
		acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message.type) }),
		document: { getElementById: node, querySelector: node, activeElement: null },
		window: { addEventListener: (_, handler) => { receive = handler; } },
	});
	const state = {
		type: 'state', branches: [], base: 'main', compare: 'feature',
		baselineCommit: C, baselineReason: 'Auto: shared ancestor with origin/main.', ready: true,
	};
	receive({ data: state });
	assert.match(node('baseline').textContent, /\(auto\)/);
	assert.equal(node('baseline').title, C);
	assert.equal(node('baseline-reason').textContent, state.baselineReason);
	assert.equal(node('auto-baseline').disabled, true);
	node('pin-baseline').handlers.click();
	receive({ data: { ...state, baselineCommit: null, baselinePin: B, baselineError: 'Pin is not an ancestor.' } });
	assert.match(node('baseline').textContent, /invalid pin/);
	assert.equal(node('status').textContent, 'Pin is not an ancestor.');
	assert.equal(node('auto-baseline').disabled, false);
	node('auto-baseline').handlers.click();
	assert.deepEqual(messages, ['ready', 'pinBaseline', 'autoBaseline']);
});

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test('review reload picks up external replies without overwriting a comparison selected during the read', async () => {
	const f = comparisonFixture();
	await f.active.computeDefaults();
	await f.active.resolve();
	f.reviewStore.loadReview = async () => ({ threads: [{ comments: [{ body: 'New Copilot response' }] }] });
	await f.active.reloadReview();
	assert.equal(f.active.review.threads[0].comments[0].body, 'New Copilot response');
	const pending = deferred();
	f.reviewStore.loadReview = () => pending.promise;
	const reload = f.active.reloadReview();
	f.active.sourceFile = 'another-review/comments.json';
	const replacement = { threads: [] };
	f.active.review = replacement;
	pending.resolve({ threads: [{ comments: [{ body: 'Old comparison reply' }] }] });
	await reload;
	assert.equal(f.active.review, replacement);
});

function catalogFixture() {
	const requests = [];
	const states = [];
	let staleQueries = 0;
	let head = 'feature';
	const active = { repoRootFsPath: 'repo-a', comparisonKey: 'pair-a', base: 'main', compare: 'feature', baselineCommit: A };
	const gitApi = {
		listBranches: (cwd) => {
			const request = { cwd, ...deferred() };
			requests.push(request);
			return request.promise;
		},
		getHead: async () => ({ branch: head, detached: false }),
	};
	const { ComparisonWebviewProvider } = loadCompiled('comparisonView', {
		vscode: {}, './gitApi': gitApi,
		'./git': { aheadBehind: async () => { staleQueries++; return undefined; } },
		'./webviewMetrics': {
			PaneMetrics: class {
				async build(work) { return work(); }
				post(state) { states.push(state); }
			},
		},
	});
	const provider = new ComparisonWebviewProvider(() => active, () => {}, () => {}, () => {}, () => {});
	provider.view = {};
	return { provider, active, requests, states, gitApi, setHead: (value) => { head = value; }, staleQueries: () => staleQueries };
}

const branchCatalog = [
	{ name: 'main', kind: 'local', commit: A },
	{ name: 'feature', kind: 'local', commit: D },
	{ name: 'origin/main', kind: 'remote', commit: C },
];

test('startup view/ready/refresh requests share one enumeration and only the latest builds staleness', async () => {
	const f = catalogFixture();
	const renders = ['view-resolve', 'ready', 'startup', 'git-api-state'].map((reason) => f.provider.postState(reason));
	assert.equal(f.requests.length, 1);
	f.requests[0].resolve(branchCatalog);
	await Promise.all(renders);
	assert.equal(f.requests.length, 1);
	assert.equal(f.states.length, 1);
	assert.equal(f.staleQueries(), 2);
	assert.equal(f.states[0].branches.length, 3);
});

test('cached catalogs survive ordinary refreshes while HEAD and selected comparison stay fresh', async () => {
	const f = catalogFixture();
	const first = f.provider.postState();
	f.requests[0].resolve(branchCatalog);
	await first;
	f.setHead('main');
	f.active.compare = 'main';
	f.active.comparisonKey = 'pair-b';
	await f.provider.postState('review-changed');
	assert.equal(f.requests.length, 1);
	assert.equal(f.states.at(-1).compare, 'main');
	assert.equal(f.states.at(-1).branches.find((ref) => ref.name === 'main').isHead, true);
	assert.equal(f.states.at(-1).branches.find((ref) => ref.name === 'feature').isHead, false);
});

test('ref invalidation during enumeration serializes one replacement and never publishes the old catalog', async () => {
	const f = catalogFixture();
	const old = f.provider.postState();
	f.provider.invalidateBranches();
	const current = f.provider.postState();
	f.provider.invalidateBranches();
	const newest = f.provider.postState();
	assert.equal(f.requests.length, 1);
	f.requests[0].resolve(branchCatalog);
	await new Promise(setImmediate);
	assert.equal(f.requests.length, 2);
	assert.equal(f.states.length, 0);
	const updated = [...branchCatalog, { name: 'new-branch', kind: 'local', commit: E }];
	f.requests[1].resolve(updated);
	await Promise.all([old, current, newest]);
	assert.equal(f.requests.length, 2);
	assert.equal(f.states.length, 1);
	assert.ok(f.states[0].branches.some((ref) => ref.name === 'new-branch'));
});

test('manual refresh invalidates a completed catalog, but empty/error results are always retryable', async () => {
	const f = catalogFixture();
	const first = f.provider.postState();
	f.requests[0].resolve(branchCatalog);
	await first;
	f.provider.refresh(true);
	assert.equal(f.requests.length, 2);
	f.requests[1].resolve([]);
	await new Promise(setImmediate);
	const retryEmpty = f.provider.postState();
	assert.equal(f.requests.length, 3);
	f.requests[2].reject(new Error('query failure'));
	await assert.rejects(retryEmpty, /query failure/);
	const retryError = f.provider.postState();
	assert.equal(f.requests.length, 4);
	f.requests[3].resolve(branchCatalog);
	await retryError;
	assert.equal(f.states.at(-1).branches.length, 3);
});

test('repo root replacement neither reuses another repository catalog nor publishes its late result', async () => {
	const f = catalogFixture();
	const first = f.provider.postState();
	f.active.repoRootFsPath = 'repo-b';
	const second = f.provider.postState();
	assert.deepEqual(f.requests.map((r) => r.cwd), ['repo-a', 'repo-b']);
	f.requests[1].resolve(branchCatalog);
	await second;
	f.requests[0].resolve([{ name: 'wrong-repo', kind: 'local' }]);
	await first;
	await f.provider.postState();
	assert.equal(f.requests.length, 2);
	assert.equal(f.states.length, 2);
	assert.ok(f.states.every((state) => !state.branches.some((ref) => ref.name === 'wrong-repo')));
});

test('native and Git-style paths for the same repository share the startup catalog', async () => {
	const f = catalogFixture();
	f.active.repoRootFsPath = repo;
	const first = f.provider.postState();
	f.active.repoRootFsPath = process.platform === 'win32' ? repo.replace(/\\/g, '/').toUpperCase() : `${repo}/.`;
	const second = f.provider.postState();
	assert.equal(f.requests.length, 1);
	f.requests[0].resolve(branchCatalog);
	await Promise.all([first, second]);
	await f.provider.postState();
	assert.equal(f.requests.length, 1);
});

test('branch CLI enumerates full refs once and asks Git to shorten only ambiguous names', async () => {
	const calls = [];
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args) => {
		calls.push(args);
		if (args[1].includes('refname:short')) {
			return { stdout: 'refs/heads/shared\theads/shared' };
		}
		return { stdout: [
			`refs/heads/main\t${A}`,
			`refs/heads/shared\t${B}`,
			`refs/remotes/origin/main\t${C}`,
			`refs/remotes/origin/HEAD\t${C}`,
			`refs/tags/shared\t${D}`,
		].join('\n') };
	};
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	assert.deepEqual(await git.listBranchesCli(repo), [
		{ name: 'main', kind: 'local', commit: A },
		{ name: 'heads/shared', kind: 'local', commit: B },
		{ name: 'origin/main', kind: 'remote', commit: C },
	]);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], ['for-each-ref', '--format=%(refname)\t%(objectname)', '--include-root-refs']);
	assert.deepEqual(calls[1].slice(2), ['refs/heads/shared']);
});

test('large unambiguous catalogs avoid short-ref probes entirely and do not include remote HEAD aliases', async () => {
	const rows = Array.from({ length: 5000 }, (_, i) => [`refs/remotes/origin/feature-${i}`, D]);
	rows.push(['refs/remotes/origin/HEAD', A]);
	const calls = [];
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args, options) => {
		calls.push(args);
		assert.ok(options.maxBuffer > 1024 * 1024);
		assert.ok(!args[1].includes(':short'));
		return { stdout: rows.map((row) => row.join('\t')).join('\n') };
	};
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	const refs = await git.listBranchesCli(repo);
	assert.equal(calls.length, 1);
	assert.equal(refs.length, 5000);
	assert.equal(refs[4999].name, 'origin/feature-4999');
	assert.ok(refs.every((ref) => ref.kind === 'remote' && ref.commit === D));
});

test('pseudoref-shaped and cross-namespace collisions preserve the names Git actually chooses', async () => {
	const fullRefs = ['ORIG_HEAD', 'refs/heads/ORIG_HEAD', 'refs/heads/origin/main', 'refs/remotes/origin/main'];
	const selected = new Map([
		['refs/heads/ORIG_HEAD', 'heads/ORIG_HEAD'],
		['refs/heads/origin/main', 'heads/origin/main'],
		['refs/remotes/origin/main', 'remotes/origin/main'],
	]);
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args) => ({
		stdout: args[1].includes(':short')
			? args.slice(2).map((ref) => `${ref}\t${selected.get(ref)}`).join('\n')
			: fullRefs.map((ref) => `${ref}\t${A}`).join('\n'),
	});
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	assert.deepEqual((await git.listBranchesCli(repo)).map((ref) => ref.name), [...selected.values()]);
});

test('shortening exceptions are batched without truncation or inventing a name for a removed ref', async () => {
	const names = Array.from({ length: 200 }, (_, i) => `feature-${i}-${'x'.repeat(100)}`);
	const batches = [];
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args) => {
		if (!args[1].includes(':short')) {
			return { stdout: names.flatMap((name) => [`refs/heads/${name}\t${A}`, `refs/tags/${name}\t${B}`]).join('\n') };
		}
		batches.push(args.slice(2));
		return { stdout: args.slice(2).filter((ref) => ref !== `refs/heads/${names[0]}`)
			.map((ref) => `${ref}\t${ref.slice('refs/'.length)}`).join('\n') };
	};
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	const refs = await git.listBranchesCli(repo);
	assert.ok(batches.length > 1);
	assert.equal(batches.flat().length, names.length);
	assert.equal(refs.length, names.length - 1);
	assert.ok(refs.every((ref) => ref.name.startsWith('heads/')));
});

test('older Git retries without root-ref enumeration and conservatively delegates simple branch names', async () => {
	const calls = [];
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args) => {
		calls.push(args);
		if (args.includes('--include-root-refs')) { throw Object.assign(new Error('unsupported flag'), { code: 129 }); }
		if (args[1].includes(':short')) { return { stdout: 'refs/heads/main\theads/main' }; }
		return { stdout: `refs/heads/main\t${A}\nrefs/remotes/origin/main\t${B}` };
	};
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	const expected = [{ name: 'heads/main', kind: 'local', commit: A }, { name: 'origin/main', kind: 'remote', commit: B }];
	assert.deepEqual(await git.listBranchesCli(repo), expected);
	assert.deepEqual(await git.listBranchesCli(repo), expected);
	assert.equal(calls.filter((args) => args.includes('--include-root-refs')).length, 1);
	assert.equal(calls.length, 5);
});

test('branch-catalog failures are not treated as unsupported-option retries or partial catalogs', async () => {
	const calls = [];
	const execFile = () => {};
	execFile[require('node:util').promisify.custom] = async (_, args) => {
		calls.push(args);
		throw Object.assign(new Error('not a repository'), { code: 128 });
	};
	const git = loadCompiled('git', { child_process: { execFile, exec: () => {} } });
	assert.deepEqual(await git.listBranchesCli(repo), []);
	assert.equal(calls.length, 1);
});

test('Git API separates actual ref changes from worktree-only events for catalog invalidation', async () => {
	let onChange;
	let onOpen;
	let invalidations = 0;
	let refreshes = 0;
	const repository = {
		state: { refs: [{ type: 0, name: 'main', commit: A }], onDidChange: (handler) => {
			onChange = handler;
			return { dispose() {} };
		} },
	};
	const api = { getRepository: () => repository, onDidOpenRepository: (handler) => {
		onOpen = handler;
		return { dispose() {} };
	} };
	const gitApi = loadCompiled('gitApi', { vscode: {
		extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => api } }) },
		Uri: { file: (fsPath) => ({ fsPath }) },
		Disposable: class { constructor(dispose) { this.dispose = dispose; } },
	} });
	const subscription = await gitApi.onRepoStateChanged(repo, () => refreshes++, () => invalidations++);
	onOpen();
	assert.equal(invalidations, 0);
	assert.equal(refreshes, 0);
	onChange();
	repository.state.refs = [{ type: 0, name: 'main', commit: A }];
	onChange();
	assert.equal(invalidations, 0);
	repository.state.refs[0].commit = B;
	onChange();
	repository.state.refs.push({ type: 0, name: 'new', commit: C });
	onChange();
	assert.equal(invalidations, 2);
	assert.equal(refreshes, 4);
	subscription.dispose();
});
