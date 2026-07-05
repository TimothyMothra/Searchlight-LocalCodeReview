# Searchlight: Local Code Review — VS Code Extension (scoping)

**Product name:** **Searchlight: Local Code Review**
**Project location:** `C:\REPOS\searchlight-localcodereview\` (own git repo; NOT part of SFC.Client.SFUI).
**Status:** v1 MVP + v1.5 shipped (2026-07-03). Local-only; publishing out of scope.
**Inspired by:** `Gururagavendra.local-pr-review` (marketplace). We build a *superset* that stays
schema-compatible with its `.vscode/local-reviews/` files (which Copilot already reads via
`~/.copilot/repos-github/.github/instructions/local-pr-review.instructions.md`) but writes to its **own**
storage path so it never clobbers the original.

## Locked decisions
- **Copilot integration = schema-only + external agent.** The extension writes/reads `comments.json`;
  the Copilot CLI/app reads the schema, replies in-thread, stamps identity. Extension NEVER calls a model.
- **Trigger = "Ask Copilot to review" button** → shells out to the `copilot` CLI with a prompt that
  points at the review folder + thread id. Agent responds by editing `comments.json`.
- **UI = native `vscode.comments` CommentController** (recommended path) + sidebar TreeView + status bar.
- **Storage path = `.vscode/searchlight-reviews/`** (NEW — does not clobber the original's
  `.vscode/local-reviews/`). Same internal file layout so the schema/tooling is shared.
  - ⚠️ Followup: `local-pr-review.instructions.md` currently points Copilot at `.vscode/local-reviews/`
    only. It must be extended to also read `.vscode/searchlight-reviews/` before the agent round-trip works.

## Architecture (ownership split)
```
┌─ Extension (TypeScript) ───────────────┐     ┌─ Copilot (external agent = CLI/app) ─┐
│ • Branch/remote pickers                │     │ • Reads comments.json (schema)        │
│ • Native comment threads (gutter UI)   │     │ • Replies in-thread                   │
│ • /tag autocomplete                    │ ◄─► │ • Stamps author identity block        │
│ • Copy buttons, git ops, open-terminal │file │ • Resolves /answers /suggests         │
│ • Writes well-defined JSON schema      │     │   (already knows this schema today)   │
└────────────────────────────────────────┘     └───────────────────────────────────────┘
              shared contract = .vscode/local-reviews/*.json
```

## Schema (extends the existing one — additive, backward-compatible)

`.vscode/local-reviews/registry.json` — unchanged from today (reviews list + `activeReviewId`).

`.vscode/local-reviews/<src>_<tgt>/comments.json` — thread gains `tags[]`, richer `author`, threading:
```jsonc
{
  "version": 2,                         // bump from 1; readers tolerate both
  "sourceBranch": "...", "targetBranch": "...",
  "sourceCommit": "...", "targetCommit": "...",
  "threads": [{
    "id": "...", "filePath": "src/foo.ts", "startLine": 101, "endLine": 101,
    "state": "unresolved",              // unresolved | resolved
    "tags": ["bug", "question"],        // NEW
    "comments": [
      { "id": "...", "body": "why here?", "timestamp": "...",
        "author": { "kind": "human", "name": "reviewer" } },        // author now an object
      { "id": "...", "body": "Because X.", "timestamp": "...",
        "replyTo": "<comment-id>",                                  // NEW: threading
        "author": { "kind": "agent", "name": "Copilot",            // NEW: identity block
                    "model": "Claude Opus 4.8", "reasoning": "high",
                    "version": "1.0.69" } }
    ]
  }]
}
```
Back-compat: existing extension writes `author` as a bare string; we accept `string | {kind,name,...}`.
Rendered signature for agent replies: `~Written by 🤖 Copilot` (+ model/version in the author object).

Tag set (fixed core, user-extensible via settings): `idea question bug change todo nit praise`.

## UI surface (recommendation)
- **Native `vscode.comments` CommentController** for the threads — inline gutter UI, reply boxes,
  resolve/unresolve for free. (This is almost certainly what the original uses.) Strongly preferred
  over a custom webview.
- **Sidebar TreeView** ("Local Reviews"): reviews → threads → comments; click to jump to file:line.
- **Status bar item**: active review `src → tgt`, click to switch.
- **Quick-pick** for branch/remote selection and copy actions.

## package.json contribution points (MVP)
- `commands`: `createReview`, `switchReview`, `addComment`, `askCopilot`, `resolveThread`,
  `copyCommitId`, `copyBranchName`, `copyDirPath`, `gitPull`, `gitPush`, `openTerminalHere`,
  `openDirectory`.
- `views` + `viewsContainers`: the Local Reviews sidebar.
- `menus`: editor context + comment-thread title actions (`askCopilot`, `resolveThread`).
- `configuration`: custom tag list, copilot CLI path/args, auto-arm-agent toggle.
- `languages`/completion provider: `/`-triggered tag autocomplete inside the comment input.

## /tag autocomplete
Register a `CompletionItemProvider` scoped to the comment-input document scheme; trigger char `/`.
Offer the configured tag set; selecting inserts the tag + updates `thread.tags[]` on submit.
(`#` is viable too but `/` matches the "commands" mental model and avoids markdown-heading clashes.)

## Git / directory integration (v1.5)
- Use the built-in **vscode.git** extension API (`getExtension('vscode.git').exports`) rather than
  shelling out, for branch lists, current commit, pull/push. Fall back to `git` CLI for edge cases.
- "Branch checked out locally?" → check worktrees; **Open Directory** = `openFolder` or reveal.
- **Open terminal here** = `createTerminal({ cwd })`.
- Copy buttons = `env.clipboard.writeText`.

## "Ask Copilot to review" trigger (the schema→agent bridge)
Button on a thread (or whole review) runs:
`copilot -p "Respond to local PR review thread <id> in <reviewDir>. Read comments.json, reply in-thread
per the schema, stamp your identity, and set state appropriately."` in an integrated terminal.
The agent already understands the schema (personal instruction file). Extension then reloads the file
and re-renders threads. (No model API keys, no in-extension LM calls.)

## Build order
1. **v0 spike** — `yo code` scaffold, read+render existing `comments.json` in a TreeView. Proves file I/O.
2. ✅ **v1 MVP** (DONE 2026-07-03) — CommentController threads, add-comment with `/tag` autocomplete, v2 schema write,
   copy buttons, "Ask Copilot" trigger, identity-stamped replies round-trip.
3. ✅ **v1.5** (DONE 2026-07-03) — branch/remote pickers, open-directory (worktree-aware), pull/push, open-terminal,
   status-bar active-review switcher.
4. **later** — real remote PR (GitHub/ADO), publishing, multi-repo.

## Effort estimate
- v0 spike: ~1–2 hrs. v1 MVP: ~1–2 days. v1.5: ~1 day. (TypeScript + VS Code API; the schema and
  Copilot side are already designed.)

## Open questions — RESOLVED (2026-07-03)
1. ✅ **Project location:** `C:\REPOS\searchlight-localcodereview\` (own git repo, separate from SFC.Client.SFUI).
2. ✅ **UI surface:** native `vscode.comments` CommentController (+ TreeView + status bar).
3. ✅ **Storage path:** new `.vscode/searchlight-reviews/` — do NOT clobber the original.
   Product renamed to **"Searchlight: Local Code Review"**.

## Next step
Scaffold v0 at `C:\REPOS\searchlight-localcodereview\`:
- `yo code` (TypeScript extension) → identifiers: display name "Searchlight: Local Code Review",
  id `searchlight`, publisher placeholder (local-only, unpublished).
- `git init`, first commit of the scaffold.
- v0 goal: read + render existing `.vscode/searchlight-reviews/**/comments.json` in a TreeView.
- Register `C:\REPOS\searchlight-localcodereview\` as a Copilot **project** so a coding session owns the build going forward.
