# Copilot instructions — Searchlight: Local Code Review

This repo's knowledge base lives in [`docs/`](../docs/README.md). Read it before making changes.

| Doc | Read it when you need to understand… |
|-----|--------------------------------------|
| [docs/README.md](../docs/README.md) | Product overview + 30-second orientation (start here) |
| [docs/architecture.md](../docs/architecture.md) | Module graph, the four views, the extension↔Copilot ownership split, the Ask-Copilot CLI bridge |
| [docs/data-model.md](../docs/data-model.md) | The on-disk `comments.json` v2 schema, v1 back-compat, durable `seqCounter` |
| [docs/engineering.md](../docs/engineering.md) | Build / package / deploy commands, VM verification, commit conventions |

Key invariants (see docs for detail):
- The extension **never calls a model/LM API** — all AI work is an external `copilot` CLI shell-out.
- Reviews are plain JSON under `.vscode/searchlight-reviews/` — no server, DB, or network.
- Commit linear on `main` with the `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer; never commit the gitignored `.vsix`.