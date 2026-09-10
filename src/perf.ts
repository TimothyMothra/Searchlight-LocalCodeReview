/**
 * Lightweight load-time instrumentation for the Searchlight OUTPUT channel.
 *
 * Routes `[perf]` lines through the same channel `extension.ts` uses for user-visible feedback, so
 * timings appear inline with git/action logs. All output is gated behind the `searchlight.perfLogging`
 * setting (default true) so the user can silence it once they've seen the numbers.
 *
 * Host timers use the monotonic clock exported by diagnostics.ts.
 */

import * as vscode from 'vscode';
import { event, now, startDiagnostics } from './diagnostics';

/** The shared Searchlight output channel, wired once from `activate()`. */
let channel: vscode.OutputChannel | undefined;

/** Wire the shared Searchlight output channel (called once from `activate`). */
export function initPerf(outputChannel: vscode.OutputChannel, start = now(), metadata = {}): void {
	channel = outputChannel;
	startDiagnostics(start, perfEnabled(), (line) => channel?.appendLine(line), metadata);
}

/** True when perf logging is enabled (searchlight.perfLogging, default true). */
function perfEnabled(): boolean {
	return vscode.workspace.getConfiguration('searchlight').get<boolean>('perfLogging', true);
}

/**
 * Log `[perf] <label>: <ms>ms` for the elapsed time since `startMs`. When `suffix` is provided it is
 * appended after the duration (e.g. `changedFiles (git diff): 42ms, 137 files`).
 */
export function perf(label: string, startMs: number, suffix?: string): void {
	const ms = now() - startMs;
	event(label, { durationMs: ms, detail: suffix });
}

/**
 * Log `[perf] <label>: <ms>ms, count=<n>` for a build/data-load that produced `count` items. When
 * `extra` is provided it is appended after the count (e.g. `paths=137` or `truncated=false`, and it
 * may carry a `bytes=` field). Mirrors `perf` but adds item cardinality so the webview-conversion
 * project has real "before" numbers to detect regressions against.
 */
export function perfCount(label: string, startMs: number, count: number, extra?: string): void {
	const ms = now() - startMs;
	event(label, { durationMs: ms, count, detail: extra });
}

/**
 * Log `[perf] <label>: <ms>ms, count=<n>` for an ALREADY-MEASURED duration. Unlike `perfCount` (which
 * computes `now() - startMs`), this takes a precomputed `ms` — used for durations measured on the
 * other side of the webview boundary (e.g. a pane's client-side `performance.now()` render delta, which
 * the extension host can't time itself). `ms` is rounded since `performance.now()` is fractional.
 */
export function perfCountMs(label: string, ms: number, count: number, extra?: string): void {
	event(label, { durationMs: ms, count, detail: extra });
}

/** Log a bare `[perf] <text>` line (used for the `--- activation ---` header). */
export function perfLine(text: string): void {
	event(text);
}
