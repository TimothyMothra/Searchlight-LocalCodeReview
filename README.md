# Searchlight: Local Code Review

A **local-only VS Code extension** for reviewing your own git branch diffs the way you'd review a
pull request — native inline comment threads, a four-view "PR panel", `/tag` classification, and a
one-click **Ask Copilot** round-trip — all offline, with every comment stored as plain JSON on disk.

> **Status:** local-only, single-developer tool. The extension **never calls a language model
> directly** — all AI work happens through an external `copilot` CLI shell-out. Reviews live under
> `.vscode/searchlight-reviews/` (no server, no database, no network), a superset of — and never a
> clobber of — the original `Gururagavendra.local-pr-review` format.

## Screenshot

![Searchlight showing a synthetic demo review: four-view panel and inline comment threads](docs/images/screenshot.png)

_Captured with the demo dataset (synthetic, no PII) — see [`DEMO.md`](./DEMO.md)._

## What it does

- **Four-view review panel** in a dedicated Activity Bar container, all driven by one in-memory
  *active comparison* (`base` = target branch, `compare` = source branch under review):
  - **Comparison** — the current `Base` / `Compare` branches; click to pick, `⇄` to swap.
  - **Changed Files** — a hierarchical folder tree of `git diff base...compare` with per-file
    reviewed checkboxes; click opens a native diff.
  - **Commits** — `git log base..compare`; click copies the full SHA.
  - **Conversations** — every comment thread for the active review; click jumps to `file:line`.
- **Native inline comment threads** — comments render as first-class VS Code `CommentController`
  threads in the editor gutter, with reply, resolve / unresolve, and copy commands.
- **`/tag` classification** — type `/` in any comment box for autocomplete over the tag set; tags
  are merged into the thread on submit.
- **Ask Copilot round-trip** — hand a review thread to the `copilot` CLI; when the agent writes its
  reply back into `comments.json`, a file watcher reloads and re-renders it in-thread. The extension
  only ever *shells out* — it never calls a model itself.
- **Plain-JSON storage** — reviews are human-readable JSON under `.vscode/searchlight-reviews/`,
  created lazily on first mutation so clean repos stay clean. Durable thread ids and v1/v2
  back-compat are preserved on every write.

## Quick start

Build and install into your local VS Code from source:

```powershell
# 1. Install dependencies and compile TypeScript -> out/
npm install
npm run compile

# 2. Package the extension into searchlight-0.0.1.vsix (gitignored)
npx @vscode/vsce package

# 3. Build + install into local VS Code in one step
pwsh -File scripts/deploy-local.ps1
#    (or reinstall the existing .vsix without rebuilding:)
pwsh -File scripts/deploy-local.ps1 -InstallOnly
```

Then run **Developer: Reload Window** in VS Code to pick up the build. Requires **Node.js** and the
**`code` CLI** on `PATH`.

## Tags

Classify a thread by typing `/` in the comment box and picking from the autocomplete:

`/idea` · `/question` · `/bug` · `/change` · `/todo`

(The full configurable set also includes `/nit` and `/praise`; edit `searchlight.tags` to customize.)

## Documentation

Full knowledge base in [`docs/`](./docs/README.md):

- [architecture.md](./docs/architecture.md) — ownership split, the four views, the
  `CommentController`, and the Ask-Copilot bridge.
- [data-model.md](./docs/data-model.md) — on-disk layout, the v2 schema, v1 back-compat, the tag set,
  and the durable `seqCounter`.
- [engineering.md](./docs/engineering.md) — build / package / deploy commands, VM verification, and
  commit conventions.

See [`DEMO.md`](./DEMO.md) for the repeatable demo path and how to capture the screenshot above.

## License

[MIT](./LICENSE)
