/**
 * Metrics protocol for the pane-conversion project (Files / Commits / Conversations webviews).
 *
 * Standardizes the three `[perf]` lines every converted pane emits, so the "before" (native TreeView)
 * numbers from Phase A stay directly comparable to the "after" (webview) numbers:
 *
 *   [perf] <view>.build:      <ms>ms, count=<n>, bytes=<serializedPayloadLength>   (host: payload built)
 *   [perf] <view>.render:     <ms>ms, count=<n>                                    (webview: DOM rendered)
 *   [perf] <view>.firstPaint: <ms>ms                                               (host: resolve -> 1st render)
 *
 * All output reuses the existing `perf.ts` channel + `searchlight.perfLogging` gating — no new channel,
 * no new setting. Labels stay consistent with Phase A (`files.*`, `commits.*`, `conversations.*`).
 *
 * Intended use inside a pane's `WebviewViewProvider`:
 *
 * ```ts
 * const tResolve = Date.now();
 * // ...build payload...
 * const tBuild = Date.now();
 * const rows = buildRows();
 * logBuild('files', tBuild, rows.length, rows);      // -> [perf] files.build
 * webview.postMessage({ type: 'state', rows });
 * webview.onDidReceiveMessage((msg) => {
 *   if (isRenderedMessage(msg)) {
 *     logRendered(msg);                               // -> [perf] files.render
 *     logFirstPaint('files', tResolve);               // -> [perf] files.firstPaint (once per view)
 *   }
 * });
 * ```
 */

import { perf, perfCount, perfCountMs } from './perf';

/** The `rendered` message a pane webview posts back after painting (see `webviewShell.reportRendered`). */
export interface RenderedMessage {
	type: 'rendered';
	/** Stable pane id: `files` | `commits` | `conversations`. */
	view: string;
	/** Client-side render duration in ms (fractional, from `performance.now()`). */
	ms: number;
	/** Number of rows the pane rendered. */
	count: number;
}

/** Narrow an untyped webview message to a {@link RenderedMessage}. */
export function isRenderedMessage(msg: unknown): msg is RenderedMessage {
	return (
		typeof msg === 'object' &&
		msg !== null &&
		(msg as { type?: unknown }).type === 'rendered' &&
		typeof (msg as { view?: unknown }).view === 'string' &&
		typeof (msg as { ms?: unknown }).ms === 'number' &&
		typeof (msg as { count?: unknown }).count === 'number'
	);
}

/**
 * Host-side: log `[perf] <view>.build: <ms>ms, count=<n>, bytes=<len>` for the time to build the pane
 * payload. `bytes` is the serialized payload length (`JSON.stringify(payload).length`), giving a rough
 * transfer-size signal to weigh against the native TreeView baseline.
 */
export function logBuild(view: string, tBuild: number, count: number, payload: unknown): void {
	perfCount(`${view}.build`, tBuild, count, `bytes=${JSON.stringify(payload).length}`);
}

/**
 * Host-side: on receiving a {@link RenderedMessage} from a pane webview, log
 * `[perf] <view>.render: <ms>ms, count=<n>` using the webview-measured render duration.
 */
export function logRendered(msg: RenderedMessage): void {
	perfCountMs(`${msg.view}.render`, msg.ms, msg.count);
}

/** Views whose first paint has already been logged, so `logFirstPaint` fires at most once per view. */
const firstPaintLogged = new Set<string>();

/**
 * Host-side: log `[perf] <view>.firstPaint: <ms>ms` for the resolve→first-render latency. Call on the
 * FIRST `rendered` message per view (`tResolve` = `Date.now()` captured in `resolveWebviewView`);
 * subsequent calls for the same view are no-ops.
 */
export function logFirstPaint(view: string, tResolve: number): void {
	if (firstPaintLogged.has(view)) {
		return;
	}
	firstPaintLogged.add(view);
	perf(`${view}.firstPaint`, tResolve);
}
