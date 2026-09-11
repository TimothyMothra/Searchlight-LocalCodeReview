# Searchlight: Local Code Review — Knowledge Base

**Searchlight: Local Code Review** is a VS Code extension for reviewing local git branch diffs the
way you'd review a pull request — but entirely offline, with review comments stored as plain JSON on
disk. It adds a four-view "PR panel" (Comparison, Commits, Changed Files, Threads), native
inline comment threads, `/tag` classification, and a one-click **Ask Copilot** bridge that hands a
review thread to the `copilot` CLI so an agent can reply in-thread and stamp its identity.

> **Status:** local-only, single-developer tool. Published for reference; not on the Marketplace.
> The extension **never calls a model directly** — all AI work happens through an external
> `copilot` CLI shell-out. Storage lives under `.vscode/searchlight-reviews/` and is a superset of,
> and never clobbers, the original `Gururagavendra.local-pr-review` format.

## Documents

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | Ownership split, the four views, activation fast-return, CommentController, the Ask-Copilot bridge, data flow, key decisions, known constraints |
| [data-model.md](data-model.md) | On-disk layout (`registry.json` + `comments.json`), the v2 schema, v1 back-compat rules, the tag set, durable `seqCounter`, `reviewedFiles` |
| [engineering.md](engineering.md) | Prerequisites, build/package/deploy commands, VM verification (Hyperloop + PrintWindow), the no-shell git helpers, commit conventions, known constraints |

For startup performance work, see [Startup diagnostics](startup-diagnostics.md): capture/export
workflow, readiness milestones, dependency spans, timing semantics and limitations.
For feature adoption and Source Control/discussion workflows, see
[Local feature usage](usage-diagnostics.md).

The default layout keeps Comparison and Commits collapsed at the top, expands all folders in
Changed Files initially, and hides resolved threads. Saved VS Code pane layouts and explicit
Show Resolved choices are preserved. The all-changes diff command remains available in the Command
Palette, but is no longer a Changed Files toolbar button.

Use **New Thread** in Threads for review-wide messages without a code location.
**Read** opens a formatted discussion page with replies and explicit Copilot controls, while
ordinary clicks on code-linked discussions still navigate to code.

Thread-page buttons pair a decorative icon with a visible title. Resolve/Reopen share the pane's
checkbox icons; Refresh uses a circular arrow. Agent metadata stays inline with the author name.
Existing `conversation`-named command IDs, settings and storage remain compatible.

## 30-second orientation

- **One extension, two owners.** The extension owns the UI and *writes* `comments.json`. An
  **external** Copilot agent (the `copilot` CLI) *reads* that JSON, replies in-thread, and stamps an
  identity block. The extension is never an AI client.
- **Everything is a file.** A "review" is a `comments.json` under `.vscode/searchlight-reviews/`.
  There is no server, database, or network dependency.
- **A comparison = base + compare.** `base` is the TARGET branch, `compare` is the SOURCE branch
  under review. A separate **effective baseline** is inferred from local/upstream shared ancestry
  or pinned to an explicit ancestor commit. The Comparison pane shows its SHA and reason, with
  **Pin commit...** and **Auto** controls. The four views all read one `ActiveComparison`.
- **The model layer is `vscode`-free.** `reviewModel.ts` has no `vscode` import so the schema and
  its migrations are unit-testable in isolation; callers wrap its outputs with VS Code types.
- **Writes are lazy + diff-friendly.** `comments.json` is created on the first mutation (a comment
  or a reviewed-file checkbox), serialized as pretty-printed v2 with a trailing newline.

## Fastest commands

```powershell
# From the repo root: C:\REPOS\searchlight-localcodereview
npm install
npm run compile                 # tsc -> out/
npx @vscode/vsce package        # (re)build the gitignored searchlight-0.0.1.vsix
scripts\deploy-local.ps1        # sideload local.searchlight@0.0.1 into your VS Code
# then: Reload Window
```
