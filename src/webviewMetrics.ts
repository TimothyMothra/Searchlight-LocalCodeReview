import * as vscode from 'vscode';
import { currentSpanId, diagnosticsEnabled, event, milestone, now, trace } from './diagnostics';
import { PaneName, recordUsage, usagePane } from './usage';

let comparisonSettled = false;
export function setComparisonSettled(): void { comparisonSettled = true; }
const panes = new Map<string, PaneMetrics>();
export function resetPaneMetrics(): void {
	comparisonSettled = false;
	panes.clear();
}
export function paneSnapshot(): object {
	const states = [...panes.values()].map((pane) => pane.snapshot());
	const visible = states.filter((pane) => pane.visible);
	return {
		comparisonSettled,
		allCurrentlyVisiblePanesReady: diagnosticsEnabled() && visible.length > 0 ? visible.every((pane) => pane.contentReady) : null,
		views: states,
	};
}

export function logBuild(view: string, start: number, count: number, _payload: unknown): void {
	// Serialization is measured at the transport boundary, not repeated just to count bytes.
	event(`${view}.build`, { durationMs: now() - start, count });
}

interface RenderedMessage {
	type: 'rendered' | 'paintOpportunity';
	view: string;
	ms: number;
	count: number;
	requestId: number;
}

export function isRenderedMessage(value: unknown): value is RenderedMessage {
	if (typeof value !== 'object' || value === null) { return false; }
	const msg = value as Partial<RenderedMessage>;
	return (msg.type === 'rendered' || msg.type === 'paintOpportunity') &&
		typeof msg.view === 'string' && typeof msg.ms === 'number' && Number.isFinite(msg.ms) && msg.ms >= 0 &&
		typeof msg.count === 'number' && Number.isSafeInteger(msg.count) && msg.count >= 0 &&
		typeof msg.requestId === 'number' && Number.isSafeInteger(msg.requestId) && msg.requestId > 0;
}

type ContentState = 'placeholder' | 'content' | 'empty' | 'error';
interface Delivery { start: number; state: ContentState; parentId?: number }

/** One tracker per provider, with a fresh resolve origin whenever VS Code recreates its webview. */
export class PaneMetrics {
	private view?: vscode.WebviewView;
	private resolvedAt = 0;
	private generation = 0;
	private nextRequest = 0;
	private latestRequest = 0;
	private renderedRequest = 0;
	private renderedState?: ContentState;
	private readonly deliveries = new Map<number, Delivery>();

	constructor(private readonly name: PaneName) { panes.set(name, this); }

	snapshot() {
		return {
			view: this.name, resolved: !!this.view, visible: this.view?.visible ?? false,
			generation: this.generation, latestRequest: this.latestRequest,
			contentReady: !!this.renderedRequest && this.renderedRequest === this.latestRequest && this.renderedState !== 'placeholder',
			state: this.renderedState,
			pending: [...this.deliveries].map(([requestId, entry]) => ({
				requestId, state: entry.state, elapsedMs: now() - entry.start, parentId: entry.parentId,
			})),
		};
	}

	bind(view: vscode.WebviewView): void {
		this.view = view;
		this.resolvedAt = now();
		const generation = ++this.generation;
		this.deliveries.clear();
		this.renderedRequest = 0;
		this.renderedState = undefined;
		event(`${this.name}.resolveView`, { generation, visible: view.visible });
		usagePane(this.name, view.visible);
		const visibility = view.onDidChangeVisibility(() => {
			if (generation !== this.generation) { return; }
			event(`${this.name}.visibility`, { visible: view.visible, generation });
			usagePane(this.name, view.visible);
			if (generation === this.generation && view.visible && this.renderedRequest === this.latestRequest && this.renderedRequest) {
				// Retained webviews need not re-render when revealed; their DOM was already acknowledged.
				const fields = { generation, state: this.renderedState, sinceViewResolveMs: now() - this.resolvedAt, retained: true };
				milestone(`${this.name}.firstDom`, fields);
				if (this.renderedState !== 'placeholder') { milestone(`${this.name}.contentReady`, fields); }
			}
		});
		const messages = view.webview.onDidReceiveMessage((msg: unknown) => {
			if (generation !== this.generation) { return; }
			if (typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'ready') {
				event(`${this.name}.clientReady`, { durationMs: now() - this.resolvedAt, generation });
			}
			if (typeof msg === 'object' && msg !== null && 'type' in msg && typeof msg.type === 'string') {
				const action = msg.type === 'usageAction' && 'action' in msg && typeof msg.action === 'string'
					? msg.action : msg.type === 'expand' ? undefined : msg.type;
				// The recorder allowlists actions; never forward the message's paths, refs or contents.
				if (action) { recordUsage('pane.action', { pane: this.name, action }); }
			}
			if (isRenderedMessage(msg) && msg.view === this.name) { this.rendered(msg); }
		});
		const disposal = view.onDidDispose(() => {
			visibility.dispose();
			messages.dispose();
			disposal.dispose();
			if (generation === this.generation) {
				event(`${this.name}.disposeView`, { pending: this.deliveries.size, generation });
				usagePane(this.name, false);
				this.deliveries.clear();
				this.view = undefined;
			}
		});
	}

	build(work: () => Promise<void>, reason: string): Promise<void> {
		return trace(`${this.name}.state`, work, { reason, visible: this.view?.visible ?? false });
	}

	post(payload: Record<string, unknown>): void {
		const view = this.view;
		if (!view) { return; }
		if (!diagnosticsEnabled()) {
			this.renderedRequest = 0;
			this.renderedState = undefined;
			this.deliveries.clear();
			void view.webview.postMessage(payload);
			return;
		}
		const start = now();
		const requestId = ++this.nextRequest;
		this.latestRequest = requestId;
		const collection = payload.tree ?? payload.commits ?? payload.threads;
		const state: ContentState = payload.error || payload.baselineError ? 'error' :
			payload.loading || (!comparisonSettled && collection == null && !payload.ready) ? 'placeholder' :
			collection == null && !payload.ready ? 'empty' : 'content';
		const diagnostic = { requestId };
		const message = { ...payload, diagnostic };
		const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
		event(`${this.name}.serialize`, { durationMs: now() - start, bytes, requestId, state });
		this.deliveries.set(requestId, { start, state, parentId: currentSpanId() });
		if (this.deliveries.size > 64) {
			const oldest = this.deliveries.keys().next().value;
			if (oldest !== undefined) {
				this.deliveries.delete(oldest);
				event(`${this.name}.deliveryEvicted`, { requestId: oldest });
			}
		}
		void trace(`${this.name}.postMessage`, async () => {
			const accepted = await view.webview.postMessage(message);
			event(`${this.name}.delivery`, { requestId, accepted });
			if (!accepted) { this.deliveries.delete(requestId); }
		}, { requestId }).catch(() => {
			// The trace records the failure; diagnostic delivery must not introduce an unhandled rejection.
			this.deliveries.delete(requestId);
		});
	}

	private rendered(msg: RenderedMessage): void {
		const delivery = this.deliveries.get(msg.requestId);
		if (!delivery) { return; }
		const superseded = msg.requestId !== this.latestRequest;
		if (!superseded) {
			this.renderedRequest = msg.requestId;
			this.renderedState = delivery.state === 'content' && msg.count === 0 ? 'empty' : delivery.state;
		}
		const fields = {
			requestId: msg.requestId, requestSpanId: delivery.parentId, generation: this.generation,
			durationMs: msg.ms, count: msg.count, state: delivery.state, superseded,
			roundTripMs: now() - delivery.start, sinceViewResolveMs: now() - this.resolvedAt,
			visible: this.view?.visible ?? false,
		};
		event(`${this.name}.${msg.type === 'rendered' ? 'render' : 'paintOpportunity'}`, fields);
		if (this.view?.visible && msg.type === 'rendered') {
			milestone(`${this.name}.firstDom`, fields);
		}
		if (!superseded && this.view?.visible) {
			if (delivery.state !== 'placeholder') {
				milestone(`${this.name}.${msg.type === 'rendered' ? 'contentReady' : 'contentPaintOpportunity'}`, {
					...fields, state: delivery.state === 'content' && msg.count === 0 ? 'empty' : delivery.state,
				});
			}
		}
		if (msg.type === 'paintOpportunity') { this.deliveries.delete(msg.requestId); }
	}
}
