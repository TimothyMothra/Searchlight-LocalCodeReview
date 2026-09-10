# Architecture

Searchlight: Local Code Review is a single VS Code extension (TypeScript, compiled to
`out/extension.js`). It presents a four-view "pull-request panel" over a **local** git branch
comparison and persists review comments as JSON on disk. This document describes how the pieces fit
together and why.

## 1. Design goals

1. **PR-style review with zero backend.** Everything is local: local branches, local diffs, review
   comments as files. No server, no auth, no network round-trip to review code.
2. **Copilot is an external collaborator, not an embedded model.** The extension writes a
   well-defined schema; a separate `copilot` CLI agent reads it, replies, and stamps identity. The
   extension holds no API keys and never issues a model call.
3. **Never clobber the original.** The schema is a backward-compatible superset of
   `Gururagavendra.local-pr-review`, but Searchlight writes to its **own** storage path
   (`.vscode/searchlight-reviews/`) so both extensions can coexist.
4. **Fast activation.** Windows Defender scans `git.exe` on each spawn during the startup burst
   (measured tens of seconds). Activation must return before doing git work.
5. **Testable core.** The data model is `vscode`-free so schema parsing and migrations can be unit
   tested without the extension host.

## 2. Module graph

```
extension.ts ............ activation, view wiring, command registration, Ask-Copilot bridge
  │
  ├─ activeComparison.ts . ActiveComparison — the single source of truth (base + compare + review)
  │      ├─ baseline.ts ... read-only ancestry resolution and explicit baseline-pin validation
  │      ├─ git.ts ........ no-shell git helpers (changedFiles, logRange, aheadBehind, worktrees)
  │      ├─ gitApi.ts ..... thin wrapper over the built-in vscode.git extension API
  │      └─ reviewStore.ts  load/serialize/mutate comments.json (+ durable seqCounter)
  │             └─ reviewModel.ts .. vscode-free schema types, parse, normalizeSeq, formatTimestamp
  │
  ├─ comparisonView.ts .... WebviewView: inline base/compare selector + per-row Pull/Update
  ├─ filesView.ts ......... TreeView: changed files (folder tree, reviewed-file checkboxes)
  ├─ commitsView.ts ....... TreeView: commit list, click = per-commit multi-file diff
  ├─ conversationsView.ts . TreeView: reviews -> threads -> comments, jump to file:line
  ├─ commentController.ts . native vscode.comments threads (inline gutter UI)
  ├─ reviewDiff.ts ........ ReviewDiffContentProvider serving historical blobs for diffs
  ├─ tagCompletion.ts ..... /tag CompletionItemProvider for the comment input
  ├─ statusBar.ts ......... active-review status bar item
  └─ perf.ts .............. [perf] OUTPUT-channel timing helpers
```

## 3. The four views

The activity-bar container `searchlight` hosts four views, all reading from one `ActiveComparison`
supplied via a `() => active` getter:

| View | id | Kind | Role |
|------|----|------|------|
| Comparison | `searchlight.comparison` | **WebviewView** | Inline base/compare branch selector + per-row Pull/Update (FF-only) |
| Changed Files | `searchlight.files` | TreeView | Folder tree of changed files; checkboxes mark `reviewedFiles`; expand/collapse-all |
| Commits | `searchlight.commits` | TreeView | Commit list; click = that commit's diff; "View All Changes vs Base"; copy-SHA secondary |
| Conversations | `searchlight.conversations` | TreeView | reviews -> threads -> comments; click jumps to `filePath:startLine` |

**Why Comparison is a webview and the other three are TreeViews.** The Comparison view originally
used a two-row TreeView whose rows fired `showQuickPick()`. The resulting top-center popup was
routinely mistaken for the Command Palette / search bar. Replacing it with a `WebviewViewProvider`
that renders two `<input>` + filterable-dropdown fields *in place* removed the popup entirely. The
other three views are naturally hierarchical and use the native TreeView for free
expand/collapse/checkbox behavior.

## 4. The active comparison (single source of truth)

`ActiveComparison` (activeComparison.ts) holds `base`/`compare` branch names, their resolved commit
shas, a separate effective `baselineCommit`, the current HEAD, the resolved `reviewDir` +
`sourceFile` path, and the in-memory `Review`.
All four views and the CommentController read from it, so a single `refreshAll()` keeps everything
consistent.

- `base` = TARGET branch → maps to `review.targetBranch`.
- `compare` = SOURCE branch under review → maps to `review.sourceBranch`.
- `changedFiles` / `logRange` results are memoized keyed by the effective baseline/compare commit pair, so re-renders
  don't re-shell git.
- The review file is created **lazily**: only a mutation (a reviewed-file checkbox toggle or a
  comment add/reply) persists `comments.json`.

### Target branch vs. effective baseline

The **Target branch** identifies the intended destination and continues to identify the review.
The **Effective baseline** is the exact commit used on the left of branch-review diffs:

- **Auto:** for a local target, consider that ref and its configured upstream. When no upstream is
  configured, also consider an existing matching `origin/<target>` ref. Choose the most advanced
  shared ancestor with the compare commit **by ancestry**, never by timestamp. Equal ancestors
  retain the selected target as the explanation source. An explicitly selected remote-tracking
  target uses only that ref.
- **Pin commit...:** enter an ancestor commit SHA. It is resolved to a full ID and persisted per
  target/source pair in VS Code workspace state. **Auto** clears the pin. Pins survive reloads
  and target updates, but a rebase that makes the pin cease to be an ancestor blocks comparison
  until the user clears or replaces it.
- Missing refs, no shared ancestry, multiple merge-bases, and incomparable candidate baselines
  are visible errors, not empty successful comparisons or fallbacks to the target tip.

The pane shows the baseline SHA, auto/pinned mode, and the selection reason. Target selections are
remembered per source branch in workspace state; review folder names and `comments.json` target
identity do not change when Auto chooses an upstream's shared ancestor.

This handles both an advancing main branch (the shared ancestor stays put) and a rebased source
with stale local main (a newer upstream ancestor can win). It does not guess a feature branch's
parent from unrelated branch names or fetch automatically. If all available refs are stale, fetch
explicitly or pin the intended ancestor.

Committed file lists and commit ranges use the resolved baseline/compare SHAs. Cumulative lists
use baseline vs. working tree plus untracked files. Single-file and **View All Changes** diffs use
the same baseline; the latter includes cumulative/untracked changes when cumulative mode is on.
Uncommitted SCM-group diffs and individual-commit diffs retain their index/HEAD/parent semantics.

Resolution refreshes on Git API state events, manual Refresh, and filesystem events for the actual
worktree HEAD and shared loose/packed refs. This includes ref changes made from another worktree.
Overtaken resolutions/results are discarded so an older query cannot replace a newer selection.

## 5. Activation flow (fast-return pattern)

`activate()` (extension.ts) deliberately does **no awaited git work**:

1. Create the Searchlight OUTPUT channel, `initPerf`, and the `ReviewStatusBar`.
2. Construct `ActiveComparison(wsFolder, wsFolder)` with a **placeholder** repo root.
3. Construct `SearchlightCommentController` with a `() => active` getter (so a first-ever thread can
   target the active comparison before any `comments.json` exists).
4. Register the four providers, all reading `() => active`.
5. Register `ReviewDiffContentProvider` on the diff scheme, `registerTagCompletion()`, the file
   watcher, and ~40 commands.
6. Kick off a **background IIFE** that resolves the real repo root, computes default branches,
   resolves the comparison, and calls `refreshAll()`.

This ordering exists because on Windows, git spawns during the startup burst are each scanned by
Defender; awaiting them in `activate()` measured tens of seconds of dead time. Returning first and
doing git work in the background keeps the panel responsive.

`refreshAll()` refreshes all four providers, re-renders the CommentController from disk, and updates
the status bar.

## 6. CommentController (inline threads)

`commentController.ts` renders every thread from every `comments.json` as a native
`vscode.comments` thread anchored at `filePath:startLine`. It supports:

- **Reply** → writes a v2 comment with `replyTo`.
- **New thread** on any line → writes a v2 thread (falls back to the active comparison so the very
  first comment works before any file exists on disk).
- **Resolve / unresolve** → in-place update of `thread.state` (tracked separately so it's an update,
  not a dispose+recreate).
- **`/tag` tokens** in the reply box → merged into the thread's `tags[]` on submit.

It re-renders from disk on demand, so the file watcher can call it after **any** external change —
including this extension's own writes and the `copilot` CLI shell-out.

## 7. The Ask-Copilot bridge (schema → agent contract)

This is the only "AI" path, and it is a shell-out, not a model call (`askCopilot` in extension.ts):

```
reads config: copilotPath (default "copilot"), copilotArgs (default ["-p"])
builds a prompt: "Respond to local review thread <id> in <reviewDir>. Read comments.json,
                  reply in-thread per the schema (v2: author object, tags[], replyTo),
                  stamp your identity as ~Written by 🤖 Copilot, and set thread state appropriately."
opens an integrated terminal "Searchlight · Copilot" with cwd = reviewDir
terminal.sendText(<cliPath> <args> <prompt>)
```

The agent already understands the schema (via a personal Copilot instruction file). It edits
`comments.json`; the file watcher then reloads and re-renders the thread with the identity-stamped
reply. **No LM API, no keys, no in-extension model call.**

## 8. Data flow

```
 branch pick (webview)          reviewed-file checkbox / comment add/reply
        │                                     │
        ▼                                     ▼
  ActiveComparison.resolve()          reviewStore.saveReview()  ──writes──► comments.json
        │  (memoized git)                     │                                   │
        ▼                                     ▼                                   │ file watcher
   refreshAll() ──────────────► 4 providers + CommentController.render() ◄────────┘
                                                     ▲
                                     Ask Copilot ────┘ (external CLI edits comments.json)
```

## 9. Key design decisions & rationale

| Decision | Rationale |
|----------|-----------|
| External agent, not embedded model | No keys/telemetry in the extension; the schema is the whole contract; the agent side already exists |
| Own storage path `.vscode/searchlight-reviews/` | Coexist with the original `local-pr-review` without clobbering its `.vscode/local-reviews/` |
| `vscode`-free `reviewModel.ts` | Unit-test the schema + `normalizeSeq` migration without the extension host |
| Fast-return activation + background git | Defender-scanned git spawns made awaited activation take tens of seconds |
| Durable `seqCounter` for thread `#NN` ids | A transiently-empty in-memory review must not reset/reuse a display id; monotonic counter fixes it |
| Comparison as webview, others as TreeView | Kill the QuickPick-mistaken-for-search-bar popup; keep native tree ergonomics elsewhere |
| No-shell git helpers (`listWorktreesCli`) | Avoid flashing shell windows and reduce spawn cost on the hot path |
| Lazy, diff-friendly writes | Don't create files until there's content; 2-space indent + trailing newline keeps git diffs clean |

## 10. Known constraints

- **Locally available refs only.** Local and remote-tracking branches are supported, but there is
  no remote PR integration (GitHub/ADO) or automatic fetch during baseline resolution.
- **Per-row Pull/Update is FF-only.** It fetches and fast-forwards a stale local branch to its
  upstream; if not fast-forwardable it warns and does nothing (never merges or rebases). No push.
- **Single workspace folder assumed** for the review store location.
- **The agent round-trip requires the personal instruction file** to also read
  `.vscode/searchlight-reviews/` (a superset of the original `.vscode/local-reviews/` guidance).
