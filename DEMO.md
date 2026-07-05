# Searchlight: Local Code Review — Demo Guide

This document is the repeatable demo path for the **Searchlight: Local Code Review** VS Code
extension (v1 MVP). It covers two ways to run the demo:

1. **Extension Development Host (F5)** — no packaging needed, fastest inner-loop.
2. **Sideload the packaged `.vsix`** — how you'd demo on a clean machine / VM.

> **VM note:** the `hyperloop` CLI is **not installed** on this build box, so the automated
> VM sideload could not be exercised here. The `.vsix` was instead **smoke-tested against the
> local `code` CLI** (install → list → uninstall, all exit 0 — see *Smoke-test evidence* below),
> and the manual VM steps are documented in *Option C* so the demo is fully reproducible.

---

## What the demo shows

The extension renders **local self-review comment threads** — JSON stored on disk under
`.vscode/searchlight-reviews/<src>_<tgt>/comments.json` — as **native inline VS Code comment
threads** in the editor gutter, plus a **PR-review sidebar panel** (four stacked views:
**Comparison**, **Changed Files**, **Commits**, **Conversations**). It supports reply, resolve/
unresolve, `/tag` autocomplete, copy commands, and an **Ask Copilot to review** trigger that
shells out to the `copilot` CLI (the extension never calls a model itself).

### The four-view panel

The `searchlight` activity-bar container now hosts four native TreeViews driven by a single
in-memory **active comparison** (`base` = target branch, `compare` = source branch under review):

| View | Shows |
|------|-------|
| **Comparison**   | The current `Base` / `Compare` branches — click a row to pick, `⇄` to swap |
| **Changed Files** | Hierarchical folder tree of `git diff base...compare`, with per-file reviewed checkboxes; click opens a native diff |
| **Commits**       | `git log base..compare` — click copies the full SHA |
| **Conversations** | Comment threads for the active review — click jumps to `file:line` |

Defaults on activation: `base` = local `main` (else the remote default), `compare` = current HEAD
branch. The on-disk `comments.json` is only created on the first mutation (a reviewed-file toggle
or a comment), so empty repos stay clean.

### The bundled fixture

`.vscode/searchlight-reviews/main_feature/comments.json` (schema **v2**) contains **2 threads**:

| Thread | Anchor (`filePath:startLine`) | State | Tags | Contents |
|--------|-------------------------------|-------|------|----------|
| `t-1`  | `SCOPING.md:17`               | unresolved | `question`, `change` | human comment + threaded 🤖 Copilot agent reply (`replyTo: c-1`) |
| `t-2`  | `README.md:1`                 | resolved   | `nit`, `praise`      | single human comment |

Both anchor files (`SCOPING.md`, `README.md`) exist at the repo root, so both threads render.

---

## Screenshot dataset — `scripts\demo-setup.ps1` (one command)  📸

To capture the README screenshot (`docs/images/screenshot.png`) from a clean, **PII-free** dataset,
generate a self-contained throwaway demo repo instead of using this repo's own fixture:

```powershell
# 1. Install the extension into local VS Code (compile + package + install)
pwsh -File scripts\deploy-local.ps1

# 2. Generate the throwaway demo repo (defaults to %TEMP%\searchlight-demo)
pwsh -File scripts\demo-setup.ps1 -Force

# 3. Open the generated demo folder in VS Code
code "$env:TEMP\searchlight-demo"
```

The generated repo has a `main` base branch and a `feature/demo` compare branch with **2 commits**
across **nested folders** (`src/api/`, `src/utils/`, `src/components/`, `tests/api/`) and a seeded
**v2** review under `.vscode/searchlight-reviews/feature-demo_main/` — so all four panes populate:

| Pane | What shows in the demo |
|------|------------------------|
| **Comparison**    | `Base: main` / `Compare: feature/demo` |
| **Changed Files** | Folder tree: `src/api/{handlers,routes}.ts`, `src/utils/format.ts`, `src/components/Button.tsx`, `tests/api/handlers.test.ts` |
| **Commits**       | The 2 `feature/demo` commits |
| **Conversations** | 3 threads — the **`src/api/handlers.ts` `[bug]` thread** has a human comment + a threaded 🤖 Copilot agent reply |

**To frame the screenshot:** in the demo window, open the Searchlight panel and compare
`feature/demo → main`. Open **`src/api/handlers.ts`** so the inline **`[bug]` thread** (human
comment + Copilot reply) is visible, with the four-view sidebar panel showing alongside. Then save
the capture to **`docs/images/screenshot.png`** in *this* repo (the README references that path).

All seeded content is synthetic — neutral author names (`reviewer`, agent `Copilot`) and generic
widget-service code — so the screenshot contains **no PII or proprietary content**. The demo repo is
external (under `%TEMP%`), so running the script never dirties this worktree.

---

## Option A — Extension Development Host (F5)  ⭐ recommended

1. Open this repo folder in VS Code:
   `C:\REPOS\searchlight-localcodereview\` (or this worktree).
2. `npm install` then `npm run compile` (both should already be green).
3. Press **F5** (Run → Start Debugging). This uses `.vscode/launch.json` to launch a second VS
   Code window (the **Extension Development Host**) with the extension loaded.
4. In that new window, **File → Open Folder** and pick this same repo (so the
   `.vscode/searchlight-reviews/` fixture is present).

### What to look for

- **Local Reviews** view in the Activity Bar / Explorer — lists the `main_feature` review and its
  two threads.
- Open **`SCOPING.md`** → an **inline comment thread appears at line 17** (`t-1`) showing the
  human question and the 🤖 Copilot agent reply. Open **`README.md`** → the resolved `t-2` thread
  at line 1.
- **Reply** in a thread's reply box → the reply is written back to `comments.json` as a v2 comment
  with an `author` object `{kind:"human", name:<git user.name>}` and a `replyTo` pointing at the
  parent comment. The file watcher re-renders the thread.
- **Resolve / Unresolve** from the thread context menu → `state` flips in `comments.json`.
- **`/tag` autocomplete** — type `/` in a comment/reply box → completion list offers
  `idea question bug change todo nit praise` (configurable via the `searchlight.tags` setting).
- **Copy commands** (Command Palette or thread menu): *Searchlight: Copy Commit Id / Copy Branch
  Name / Copy Dir Path* → value lands on the clipboard.
- **Ask Copilot to review** (thread title or review command) → opens an integrated terminal in the
  review dir and runs the configurable `copilot -p "…"` command. The extension only shells out —
  it never calls a model directly. When the CLI writes back to `comments.json`, the watcher
  reloads and re-renders.

---

## v1.5 features — git & directory integration

v1.5 adds Git/worktree one-clicks. They prefer the built-in **vscode.git** extension API
(`getAPI(1)`) and fall back to the `git` CLI when the API can't cover a case. Exercise them from the
**Extension Development Host (Option A)** against a repo checkout:

- **Branch / remote pickers** — Command Palette → *Searchlight: Pick Branches for Review* (or the
  review node's context menu). A QuickPick lists local + remote refs (from the vscode.git API);
  choose a **source** then a **target**. The choice is persisted into the review's `comments.json`
  header (`sourceBranch` / `targetBranch` / `sourceCommit` / `targetCommit`) via the v2 writer, and
  the status bar updates. *Searchlight: Switch Active Review* switches which review is active.
- **Worktree-aware Open Directory** — review node context menu → *Searchlight: Open Directory*.
  Detects (via `git worktree list --porcelain`) whether the review's branch is checked out in a
  local worktree; if so it offers **Open Folder (new window)** or **Reveal in OS**. If the branch is
  not checked out anywhere, it says so gracefully.
- **Git pull / push** — view title bar buttons (⬇ / ⬆) or *Searchlight: Git Pull* / *Git Push*.
  Runs the vscode.git API `.pull()` / `.push()` (CLI fallback) inside `window.withProgress`, with
  success/error notifications. Push guards against detached HEAD; both guard against no-repo.
- **Open terminal here** — review node context menu → *Searchlight: Open Terminal Here*. Opens an
  integrated terminal with `cwd` set to the review dir (else repo root, else first workspace folder).
- **Status-bar active-review switcher** — a status-bar item shows the active review as
  `$(git-pull-request) src → tgt`. Click it to run *Switch Active Review*. It updates on activation,
  on switch, and whenever the `comments.json` watcher fires; it hides when there is no review.

The extension's hard rule is unchanged: it **never calls a model** — Copilot is only ever invoked as
an external CLI via *Ask Copilot to review*.

---

## Option B — Sideload the packaged `.vsix`

Build (already produced): `searchlight-0.0.1.vsix` (13 files, ~21 KB).

```powershell
# from the repo root
npx @vscode/vsce package --allow-missing-repository --no-dependencies   # (re)build the vsix
code --install-extension searchlight-0.0.1.vsix                         # sideload it
# open a folder that contains .vscode/searchlight-reviews/<...>/comments.json, then verify as in Option A
code --uninstall-extension local.searchlight                            # clean up when done
```

### Local install (one command)

Build and install into local VS Code in one step:

```powershell
pwsh -File scripts/deploy-local.ps1              # compile + package + install
pwsh -File scripts/deploy-local.ps1 -InstallOnly # just reinstall the existing .vsix
```

Then run **Developer: Reload Window** in VS Code to pick up the new build.

---

## Option C — VM sideload via hyperloop (documented; not run here)

`hyperloop` was unavailable on this box. On a machine where it is installed:

```powershell
# 1. copy the vsix into the test VM
hyperloop copy-file <vm> --path "C:\REPOS\searchlight-localcodereview\searchlight-0.0.1.vsix" `
    --direction tovm --name searchlight-0.0.1.vsix

# 2. install it into the VM's VS Code and open a fixture workspace
hyperloop shell <vm> --script "code --install-extension `$env:USERPROFILE\...\searchlight-0.0.1.vsix"
hyperloop shell <vm> --script "code C:\path\to\workspace-with-searchlight-reviews"

# 3. capture a screenshot as demo evidence
hyperloop window <vm> --action list --filter Code    # find the VS Code hwnd
# screenshot the window and save under docs/images/
```

Save the resulting screenshot to `docs/images/screenshot.png` in this repo as the demo artifact.

---

## Smoke-test evidence (this box)

The packaged `.vsix` was validated end-to-end against the local `code` CLI:

```text
> code --install-extension searchlight-0.0.1.vsix
Extension 'searchlight-0.0.1.vsix' was successfully installed.        # exit 0

> code --list-extensions | Select-String searchlight
local.searchlight                                                     # present

> code --uninstall-extension local.searchlight
Extension 'local.searchlight' was successfully uninstalled!           # exit 0
```

This confirms the manifest is valid and the extension installs, is discovered by VS Code, and
uninstalls cleanly. Full interactive UI verification is done via **Option A (F5)**.

---

## Configuration reference

| Setting | Default | Purpose |
|---------|---------|---------|
| `searchlight.tags` | `["idea","question","bug","change","todo","nit","praise"]` | Tags offered by `/tag` autocomplete |
| `searchlight.copilotPath` | `copilot` | CLI invoked by *Ask Copilot to review* |
| `searchlight.copilotArgs` | `[]` | Extra args prepended to the `copilot` invocation |
| `searchlight.defaultRemote` | `""` | Default remote name for *Git Push* (empty = let git choose the upstream) |
