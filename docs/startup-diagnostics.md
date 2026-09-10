# Startup diagnostics

Searchlight records local startup diagnostics when `searchlight.perfLogging` is enabled (default
`true`). It does not send telemetry anywhere. Timings use a monotonic clock; every record has a
run ID and milliseconds since entry into `activate()`.

## Capture a baseline

1. Install the build to measure and enable `searchlight.perfLogging` **before** reloading.
2. Keep the workspace, pane visibility, expanded sections, open editors, and Searchlight settings
   consistent. Record separately whether the run was a full VS Code launch or **Reload Window**.
3. Open **Output > Searchlight**. `[perf]` lines contain JSON events and span starts/ends.
4. After the visible panes settle, run **Searchlight: Export Startup Diagnostics** and choose a
   JSON file outside the repository. Also export during a stall: pending spans and unacknowledged
   pane deliveries are included.
5. Repeat several times for both cold launches and warm reloads. Compare median/range rather than
   one run; the extension cannot determine OS/antivirus cache warmth automatically.

The export is a snapshot, not a background log file. It includes environment/settings metadata,
milestones, inclusive operation aggregates, outstanding spans, pane visibility/readiness, and the
last 10,000 records. `droppedRecords` tells you when older records were evicted; first milestones
and span aggregates remain available. Outstanding spans are capped at 1,024, with overflow reported
as `droppedPendingSpans`. Turning logging on midway produces a partial capture, identified by
`logging.resumed` and `continuousCapture: false`; reload for a complete startup baseline.

The export also includes [local feature usage](usage-diagnostics.md), which is enabled separately
and automatically recorded in `[usage]` output lines. Activation now supports inline discussions
before a sidebar visit. Heavy comparison work begins at `startup.comparisonRequested`, not
necessarily immediately after activation; use that milestone to separate user delay from loading.

## Which metric answers which question?

| Question | Signal |
|---|---|
| When did activation stop blocking VS Code? | `activation.return` (activation-relative `atMs`) |
| When was the initial comparison resolved? | `startup.comparisonResolved`, including ready/unselected/error outcome |
| When did background initialization finish? | `startup.backgroundComplete`; includes subscriptions/watch setup, **not** pane completion |
| When did each pane first render anything? | `<pane>.firstDom`; placeholders are explicitly labeled |
| When was resolved content available? | `<pane>.contentReady`; distinguishes populated content, empty UI state, and explicit error state |
| When did the browser have a paint opportunity? | `<pane>.contentPaintOpportunity`; two animation frames after DOM work |
| Is the panel currently ready? | Exported `panes.views` and `allCurrentlyVisiblePanesReady`; `null` when none are visible |
| What was expensive? | Nested `start`/`end` spans, `durationMs`, `parentId`, per-label aggregates |
| Is a dependency hung or merely slow? | Start without end, exported `pending` with elapsed duration |
| Did refresh storms repeat work? | `refresh.request`, `refresh.dispatch`, `refs.refreshRequested`, cache events, comment coalescing/queue events |
| Did host contention overlap the delay? | `host.sample`: event-loop lag, process CPU delta, RSS/heap, once per second for the first minute |

Pane names are `comparison`, `files`, `commits`, and `conversations`. All four use the same protocol.
`<pane>.state` covers data retrieval and state construction; `.build` (where present) covers
construction rather than data loading. `.serialize` counts actual UTF-8 bytes of the message,
`.postMessage` measures host submission, and `.render` measures client-side DOM work.
`roundTripMs` includes host serialization/submission, delivery, client work and acknowledgement.
There is no assumed shared clock between the extension host and webviews.

Request IDs pair state delivery with acknowledgements. Superseded acknowledgements do not establish
content readiness. Visibility and webview generation are recorded; hidden/collapsed panes are not
forced to load for measurement. A pane opened later has a later activation-relative readiness time,
so compare `sinceViewResolveMs` as well. Unacknowledged messages are bounded to 64 per pane; eviction
is recorded explicitly. Empty or error outcomes count as *settled*, not as a successful review.
An empty UI can still result from a pre-existing fallback: inspect its parent request's dependency
errors/fallback events before treating it as evidence that no files or reviews exist.

## Dependency and scheduling breakdown

- `comparison.catalogCache` reports `miss`, `join` (shared in-flight request), or `hit` (retained
  catalog). `comparison.catalogInvalidated` records invalidation, and `comparison.stateDiscarded`
  records an overtaken state build. Startup view resolution, client readiness and initialization
  refreshes share enumeration; comments and working-tree-only Git API notifications reuse it.
  Manual refresh, Git actions, actual API ref changes and filesystem ref events reload the catalog.
  Invalidating an in-flight load queues a replacement after it finishes rather than overlapping
  another scan. Windows native/Git path spellings share the same cache entry.
- Git subprocess spans report command categories, safe option names, shell/execFile execution and
  success/failure codes. Raw arguments, paths, branch names, SHAs, stdout and stderr are not captured.
  Existing fallback behavior is preserved and diagnosed separately.
- `git.branchCatalog` reports `refCount`, `branchCount`, `shortenedByGit`, and `rootRefsIncluded`.
  The bulk query uses raw ref names rather than `%(refname:short)` and checks possible collisions
  in memory. Only exceptions use Git's shortening logic, preserving its ambiguity settings.
  Older Git versions without root-ref enumeration conservatively shorten simple names via Git;
  the capability fallback is logged once. The catalog output limit is 16 MiB and errors are
  reported rather than silently truncating results.
- Git API initialization, cache decisions and API/CLI selection distinguish waiting for
  `vscode.git` from running a Git subprocess.
- Comparison defaults, baseline resolution, branch listing and staleness are timed independently.
- Review discovery, file reads and parsing expose counts and missing/invalid/error outcomes.
  `reviews.readDirectory` visits only the review-storage subtree. `reviews.discovered` reports
  file/directory counts and skipped linked directories. `reviews.discoveryCache` distinguishes
  a new walk from an in-flight join; `reviews.discoverWait` measures that shared wait. No completed
  discovery cache delays newly created reviews, and caller review models remain independent.
- Files/commits query spans and cache decisions distinguish fresh work from reuse. Live
  uncommitted state is separately timed.
- Inline comments record the editor/timeout deferral trigger, actual deferred wait, debounce wait,
  coalescing, queued reconciles, thread churn and first completion. Status-bar loading is timed too.

Trace spans are **inclusive and may overlap**. Never add their durations to calculate startup time.
Use milestone `atMs` for elapsed latency and parent/child spans to explain it. A Git exit code can be
an expected negative query result (for example, an ancestry check), not necessarily a product error.

## Limits and overhead

`contentPaintOpportunity` is deliberately not called "first paint": animation frames cannot prove
that the compositor presented pixels, and background webviews may throttle them. DOM readiness
remains separately observable. The old `firstPaint` label has been removed because it could measure
only a loading placeholder.

The host CPU/memory/event-loop samples belong to the **whole extension-host process**, including
other extensions; they cannot attribute CPU usage to Searchlight or prove an antivirus cause.
These timings start at `activate()`, not at VS Code process creation or module loading. Pair the
capture with **Developer: Startup Performance**, **Developer: Show Running Extensions** and an
extension-host profile for those costs. OS tracing is needed to establish Defender/I/O causality.

Logging itself has cost, including output writes and one extra serialization to measure message
size. Disable it for an uninstrumented comparison. No extra Git commands or review scans are issued
for diagnostics; no benchmark runs automatically. Diagnostic errors record type/code rather than
raw messages, and payloads record byte/count metadata rather than file or review contents.
