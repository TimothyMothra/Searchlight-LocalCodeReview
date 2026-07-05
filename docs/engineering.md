# Engineering

How to build, package, deploy, and verify Searchlight: Local Code Review. All commands assume the
repo root `C:\REPOS\searchlight-localcodereview`.

## 1. Prerequisites

- **Node.js** 20.x (matches `@types/node ^20.11`).
- **VS Code** ≥ 1.85 (`engines.vscode ^1.85.0`).
- **`@vscode/vsce`** for packaging (a dev dependency; no global install needed).
- **git** on `PATH`.

There are **no runtime dependencies** — the shipped extension is pure VS Code API + Node stdlib.

## 2. Layout

| Path | Contents |
|------|----------|
| `src/` | TypeScript sources (see the module graph in `architecture.md`) |
| `out/` | Compiled `*.js` (gitignored build output; what VS Code actually runs) |
| `scripts/deploy-local.ps1` | Package + sideload into the host VS Code |
| `docs/` | This knowledge base |
| `package.json` | Manifest: commands, views, menus, configuration, activation |
| `tsconfig.json` | TS config (target/module, `out/` outDir) |

## 3. Build / package / deploy

```powershell
# 1. Compile TypeScript -> out/
npm run compile

# 2. Package the VSIX (rebuilds the gitignored searchlight-0.0.1.vsix, ~26 files / ~65 KB)
npx @vscode/vsce package

# 3. Sideload into the host VS Code (installs local.searchlight@0.0.1)
scripts\deploy-local.ps1
```

- `deploy-local.ps1` emits a benign `DEP0169` Node deprecation warning — ignore it.
- **Never commit `searchlight-0.0.1.vsix`** — it is gitignored build output and is rebuilt on every
  package.
- After deploying, **Reload Window** in the target VS Code to pick up the new build.

To confirm the install:

```powershell
code --list-extensions --show-versions | Select-String searchlight
# -> local.searchlight@0.0.1
```

## 4. Manifest highlights (`package.json`)

- `publisher`: `TimothyMothra`; `repository.url`:
  `https://github.com/TimothyMothra/Searchlight-LocalCodeReview.git`.
- `activationEvents`: `["workspaceContains:.vscode/searchlight-reviews/**/comments.json"]`.
- `capabilities.untrustedWorkspaces.supported`: `true` (works in Restricted Mode).
- **~40 commands** and four views under the `searchlight` container.
- Comparison title-bar order: `copyCompareBranch@1` · `copyComparePath@2` · `openTerminal@3` ·
  `refreshAll@4`.

### Configuration keys

| Key | Default | Purpose |
|-----|---------|---------|
| `searchlight.tags` | `[idea, question, bug, change, todo, nit, praise]` | `/tag` autocomplete set |
| `searchlight.copilotPath` | `"copilot"` | CLI invoked by Ask-Copilot |
| `searchlight.copilotArgs` | `["-p"]` | args prepended before the prompt |
| `searchlight.defaultRemote` | — | preferred remote for branch listing |
| `searchlight.autoCreateOnEmpty` | — | auto-create a review when none exists |
| `searchlight.perfLogging` | — | verbose `[perf]` timings to the OUTPUT channel |
| `searchlight.deferThreadsOnLoad` | — | defer CommentController render for faster first paint |

## 5. Performance notes

- **Fast-return activation.** `activate()` does no awaited git work; the real repo root + default
  resolution + `refreshAll()` run in a background IIFE. See `architecture.md` §5. Root cause: on
  Windows, Defender scans `git.exe` on every spawn during the startup burst (measured tens of
  seconds), so git must not be awaited in `activate()`.
- **No-shell git helpers ("KB-001").** `git.ts` uses `child_process` with an argv array (no shell),
  e.g. `listWorktreesCli` / `gitv`, to avoid flashing shell windows and reduce spawn overhead on the
  hot path.
- **Memoized comparison.** `changedFiles` / `logRange` results are cached keyed by the resolved
  commit pair, so view re-renders don't re-shell git.
- Turn on `searchlight.perfLogging` and watch the **Searchlight** OUTPUT channel to see `[perf]`
  timings.

## 6. VM verification (Hyperloop)

Behavioral verification is done in an isolated Windows Sandbox VM (`wsb-test`) so a flaky first
comment or a stale-branch update can be exercised end-to-end without touching the host.

- **Harness:** `$hl = "$env:LOCALAPPDATA\Hyperloop\bin\hyperloop.exe"`. `copy-file … tovm` the
  `.vsix`, install into an **isolated** `--user-data-dir` / `--extensions-dir`, launch (Escape past
  Welcome/Sign-in), then drive via keyboard verbs.
- **git in the VM** is on `PATH` via `C:\slh\tools\git\cmd`.
- **Keyboard verbs:** `hotkey --combo Ctrl+Shift+P` (key combos) and
  `type --hwnd <h> --text/--keys` (text / SendKeys). Note: `press-keys` / `type-text` are **not**
  valid verbs.
- **Screen capture:** use `PrintWindow(hwnd, hdc, 2)`. GDI `CopyFromScreen` is permanently frozen in
  a disconnected console session; `PrintWindow` bypasses the compositor and produces live captures.

## 7. Commit conventions

- **Linear history on `main`.** No merges, no feature-branch PRs for routine work.
- Every commit carries the trailer:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- **Never** stage or commit `searchlight-0.0.1.vsix` (gitignored).
- No push / PR without explicit instruction.

## 8. Dependencies & pins

| Package | Version | Why |
|---------|---------|-----|
| `@types/node` | `^20.11` | matches Node 20 runtime |
| `@types/vscode` | `^1.85` | matches `engines.vscode` floor |
| `@vscode/vsce` | `^3.9.2` | packaging |
| `typescript` | `^5.4` | compiler |

No runtime dependencies — nothing ships in the VSIX beyond the compiled `out/`.

## 9. Known constraints

- Windows-first tooling: `deploy-local.ps1` and the VM harness are PowerShell; the extension itself
  is cross-platform.
- The Ask-Copilot round-trip depends on the `copilot` CLI being installed and on the personal
  instruction file that teaches the agent to read `.vscode/searchlight-reviews/`.
- Single workspace folder is assumed for the review store.
