import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';

export type Fields = Record<string, string | number | boolean | undefined>;
interface TraceRecord {
	runId: string;
	atMs: number;
	name: string;
	kind: 'event' | 'start' | 'end' | 'milestone';
	spanId?: number;
	parentId?: number;
	durationMs?: number;
	outcome?: string;
	fields: Fields;
}
interface Aggregate {
	count: number;
	errors: number;
	totalMs: number;
	maxMs: number;
}

const context = new AsyncLocalStorage<{ runId: string; spanId: number }>();
const CAPACITY = 10000;
const PENDING_CAPACITY = 1024;
let records: TraceRecord[] = [];
let cursor = 0;
let dropped = 0;
let enabled = false;
let continuousCapture = false;
let droppedPendingSpans = 0;
let runId = '';
let startedAt = '';
let origin = 0;
let nextId = 0;
let metadata: Fields = {};
let sink: ((line: string) => void) | undefined;
const pending = new Map<number, TraceRecord>();
const aggregates = new Map<string, Aggregate>();
const milestones = new Map<string, TraceRecord>();

/** Host durations share a monotonic origin; wall-clock changes cannot alter elapsed time. */
export const now = (): number => performance.now();

export function startDiagnostics(start: number, active: boolean, output: (line: string) => void, info: Fields): void {
	runId = randomUUID();
	startedAt = new Date().toISOString();
	origin = start;
	enabled = active;
	continuousCapture = active;
	droppedPendingSpans = 0;
	sink = output;
	metadata = info;
	records = [];
	cursor = dropped = nextId = 0;
	pending.clear();
	aggregates.clear();
	milestones.clear();
	event('startup.begin', info);
}

export function setDiagnosticsEnabled(value: boolean): void {
	if (value === enabled) { return; }
	event('logging.changed', { enabled: value });
	enabled = value;
	if (!value) { continuousCapture = false; }
	if (value) { event('logging.resumed', { partialRun: true }); }
}

export function diagnosticsEnabled(): boolean { return enabled; }
export function diagnosticsRunId(): string { return runId; }
export function currentSpanId(): number | undefined {
	const current = context.getStore();
	return current?.runId === runId ? current.spanId : undefined;
}

function record(name: string, kind: TraceRecord['kind'], fields: Fields, extra: Partial<TraceRecord> = {}): TraceRecord {
	const entry: TraceRecord = {
		runId, atMs: now() - origin, name, kind, parentId: currentSpanId(), fields, ...extra,
	};
	if (records.length < CAPACITY) {
		records.push(entry);
	} else {
		records[cursor] = entry;
		cursor = (cursor + 1) % CAPACITY;
		dropped++;
	}
	sink?.(`[perf] ${JSON.stringify(entry)}`);
	return entry;
}

export function event(name: string, fields: Fields = {}): void {
	if (enabled) { record(name, 'event', fields); }
}

export function milestone(name: string, fields: Fields = {}): void {
	if (enabled && !milestones.has(name)) {
		milestones.set(name, record(name, 'milestone', fields));
	}
}

/** Only error categories/codes are exported: exception messages can contain paths or review text. */
export function errorFields(error: unknown): Fields {
	if (typeof error !== 'object' || error === null) { return { errorType: typeof error }; }
	const value = error as { name?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
	return {
		errorType: typeof value.name === 'string' ? value.name : 'Error',
		code: typeof value.code === 'number' || typeof value.code === 'string' ? value.code : undefined,
		killed: typeof value.killed === 'boolean' ? value.killed : undefined,
		signal: typeof value.signal === 'string' ? value.signal : undefined,
	};
}

export async function trace<T>(name: string, work: () => Promise<T>, fields: Fields = {}): Promise<T> {
	if (!enabled) { return work(); }
	const capturedRun = runId;
	const spanId = ++nextId;
	const start = now();
	const entry = record(name, 'start', fields, { spanId });
	pending.set(spanId, entry);
	if (pending.size > PENDING_CAPACITY) {
		const oldest = pending.keys().next().value;
		if (oldest !== undefined) {
			pending.delete(oldest);
			droppedPendingSpans++;
		}
	}
	let outcome = 'ok';
	let failure: Fields = {};
	try {
		return await context.run({ runId, spanId }, work);
	} catch (error) {
		outcome = 'error';
		failure = errorFields(error);
		throw error;
	} finally {
		if (capturedRun === runId) {
			pending.delete(spanId);
			if (enabled) {
				const durationMs = now() - start;
				record(name, 'end', { ...fields, ...failure }, { spanId, parentId: entry.parentId, durationMs, outcome });
				const aggregate = aggregates.get(name) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
				aggregate.count++;
				aggregate.errors += outcome === 'error' ? 1 : 0;
				aggregate.totalMs += durationMs;
				aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
				aggregates.set(name, aggregate);
			}
		}
	}
}

export function diagnosticsSnapshot(): object {
	return {
		schemaVersion: 1, runId, startedAt, elapsedMs: now() - origin, enabled, continuousCapture, metadata,
		// ASSUMPTION: overlapping spans are inclusive; summed time is workload, not startup latency.
		durationSemantics: 'inclusive; overlapping spans must not be summed as wall time',
		capacity: CAPACITY, droppedRecords: dropped, pendingCapacity: PENDING_CAPACITY, droppedPendingSpans,
		milestones: Object.fromEntries(milestones),
		aggregates: Object.fromEntries(aggregates),
		pending: [...pending.values()].map((entry) => ({ ...entry, elapsedMs: now() - origin - entry.atMs })),
		records: dropped ? [...records.slice(cursor), ...records.slice(0, cursor)] : [...records],
	};
}
