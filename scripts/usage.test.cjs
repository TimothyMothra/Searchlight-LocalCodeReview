const assert = require('node:assert/strict');
const { test } = require('node:test');

const usage = require('../out/usage');

function makeHarness({ enabled = true, focused = true, clockStart = 0, startMs } = {}) {
	let t = clockStart;
	const lines = [];
	usage.initUsage({
		runId: 'run-usage-test',
		enabled,
		focused,
		startMs,
		clock: () => t,
		sink: (line) => lines.push(line),
	});
	return {
		lines,
		advance(ms) { t += ms; },
		snapshot() { return usage.usageSnapshot(); },
	};
}

function parse(line) {
	assert.match(line, /^\[usage\] /);
	return JSON.parse(line.slice('[usage] '.length));
}

test('exports the usage API and preserves zero-usage panes in snapshots', () => {
	assert.equal(typeof usage.initUsage, 'function');
	assert.equal(typeof usage.setUsageEnabled, 'function');
	assert.equal(typeof usage.recordUsage, 'function');
	assert.equal(typeof usage.usagePane, 'function');
	assert.equal(typeof usage.usageFocus, 'function');
	assert.equal(typeof usage.usageEditor, 'function');
	assert.equal(typeof usage.usageSnapshot, 'function');
	assert.equal(typeof usage.emitUsageSummary, 'function');

	usage.setUsageEnabled(false);
	const h = makeHarness({ enabled: true, focused: false });
	const snapshot = h.snapshot();
	assert.equal(snapshot.runId, 'run-usage-test');
	assert.equal(snapshot.enabled, true);
	assert.equal(snapshot.windowFocused, false);
	assert.deepEqual(Object.keys(snapshot.panes).sort(), ['commits', 'comparison', 'conversations', 'files']);
	assert.equal(snapshot.panes.commits.visits, 0);
	assert.equal(snapshot.panes.commits.visibleMs, 0);
	assert.equal(snapshot.panes.commits.known, false);
	assert.equal(snapshot.counts.commands.started, 0);
	assert.equal(snapshot.counts.paneActions.total, 0);
	assert.equal(snapshot.counts.discussions.exposed, 0);
	assert.equal(snapshot.recentDropped, 0);
	assert.ok(h.lines.some((line) => parse(line).event === 'usage.session'));
});

test('uses supplied startMs as the shared monotonic origin', () => {
	const h = makeHarness({ enabled: true, focused: false, clockStart: 5000, startMs: 4500 });
	const session = parse(h.lines.find((line) => parse(line).event === 'usage.session'));
	assert.equal(session.atMs, 500);
	assert.equal(h.snapshot().atMs, 500);
});

test('tracks command, pane, discussion, focus, editor, disable and re-enable activity', () => {
	const h = makeHarness({ enabled: true, focused: true });

	usage.usageEditor('text-editor');
	usage.usagePane('comparison', true);
	usage.recordUsage('command.started', { command: 'searchlight.refreshAll', pane: 'comparison', action: 'selectBase', count: 99, tagged: true, outcome: 'ok' });
	usage.recordUsage('command.completed', { command: 'searchlight.refreshAll' });
	usage.recordUsage('command.started', { command: 'searchlight.copySha' });
	usage.recordUsage('command.failed', { command: 'searchlight.copySha' });
	usage.recordUsage('pane.action', { pane: 'comparison', action: 'selectBase' });
	usage.recordUsage('discussion.created', { count: 2, tagged: true });
	usage.recordUsage('discussion.replied', { tagged: false });
	usage.recordUsage('discussion.resolved');
	usage.recordUsage('discussion.reopened');
	usage.recordUsage('discussion.exposed', { count: 3 });
	usage.recordUsage('random.private.event', { body: 'TOP-SECRET', path: 'C:\\private\\file.ts' });
	usage.recordUsage('command.started', { command: 'searchlight.refreshAll', body: 'TOP-SECRET', branch: 'main' });

	h.advance(40);
	const snapA = h.snapshot();
	h.advance(20);
	const snapB = h.snapshot();
	assert.equal(snapB.panes.comparison.visibleMs - snapA.panes.comparison.visibleMs, 20);

	h.advance(40); // t = 100
	usage.usageFocus(false);
	h.advance(50); // t = 150
	usage.usageFocus(true);
	h.advance(50); // t = 200
	usage.usagePane('comparison', false);
	h.advance(50); // t = 250
	usage.setUsageEnabled(false);
	h.advance(50); // t = 300
	usage.setUsageEnabled(true);
	h.advance(50); // t = 350

	const snapshot = h.snapshot();
	assert.equal(snapshot.counts.commands.started, 3);
	assert.equal(snapshot.counts.commands.completed, 1);
	assert.equal(snapshot.counts.commands.failed, 1);
	assert.equal(snapshot.counts.paneActions.total, 1);
	assert.equal(snapshot.counts.discussions.created, 2);
	assert.equal(snapshot.counts.discussions.replied, 1);
	assert.equal(snapshot.counts.discussions.resolved, 1);
	assert.equal(snapshot.counts.discussions.reopened, 1);
	assert.equal(snapshot.counts.discussions.exposed, 3);
	assert.equal(snapshot.counts.discussions.tagged, 2);
	assert.equal(snapshot.panes.comparison.visibleMs, 150);
	assert.equal(snapshot.panes.comparison.visits, 1);
	assert.equal(snapshot.panes.commits.visibleMs, 0);
	assert.equal(snapshot.editorContexts['text-editor'].visibleMs, 250);
	assert.equal(snapshot.focus.focusedMs, 250);

	const beforeSummary = snapshot.counts.commands.started;
	usage.emitUsageSummary();
	assert.equal(h.snapshot().counts.commands.started, beforeSummary);

	const outputs = h.lines.map(parse);
	assert.ok(outputs.some((item) => item.event === 'command.completed' && item.command === 'searchlight.refreshAll'));
	assert.ok(outputs.some((item) => item.event === 'pane.action' && item.pane === 'comparison' && item.action === 'selectBase'));
	assert.ok(outputs.some((item) => item.event === 'discussion.exposed' && item.count === 3));
	assert.ok(outputs.some((item) => item.event === 'usage.summary'));
	assert.ok(!JSON.stringify(outputs).includes('TOP-SECRET'));
});

test('logs editor observations and changes without extra metadata and allows setExpanded pane actions', () => {
	const h = makeHarness({ enabled: true, focused: true });

	usage.usageEditor('git-diff');
	usage.recordUsage('editor.observed');
	usage.recordUsage('editor.changed');
	usage.recordUsage('pane.action', { pane: 'files', action: 'setExpanded' });
	usage.recordUsage('pane.action', { pane: 'comparison', action: 'openBranchPicker' });

	const snapshot = h.snapshot();
	assert.equal(snapshot.counts.paneActions.total, 2);
	assert.equal(snapshot.counts.paneActions.byPane.files, 1);
	assert.equal(snapshot.counts.paneActions.byPane.comparison, 1);
	assert.equal(snapshot.counts.internal.editorObserved, 1);
	assert.equal(snapshot.counts.internal.editorChanged, 1);

	const events = h.lines.map(parse).filter((item) => item.event === 'editor.observed' || item.event === 'editor.changed');
	assert.equal(events.length, 2);
	for (const item of events) {
		assert.equal(item.editorContext, 'git-diff');
		assert.equal(item.windowFocused, true);
		assert.ok(!Object.hasOwn(item, 'context'));
		assert.ok(!Object.hasOwn(item, 'reason'));
	}
	assert.ok(h.lines.some((line) => parse(line).event === 'pane.action' && parse(line).action === 'setExpanded'));
	assert.ok(h.lines.some((line) => parse(line).event === 'pane.action' && parse(line).action === 'openBranchPicker'));
});

test('drops unsupported events and caps recent events at 2000', () => {
	const h = makeHarness({ enabled: true, focused: true });

	usage.recordUsage('private.event', { path: 'C:\\secret', body: 'TOP-SECRET' });
	usage.recordUsage('command.started', { command: 'searchlight.refreshAll', path: 'C:\\secret', body: 'TOP-SECRET' });
	usage.recordUsage('pane.action', { pane: 'comparison', action: 'openFile', path: 'C:\\secret' });
	usage.recordUsage('discussion.created', { count: 1, body: 'TOP-SECRET' });

	for (let i = 0; i < 2001; i++) {
		usage.recordUsage('discussion.exposed', { count: 1 });
	}

	const snapshot = h.snapshot();
	assert.equal(snapshot.recent.length, 2000);
	assert.equal(snapshot.recentDropped, 6);
	assert.equal(snapshot.counts.discussions.exposed, 2001);
	assert.equal(snapshot.panes.files.visits, 0);
	assert.ok(!JSON.stringify(h.lines).includes('TOP-SECRET'));
	assert.ok(!JSON.stringify(h.lines).includes('C:\\secret'));
});

test('nonzero host clocks and earlier perf origins preserve running exposure durations', () => {
	const h = makeHarness({ clockStart: 5000, startMs: 4500 });
	usage.usagePane('files', true);
	usage.usageEditor('git-diff');
	h.advance(100);
	assert.equal(h.snapshot().atMs, 600);
	assert.equal(h.snapshot().panes.files.visibleMs, 100);
	assert.equal(h.snapshot().editorContexts['git-diff'].visibleMs, 100);
	assert.equal(h.snapshot().focus.focusedMs, 100);
	usage.emitUsageSummary();
	h.advance(50);
	assert.equal(h.snapshot().panes.files.visibleMs, 150);
	usage.usageFocus(false);
	h.advance(1000);
	assert.equal(h.snapshot().panes.files.visibleMs, 150);
	usage.usageFocus(true);
	h.advance(20);
	assert.equal(h.snapshot().panes.files.visibleMs, 170);
});

test('hidden observations and pane hides are not visits, and unchanged notifications do not count twice', () => {
	const h = makeHarness();
	usage.usagePane('commits', false);
	usage.usagePane('commits', false);
	assert.equal(h.snapshot().panes.commits.visits, 0);
	usage.usagePane('commits', true);
	usage.usagePane('commits', true);
	usage.usagePane('commits', false);
	assert.equal(h.snapshot().panes.commits.visits, 1);
	assert.equal(h.snapshot().counts.paneActions.byPane.commits, 0);
});

test('contextual feature counts survive event eviction and previous summaries are immutable', () => {
	const h = makeHarness();
	usage.usageEditor('git-diff');
	usage.recordUsage('command.started', { command: 'searchlight.createOrReply' });
	usage.recordUsage('discussion.replied');
	usage.emitUsageSummary();
	const before = h.snapshot();
	usage.recordUsage('command.started', { command: 'searchlight.createOrReply' });
	assert.equal(before.counts.commands.byCommand['searchlight.createOrReply'].started, 1);
	assert.equal(before.recent.find((item) => item.event === 'usage.summary').counts.commands.byCommand['searchlight.createOrReply'].started, 1);
	usage.usageEditor('searchlight-diff');
	usage.recordUsage('discussion.created');
	for (let i = 0; i < 2000; i++) { usage.recordUsage('editor.changed'); }
	const snapshot = h.snapshot();
	assert.equal(snapshot.counts.byEditorContext['git-diff'].discussions.replied, 1);
	assert.equal(snapshot.counts.byEditorContext['git-diff'].commands['searchlight.createOrReply'].started, 2);
	assert.equal(snapshot.counts.byEditorContext['searchlight-diff'].discussions.created, 1);
	for (const count of [0, -1, NaN, Infinity]) { usage.recordUsage('discussion.exposed', { count }); }
	assert.equal(h.snapshot().counts.discussions.exposed, 0);
});
