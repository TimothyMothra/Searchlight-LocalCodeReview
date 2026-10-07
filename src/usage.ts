import { now } from './diagnostics';

export type PaneName = 'comparison' | 'files' | 'commits' | 'conversations';
export type EditorContext = 'searchlight-diff' | 'searchlight-conversation' | 'git-diff' | 'text-editor' | 'other' | 'none';

type UsageEvent =
	| 'command.started'
	| 'command.completed'
	| 'command.failed'
	| 'pane.action'
	| 'discussion.created'
	| 'discussion.replied'
	| 'discussion.resolved'
	| 'discussion.reopened'
	| 'discussion.exposed'
	| 'editor.observed'
	| 'editor.changed'
	| 'usage.session'
	| 'usage.visibility'
	| 'usage.focus'
	| 'usage.settings'
	| 'usage.summary';

type DiscussionEvent = 'discussion.created' | 'discussion.replied' | 'discussion.resolved' | 'discussion.reopened' | 'discussion.exposed';
interface UsageOptions {
	runId: string;
	enabled: boolean;
	sink: (line: string) => void;
	clock?: () => number;
	startMs?: number;
	focused?: boolean;
}

interface UsageEventDetails {
	command?: string;
	pane?: PaneName;
	action?: string;
	count?: number;
	tagged?: boolean;
	outcome?: string;
}

interface UsageRecord {
	runId: string;
	atMs: number;
	editorContext: EditorContext;
	windowFocused: boolean;
	event: UsageEvent;
	[key: string]: unknown;
}

interface CountState {
	known: boolean;
	visits: number;
	observations: number;
	changes: number;
}

interface PaneState extends CountState {
	visible: boolean;
	visibleMs: number;
	lastReason?: 'observation' | 'change';
}

interface EditorState extends CountState {
	context: EditorContext;
	visibleMs: number;
	lastReason?: 'observation' | 'change';
}

interface FocusState extends CountState {
	focused: boolean;
	focusedMs: number;
	lastReason?: 'observation' | 'change';
}

interface CommandCounts {
	started: number;
	completed: number;
	failed: number;
	byCommand: Record<string, { started: number; completed: number; failed: number }>;
}

interface PaneActionCounts {
	total: number;
	byPane: Record<PaneName, number>;
	byAction: Record<string, number>;
}

interface DiscussionCounts {
	created: number;
	replied: number;
	resolved: number;
	reopened: number;
	exposed: number;
	tagged: number;
}

interface ContextCounts {
	commands: CommandCounts['byCommand'];
	discussions: DiscussionCounts;
}

interface InternalCounts {
	session: number;
	visibility: number;
	focus: number;
	settings: number;
	summary: number;
	editorObserved: number;
	editorChanged: number;
}

interface UsageSnapshotPane {
	visible: boolean;
	known: boolean;
	visits: number;
	observations: number;
	changes: number;
	visibleMs: number;
	runningVisibleMs: number;
	lastReason?: 'observation' | 'change';
}

interface UsageSnapshotEditor {
	context: EditorContext;
	known: boolean;
	visits: number;
	observations: number;
	changes: number;
	visibleMs: number;
	runningVisibleMs: number;
	lastReason?: 'observation' | 'change';
}

interface UsageSnapshotFocus {
	focused: boolean;
	known: boolean;
	visits: number;
	observations: number;
	changes: number;
	focusedMs: number;
	runningFocusedMs: number;
	lastReason?: 'observation' | 'change';
}

const PANES: PaneName[] = ['comparison', 'files', 'commits', 'conversations'];
const COMMAND_RE = /^searchlight\.[A-Za-z0-9]+$/;
const ACTIONS = new Set([
	'selectBase', 'selectCompare', 'pullBase', 'pullCompare', 'pinBaseline', 'autoBaseline', 'unpinBase',
	'refreshBranches', 'viewConversation', 'toggleReviewed', 'openFile', 'openUncommitted', 'openCumulative',
	'newConversation', 'postMessage', 'askCopilot', 'refreshConversation', 'quote', 'copyCode', 'copyMessage', 'previewDraft',
	'expand', 'collapse', 'setExpanded', 'openBranchPicker', 'openCommitFile', 'copySha', 'navigate', 'resolve', 'unresolve',
	'toggleFolder', 'toggleThread',
]);

const emptyCommandCounts = (): CommandCounts => ({
	started: 0,
	completed: 0,
	failed: 0,
	byCommand: {},
});

const emptyPaneActionCounts = (): PaneActionCounts => ({
	total: 0,
	byPane: { comparison: 0, files: 0, commits: 0, conversations: 0 },
	byAction: {},
});

const emptyDiscussionCounts = (): DiscussionCounts => ({
	created: 0,
	replied: 0,
	resolved: 0,
	reopened: 0,
	exposed: 0,
	tagged: 0,
});

const emptyInternalCounts = (): InternalCounts => ({
	session: 0,
	visibility: 0,
	focus: 0,
	settings: 0,
	summary: 0,
	editorObserved: 0,
	editorChanged: 0,
});

let initialized = false;
let runId = '';
let enabled = false;
let sink: ((line: string) => void) | undefined;
let clock: () => number = now;
let startAt = 0;
let lastTickAt = 0;
let windowFocused = false;
let currentEditorContext: EditorContext = 'none';
let commandCounts = emptyCommandCounts();
let contextCounts = emptyContextCounts();
let paneActionCounts = emptyPaneActionCounts();
let discussionCounts = emptyDiscussionCounts();
let internalCounts = emptyInternalCounts();
let paneStates: Record<PaneName, PaneState> = emptyPaneStateMap();
let editorStates: Record<EditorContext, EditorState> = emptyEditorStateMap();
let focusState: FocusState = emptyFocusState();
let recent: UsageRecord[] = [];
let recentCursor = 0;
let droppedRecent = 0;
const RECENT_CAPACITY = 2000;

function emptyCountState(): CountState {
	return { known: false, visits: 0, observations: 0, changes: 0 };
}

function emptyContextCounts(): Record<EditorContext, ContextCounts> {
	const empty = (): ContextCounts => ({ commands: {}, discussions: emptyDiscussionCounts() });
	return {
		'searchlight-diff': empty(), 'searchlight-conversation': empty(), 'git-diff': empty(), 'text-editor': empty(),
		other: empty(), none: empty(),
	};
}

function emptyPaneStateMap(): Record<PaneName, PaneState> {
	return {
		comparison: { ...emptyCountState(), visible: false, visibleMs: 0 },
		files: { ...emptyCountState(), visible: false, visibleMs: 0 },
		commits: { ...emptyCountState(), visible: false, visibleMs: 0 },
		conversations: { ...emptyCountState(), visible: false, visibleMs: 0 },
	};
}

function emptyEditorStateMap(): Record<EditorContext, EditorState> {
	return {
		'searchlight-diff': { ...emptyCountState(), context: 'searchlight-diff', visibleMs: 0 },
		'searchlight-conversation': { ...emptyCountState(), context: 'searchlight-conversation', visibleMs: 0 },
		'git-diff': { ...emptyCountState(), context: 'git-diff', visibleMs: 0 },
		'text-editor': { ...emptyCountState(), context: 'text-editor', visibleMs: 0 },
		other: { ...emptyCountState(), context: 'other', visibleMs: 0 },
		none: { ...emptyCountState(), context: 'none', visibleMs: 0 },
	};
}

function emptyFocusState(): FocusState {
	return { ...emptyCountState(), focused: false, focusedMs: 0 };
}

function currentAtMs(): number {
	return Math.max(0, clock() - startAt);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidPane(value: unknown): value is PaneName {
	return value === 'comparison' || value === 'files' || value === 'commits' || value === 'conversations';
}

function isValidAction(value: unknown): value is string {
	return typeof value === 'string' && ACTIONS.has(value);
}

function isValidCommand(value: unknown): value is string {
	return typeof value === 'string' && COMMAND_RE.test(value);
}

function addRecent(record: UsageRecord): void {
	if (recent.length < RECENT_CAPACITY) {
		recent.push(record);
		return;
	}
	recent[recentCursor] = record;
	recentCursor = (recentCursor + 1) % RECENT_CAPACITY;
	droppedRecent++;
}

function currentRecent(): UsageRecord[] {
	return droppedRecent
		? [...recent.slice(recentCursor), ...recent.slice(0, recentCursor)]
		: [...recent];
}

function emit(record: { event: UsageEvent; [key: string]: unknown }): void {
	if (!initialized || !enabled || !sink) { return; }
	const full: UsageRecord = {
		runId,
		atMs: currentAtMs(),
		editorContext: currentEditorContext,
		windowFocused,
		...record,
	};
	addRecent(full);
	sink(`[usage] ${JSON.stringify(full)}`);
}

function accrueElapsed(nowMs: number): void {
	if (!initialized) { return; }
	const elapsed = Math.max(0, nowMs - lastTickAt);
	if (!elapsed || !enabled) {
		lastTickAt = nowMs;
		return;
	}
	if (windowFocused) {
		focusState.focusedMs += elapsed;
		if (currentEditorContext !== 'none') {
			editorStates[currentEditorContext].visibleMs += elapsed;
		}
		for (const pane of PANES) {
			if (paneStates[pane].visible) {
				paneStates[pane].visibleMs += elapsed;
			}
		}
	}
	lastTickAt = nowMs;
}

function markCount(state: CountState, enabledNow: boolean): 'observation' | 'change' | undefined {
	const reason: 'observation' | 'change' = state.known ? 'change' : 'observation';
	state.known = true;
	if (enabledNow) {
		state.visits++;
		if (reason === 'observation') { state.observations++; }
		else { state.changes++; }
	}
	return reason;
}

function paneSnapshot(pane: PaneName): UsageSnapshotPane {
	const state = paneStates[pane];
	const runningVisibleMs = enabled && windowFocused && state.visible ? Math.max(0, clock() - lastTickAt) : 0;
	return {
		visible: state.visible,
		known: state.known,
		visits: state.visits,
		observations: state.observations,
		changes: state.changes,
		visibleMs: state.visibleMs + runningVisibleMs,
		runningVisibleMs,
		lastReason: state.lastReason,
	};
}

function editorSnapshot(context: EditorContext): UsageSnapshotEditor {
	const state = editorStates[context];
	const runningVisibleMs = enabled && windowFocused && currentEditorContext === context && context !== 'none'
		? Math.max(0, clock() - lastTickAt)
		: 0;
	return {
		context: state.context,
		known: state.known,
		visits: state.visits,
		observations: state.observations,
		changes: state.changes,
		visibleMs: state.visibleMs + runningVisibleMs,
		runningVisibleMs,
		lastReason: state.lastReason,
	};
}

function focusSnapshot(): UsageSnapshotFocus {
	const runningFocusedMs = enabled && windowFocused ? Math.max(0, clock() - lastTickAt) : 0;
	return {
		focused: windowFocused,
		known: focusState.known,
		visits: focusState.visits,
		observations: focusState.observations,
		changes: focusState.changes,
		focusedMs: focusState.focusedMs + runningFocusedMs,
		runningFocusedMs,
		lastReason: focusState.lastReason,
	};
}

function countCommand(command: string, kind: 'started' | 'completed' | 'failed'): void {
	const item = commandCounts.byCommand[command] ?? { started: 0, completed: 0, failed: 0 };
	item[kind]++;
	commandCounts.byCommand[command] = item;
	commandCounts[kind]++;
	const context = contextCounts[currentEditorContext];
	const contextual = context.commands[command] ?? { started: 0, completed: 0, failed: 0 };
	contextual[kind]++;
	context.commands[command] = contextual;
}

function countPaneAction(pane: PaneName, action: string): void {
	paneActionCounts.total++;
	paneActionCounts.byPane[pane]++;
	paneActionCounts.byAction[action] = (paneActionCounts.byAction[action] ?? 0) + 1;
}

function countDiscussion(event: DiscussionEvent, count: number, tagged: boolean): void {
	addDiscussionCount(discussionCounts, event, count, tagged);
	addDiscussionCount(contextCounts[currentEditorContext].discussions, event, count, tagged);
}

function addDiscussionCount(target: DiscussionCounts, event: DiscussionEvent, count: number, tagged: boolean): void {
	if (event === 'discussion.exposed') {
		target.exposed += count;
	} else {
		target[event.split('.')[1] as keyof DiscussionCounts] += count;
	}
	if (tagged) {
		target.tagged += count;
	}
}

function emitStateEvent(event: 'usage.session' | 'usage.visibility' | 'usage.focus' | 'usage.settings', details: Record<string, unknown>): void {
	if (!initialized) { return; }
	if (event === 'usage.session') { internalCounts.session++; }
	if (event === 'usage.visibility') { internalCounts.visibility++; }
	if (event === 'usage.focus') { internalCounts.focus++; }
	if (event === 'usage.settings') { internalCounts.settings++; }
	emit({ event, ...details });
}

function emitEditorEvent(kind: 'editor.observed' | 'editor.changed'): void {
	if (!initialized || !enabled || !sink) { return; }
	if (kind === 'editor.observed') { internalCounts.editorObserved++; }
	else { internalCounts.editorChanged++; }
	emit({ event: kind });
}

function emitSummaryEvent(): void {
	if (!initialized) { return; }
	internalCounts.summary++;
	emit({
		event: 'usage.summary',
		enabled,
		counts: snapshotCounts(),
		panes: snapshotPaneMap(),
		editorContexts: snapshotEditorMap(),
		focus: focusSnapshot(),
	});
}

function snapshotCounts() {
	const copyCommands = (commands: CommandCounts['byCommand']) =>
		Object.fromEntries(Object.entries(commands).map(([name, counts]) => [name, { ...counts }]));
	return {
		commands: {
			started: commandCounts.started,
			completed: commandCounts.completed,
			failed: commandCounts.failed,
			byCommand: copyCommands(commandCounts.byCommand),
		},
		paneActions: {
			total: paneActionCounts.total,
			byPane: { ...paneActionCounts.byPane },
			byAction: { ...paneActionCounts.byAction },
		},
		discussions: { ...discussionCounts },
		byEditorContext: Object.fromEntries(Object.entries(contextCounts).map(([context, counts]) => [
			context, { commands: copyCommands(counts.commands), discussions: { ...counts.discussions } },
		])),
		internal: { ...internalCounts },
	};
}

function snapshotPaneMap() {
	return {
		comparison: paneSnapshot('comparison'),
		files: paneSnapshot('files'),
		commits: paneSnapshot('commits'),
		conversations: paneSnapshot('conversations'),
	};
}

function snapshotEditorMap() {
	return {
		'searchlight-diff': editorSnapshot('searchlight-diff'),
		'searchlight-conversation': editorSnapshot('searchlight-conversation'),
		'git-diff': editorSnapshot('git-diff'),
		'text-editor': editorSnapshot('text-editor'),
		other: editorSnapshot('other'),
		none: editorSnapshot('none'),
	};
}

export function initUsage(options: UsageOptions): void {
	runId = options.runId;
	sink = options.sink;
	clock = options.clock ?? now;
	enabled = options.enabled;
	initialized = true;
	recent = [];
	recentCursor = 0;
	droppedRecent = 0;
	commandCounts = emptyCommandCounts();
	contextCounts = emptyContextCounts();
	paneActionCounts = emptyPaneActionCounts();
	discussionCounts = emptyDiscussionCounts();
	internalCounts = emptyInternalCounts();
	paneStates = emptyPaneStateMap();
	editorStates = emptyEditorStateMap();
	focusState = emptyFocusState();
	currentEditorContext = 'none';
	// ASSUMPTION: the provided origin is already in the same monotonic clock domain as `clock()`.
	startAt = options.startMs ?? clock();
	// Elapsed exposure starts when observation begins, not before it at a supplied perf origin.
	lastTickAt = clock();
	windowFocused = options.focused ?? false;

	if (options.focused !== undefined) {
		const reason = markCount(focusState, enabled && options.focused);
		focusState.focused = options.focused;
		focusState.lastReason = reason;
		if (enabled) {
			emitStateEvent('usage.focus', { focused: options.focused, reason });
		}
	}

	if (enabled) {
		// ASSUMPTION: the session banner is informational only; it never changes feature counters.
		emitStateEvent('usage.session', { enabled: options.enabled, focused: windowFocused, reason: 'init' });
	}
}

export function setUsageEnabled(nextEnabled: boolean): void {
	if (!initialized || nextEnabled === enabled) { return; }
	const nowMs = clock();
	if (nextEnabled) {
		enabled = true;
		lastTickAt = nowMs;
		emitStateEvent('usage.settings', { enabled: true });
		return;
	}
	accrueElapsed(nowMs);
	emitStateEvent('usage.settings', { enabled: false });
	enabled = false;
	lastTickAt = nowMs;
}

export function recordUsage(event: string, details: UsageEventDetails = {}): void {
	if (!initialized || !enabled || !sink) { return; }
	if (event === 'editor.observed' || event === 'editor.changed') {
		emitEditorEvent(event);
		return;
	}
	if (event === 'usage.session') {
		emitStateEvent('usage.session', { enabled, focused: windowFocused });
		return;
	}
	if (event === 'usage.visibility') {
		if (!isValidPane(details.pane)) { return; }
		emitStateEvent('usage.visibility', { pane: details.pane, visible: Boolean(details.count), reason: 'change' });
		return;
	}
	if (event === 'usage.focus') {
		emitStateEvent('usage.focus', { focused: windowFocused, reason: 'change' });
		return;
	}
	if (event === 'usage.settings') {
		emitStateEvent('usage.settings', { enabled });
		return;
	}
	if (event === 'usage.summary') {
		emitSummaryEvent();
		return;
	}

	const payload: Record<string, unknown> = {};
	if (event === 'pane.action') {
		if (!isValidPane(details.pane) || !isValidAction(details.action)) { return; }
		payload.pane = details.pane;
		payload.action = details.action;
		countPaneAction(details.pane, details.action);
		emit({ event: 'pane.action', ...payload });
		return;
	}

	if (event === 'command.started' || event === 'command.completed' || event === 'command.failed') {
		if (!isValidCommand(details.command)) { return; }
		payload.command = details.command;
		countCommand(details.command, event.split('.')[1] as 'started' | 'completed' | 'failed');
		emit({ event, ...payload });
		return;
	}

	if (
		event === 'discussion.created' ||
		event === 'discussion.replied' ||
		event === 'discussion.resolved' ||
		event === 'discussion.reopened' ||
		event === 'discussion.exposed'
	) {
		if (details.count !== undefined && !isPositiveSafeInteger(details.count)) { return; }
		const count = isPositiveSafeInteger(details.count) ? details.count : 1;
		const tagged = typeof details.tagged === 'boolean' ? details.tagged : false;
		countDiscussion(event as DiscussionEvent, count, tagged);
		if (event === 'discussion.exposed' || count !== 1) {
			payload.count = count;
		}
		if (tagged) {
			payload.tagged = true;
		}
		emit({ event, ...payload });
		return;
	}
}

export function usagePane(pane: PaneName, visible: boolean): void {
	if (!initialized) { return; }
	const state = paneStates[pane];
	const nowMs = clock();
	const changed = !state.known || state.visible !== visible;
	if (!changed) { return; }
	accrueElapsed(nowMs);
	state.visible = visible;
	const reason = markCount(state, enabled && visible);
	state.lastReason = reason;
	if (enabled) {
		emitStateEvent('usage.visibility', { pane, visible, reason });
	}
}

export function usageFocus(focused: boolean): void {
	if (!initialized) { return; }
	const nowMs = clock();
	const changed = !focusState.known || windowFocused !== focused;
	if (!changed) { return; }
	accrueElapsed(nowMs);
	windowFocused = focused;
	const reason = markCount(focusState, enabled && focused);
	focusState.focused = focused;
	focusState.lastReason = reason;
	if (enabled) {
		emitStateEvent('usage.focus', { focused, reason });
	}
}

export function usageEditor(context: EditorContext): void {
	if (!initialized) { return; }
	const state = editorStates[context];
	const changed = !state.known || currentEditorContext !== context;
	if (!changed) { return; }
	const nowMs = clock();
	accrueElapsed(nowMs);
	currentEditorContext = context;
	const reason = markCount(state, enabled);
	state.context = context;
	state.lastReason = reason;
	// ASSUMPTION: editor state changes are counted here while the human-facing log line comes
	// from the caller's explicit editor.observed/editor.changed event.
}

export function usageSnapshot(): object {
	const atMs = currentAtMs();
	return {
		schemaVersion: 1,
		runId,
		atMs,
		enabled,
		windowFocused,
		editorContext: currentEditorContext,
		counts: snapshotCounts(),
		panes: snapshotPaneMap(),
		editorContexts: snapshotEditorMap(),
		focus: focusSnapshot(),
		recentDropped: droppedRecent,
		recent: currentRecent(),
	};
}

export function emitUsageSummary(): void {
	if (!initialized || !enabled) { return; }
	emitSummaryEvent();
}
