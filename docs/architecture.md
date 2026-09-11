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
  ├─ conversationDocument.ts . read-only virtual conversation tabs, independent of code files
  ├─ conversationModel.ts .... full transcript formatting and stable conversation references
  ├─ conversationPage.ts ..... formal discussion pages, composers and explicit Copilot actions
  ├─ conversationPageStore.ts  scoped references, draft seeds and guarded review mutations
  ├─ conversationPageModel.ts  lazily loaded safe Markdown rendering and page state
  ├─ conversationPageHtml.ts . themed conversation workspace and draft-preserving client
  ├─ commentController.ts . native vscode.comments threads (inline gutter UI)
  ├─ reviewDiff.ts ........ ReviewDiffContentProvider serving historical blobs for diffs
  ├─ tagCompletion.ts ..... /tag CompletionItemProvider for the comment input
  ├─ statusBar.ts ......... active-review status bar item
  ├─ perf.ts .............. [perf] OUTPUT-channel timing adapter
  ├─ diagnostics.ts ....... monotonic, correlated, bounded local startup trace
  ├─ webviewMetrics.ts .... state delivery / DOM readiness / paint-opportunity protocol
  ├─ usage.ts ............. bounded local feature-action and exposure summaries
  └─ usageContext.ts ...... privacy-preserving editor-context classification
```

## 3. The four views

The activity-bar container `searchlight` hosts four views, all reading from one `ActiveComparison`
supplied via a `() => active` getter:

| Order | View | Default | Role |
|-------|------|---------|------|
| 1 | Comparison (`searchlight.comparison`) | Collapsed | Inline branch selectors and Pull/Update controls |
| 2 | Commits (`searchlight.commits`) | Collapsed | Commit/file inspection and copy-SHA |
| 3 | Changed Files (`searchlight.files`) | All folders initially expanded | Changed files and reviewed-file checkboxes; no all-changes toolbar button |
| 4 | Threads (`searchlight.conversations`) | Resolved threads hidden | Inline-code navigation, Read thread, resolve/reopen controls |

All four are WebviewViews. The Comparison view originally
used a two-row TreeView whose rows fired `showQuickPick()`. The resulting top-center popup was
routinely mistaken for the Command Palette / search bar. Replacing it with a `WebviewViewProvider`
that renders two `<input>` + filterable-dropdown fields *in place* removed the popup entirely.

Manifest collapse/order defaults do not override layouts VS Code already remembers for a workspace.
Changed Files applies initial expansion once per webview, preserving subsequent folder choices
across refreshes; its Expand All command remains available. Conversations retains an explicit
Show Resolved choice across reloads. `searchlight.commitsViewAllChanges` remains a Command Palette
action even though its Changed Files toolbar button was removed.

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
- The Comparison pane shares an in-flight branch-catalog request and retains its completed result
  across selection/review/worktree-only refreshes. Ref changes, explicit refresh and Git operations
  invalidate it. HEAD and staleness remain live; overtaken state builds never post an older selection.
  CLI enumeration reads full refs once and performs ambiguity checks in memory. Only collisions
  need Git's short-ref disambiguation, in bounded batches. Empty/failure results are not retained.
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
6. Leave heavy comparison initialization **deferred** until a pane, comparison command, or new
   inline discussion needs it. Concurrent requests share initialization of the repo root,
   defaults, comparison, subscriptions and first refresh.

`onStartupFinished` activation makes inline discussions available in ordinary and Source Control
editors without opening Searchlight. Existing threads/replies do not require comparison Git work.
Usage observation starts here too, independently of performance logging; it records fixed feature
labels and editor categories, never user content. See [Local feature usage](usage-diagnostics.md).

This ordering exists because on Windows, git spawns during the startup burst are each scanned by
Defender; awaiting them in `activate()` measured tens of seconds of dead time. Returning first and
doing git work in the background keeps the panel responsive.

`refreshAll()` refreshes all four providers, re-renders the CommentController from disk, and updates
the status bar.

Review discovery walks only each workspace's `.vscode/searchlight-reviews` subtree, not the
workspace search index. Simultaneous discovery requests share the in-flight directory walk;
completed results are not cached, and each caller still parses independent review objects.
Missing stores are empty; other filesystem errors propagate. Linked directories are not traversed
(to avoid escaping the store or following cycles), and their count is recorded in diagnostics.

Activation return, background completion and visible content readiness are separate milestones.
Every pane (including Comparison) reports DOM completion and a subsequent paint opportunity,
distinguishing placeholders from resolved content, empty states and errors. Git/API/storage spans
and refresh causes are correlated under the initiating operation. The export command snapshots the
local trace without waiting for pending work. See [Startup diagnostics](startup-diagnostics.md).

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

### Thread workspace and review-wide topics

The Threads title bar and empty state offer **New Thread**. It opens a draft attached
to the current branch review, not a code location. Nothing is written until the first message is
posted. These topics have an optional subject and omit `filePath`, line ranges and anchors entirely;
they are not fake comments on line zero. Existing inline comments remain code-linked.

User-facing entity names are consistently Thread/Threads. Existing internal conversation IDs
are retained so saved layouts, commands, references and telemetry remain compatible. Buttons show
an icon followed by their visible label; decorative SVGs are hidden from assistive technology.

Clicking a code-linked thread/reply still navigates to code. **Read**, or clicking a review-wide
topic, now opens a dedicated WebviewPanel rather than Markdown source. The page shows formatted
messages/code blocks, human/agent attribution, a reply composer, Resolve/Reopen and explicit
Ask Copilot controls. Saved code context is optional; missing/deleted/uncommitted files never
prevent reading or replying. The saved anchor is not presented as a reconstructed historical file.

**Post** saves locally; **Post & Ask Copilot** saves first, then launches the existing external CLI.
No model runs automatically and no streaming response is fabricated. External saved replies update
the open page without replacing the draft. Resolved threads are not silently reopened by replies.
Draft text is kept in the panel's local VS Code webview state; restored pages retain their original
review identity even if a different branch is now active.

Page writes are queued per review, reload current data, and check for observed external edits
immediately before writing. Conflicts retain the draft rather than overwriting the observed edit.
VS Code's file API does not offer cross-process compare-and-swap, so this is not a transactional
lock against arbitrary external writers. Invalid/missing existing review data is never replaced
with an empty review. First messages create missing review directories lazily.

Markdown rendering is loaded only when messages need formatting. Raw HTML is disabled, remote
images are omitted, and link clicks are routed through an HTTP/HTTPS-only host handler under a
nonce-based CSP. The old read-only `searchlight-conversation` document provider remains registered
for existing/restored transcript tabs. Legacy threads without stable IDs remain readable but cannot
be mutated through the new page.

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
