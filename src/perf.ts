/**
 * Lightweight load-time instrumentation for the Searchlight OUTPUT channel.
 *
 * Routes `[perf]` lines through the same channel `extension.ts` uses for user-visible feedback, so
 * timings appear inline with git/action logs. All output is gated behind the `searchlight.perfLogging`
 * setting (default true) so the user can silence it once they've seen the numbers.
 *
 * Uses plain `Date.now()` deltas — no new dependencies, no reliance on `perf_hooks`.
 */

import * as vscode from 'vscode';

/** The shared Searchlight output channel, wired once from `activate()`. */
let channel: vscode.OutputChannel | undefined;

/** Wire the shared Searchlight output channel (called once from `activate`). */
export function initPerf(outputChannel: vscode.OutputChannel): void {
	channel = outputChannel;
}

/** True when perf logging is enabled (searchlight.perfLogging, default true). */
function perfEnabled(): boolean {
	return vscode.workspace.getConfiguration('searchlight').get<boolean>('perfLogging', true);
}

/** Emit a timestamped `[perf] ...` line into the Searchlight channel (no-op when disabled). */
function emit(text: string): void {
	if (!perfEnabled()) {
		return;
	}
	const stamp = new Date().toLocaleTimeString();
	channel?.appendLine(`[${stamp}] [perf] ${text}`);
}

/**
 * Log `[perf] <label>: <ms>ms` for the elapsed time since `startMs`. When `suffix` is provided it is
 * appended after the duration (e.g. `changedFiles (git diff): 42ms, 137 files`).
 */
export function perf(label: string, startMs: number, suffix?: string): void {
	const ms = Date.now() - startMs;
	emit(`${label}: ${ms}ms${suffix ? `, ${suffix}` : ''}`);
}

/**
 * Log `[perf] <label>: <ms>ms, count=<n>` for a build/data-load that produced `count` items. When
 * `extra` is provided it is appended after the count (e.g. `paths=137` or `truncated=false`, and it
 * may carry a `bytes=` field). Mirrors `perf` but adds item cardinality so the webview-conversion
 * project has real "before" numbers to detect regressions against.
 */
export function perfCount(label: string, startMs: number, count: number, extra?: string): void {
	const ms = Date.now() - startMs;
	emit(`${label}: ${ms}ms, count=${count}${extra ? `, ${extra}` : ''}`);
}

/** Log a bare `[perf] <text>` line (used for the `--- activation ---` header). */
export function perfLine(text: string): void {
	emit(text);
}
