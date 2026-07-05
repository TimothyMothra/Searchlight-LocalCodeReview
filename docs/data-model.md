# Data Model

Everything Searchlight persists is a plain JSON file under a workspace's `.vscode/searchlight-reviews/`
directory. There is no database and no network state. The schema source of truth is
`src/reviewModel.ts` (types, parse, migration — deliberately `vscode`-free) and `src/reviewStore.ts`
(serialize, load, mutate).

## 1. On-disk layout

```
<workspaceFolder>/.vscode/searchlight-reviews/
├── registry.json                       # list of known reviews + activeReviewId
└── <compare>_<base>/                    # one folder per comparison; branch '/' -> '-'
    └── comments.json                    # the review: threads, comments, reviewedFiles
```

- **Glob (activation + scan):** `.vscode/searchlight-reviews/**/comments.json`
  (`REVIEWS_GLOB` in reviewStore.ts). Deliberately **not** the original extension's
  `.vscode/local-reviews/` — the two coexist.
- **Folder name:** `<compare>_<base>` where `compare` = SOURCE branch and `base` = TARGET branch,
  each run through `sanitizeBranch` (every `/` → `-`). Example: compare `feature/mul`, base `main`
  → `feature-mul_main/`.
- **Activation event:** `workspaceContains:.vscode/searchlight-reviews/**/comments.json` — the
  extension only wakes when such a file exists (or is created).

## 2. Sources → readers

| On-disk source | Read by | Produces |
|----------------|---------|----------|
| `registry.json` | reviewStore | reviews list + `activeReviewId` |
| `<compare>_<base>/comments.json` | `parseReview` (reviewModel) | a `Review` (threads, comments, reviewedFiles, seqCounter) |
| historical git blobs (via `ReviewDiffContentProvider`) | commits/files diff views | left/right sides of a diff |

## 3. `comments.json` — the v2 schema

```jsonc
{
  "version": 2,                          // serializer ALWAYS writes 2; reader tolerates 1
  "sourceBranch": "feature/mul",         // = compare
  "targetBranch": "main",                // = base
  "sourceCommit": "…",                   // resolved shas (optional)
  "targetCommit": "…",
  "reviewedFiles": ["src/app.js"],       // emitted only when non-empty
  "seqCounter": 4,                       // durable high-water mark; emitted only when present
  "threads": [
    {
      "id": "thr-…",
      "filePath": "src/app.js",          // repo-relative, forward slashes
      "startLine": 5,
      "endLine": 5,
      "state": "unresolved",             // unresolved | resolved
      "seq": 1,                          // 1-based DISPLAY id -> shown as #01
      "tags": ["bug", "question"],
      "comments": [
        { "id": "cmt-…", "body": "why here?", "timestamp": "2026-07-04T…",
          "author": { "kind": "human", "name": "timolee" } },
        { "id": "cmt-…", "body": "Because X.  ~Written by 🤖 Copilot", "timestamp": "2026-07-04T…",
          "replyTo": "cmt-…",            // threading: parent comment id
          "author": { "kind": "agent", "name": "Copilot",
                      "model": "Claude Opus 4.8", "reasoning": "high",
                      "version": "1.0.69",
                      "sessionId": "f7dffc32-…" } }   // agent-only Copilot session UUID
      ]
    }
  ]
}
```

### Type reference

| Type | Fields |
|------|--------|
| `Review` | `version`, `sourceBranch?`, `targetBranch?`, `sourceCommit?`, `targetCommit?`, `threads[]`, `reviewedFiles?[]`, `seqCounter?`, `sourceFile` (in-memory only) |
| `ReviewThread` | `id?`, `filePath?`, `startLine?`, `endLine?`, `state?` (`unresolved`\|`resolved`), `seq?` (1-based display id), `tags[]`, `comments[]` |
| `ReviewComment` | `id?`, `body`, `timestamp?`, `replyTo?`, `author?` |
| `ReviewAuthor` | `kind` (`human`\|`agent`\|`unknown`), `name`, `model?`, `reasoning?`, `version?`, `sessionId?` (agent-only) |

## 4. Serialization rules

- **Always writes v2.** `serializeReview` emits `version: 2` regardless of what was read.
- **Diff-friendly.** 2-space indent + trailing newline.
- **Sparse.** `reviewedFiles` and `seqCounter` are only written when present/non-empty; `author`
  sub-fields (`model`/`reasoning`/`version`/`sessionId`) only when set.
- **No uuid dependency.** Ids come from `newId(prefix)` = `<prefix>-<Date.now(base36)>-<rand6>`.

## 5. v1 back-compat (reading)

`parseReview` is tolerant so files written by the original extension (or an older Searchlight) still
load:

| v1 shape | Normalized to |
|----------|---------------|
| missing `version` | treated as `version: 1` |
| `author` is a bare string (e.g. `"timolee"`) | `{ kind: "unknown", name: "timolee" }` via `parseAuthor` |
| missing `tags` | `[]` |
| missing `state` | `unresolved` |
| missing `seq` / `seqCounter` | see durable-seq migration below |

## 6. Durable thread display ids (`seq` + `seqCounter`)

Each thread has a 1-based `seq` rendered as `#01`, `#02`, … `seqCounter` is a **monotonic
high-water mark** stored on the `Review`; it is never decremented.

- **New thread:** `addThread` does `seq = ++seqCounter` — it never scans `Math.max(threads)`, so a
  transiently-empty in-memory review can't reset the counter and reuse a display id.
- **Legacy migration (`normalizeSeq`):** runs once when `seqCounter === undefined`. It renumbers
  existing threads `1..N` by array order and sets `seqCounter = N`. When `seqCounter` is already
  present it only backfills any missing `seq` and keeps the counter `>= max(seq)`.

This fixed a real bug where a third thread was labeled `#01` (reused) because the counter was derived
from a momentarily-empty thread set.

## 7. Tags

- **Core set (default):** `idea question bug change todo nit praise`
  (configurable via `searchlight.tags`).
- Entered as `/tag` tokens in the comment input (see `tagCompletion.ts`); merged into the thread's
  `tags[]` on submit.

## 8. Reviewed-files checklist

`reviewedFiles` is an array of repo-relative paths the reviewer has checked off in the Changed Files
view. Toggling a file's checkbox mutates the array and calls `saveReview` (which lazily creates
`comments.json` if it doesn't exist yet).

## 9. Helper functions (reviewModel.ts, `vscode`-free)

| Function | Purpose |
|----------|---------|
| `parseReview(data, sourceFile)` | tolerant v1/v2 parse → `Review` |
| `parseAuthor(raw)` | `string \| object` → `ReviewAuthor` |
| `normalizeSeq(review)` | one-time legacy `seq`/`seqCounter` migration |
| `newId(prefix)` | uuid-free id generator |
| `formatTimestamp(iso)` | friendly local time, e.g. `Jul 4, 7:12 PM` (falls back to raw) |
| `authorDisplay(author)` | `{ name, iconId }` — `hubot` for agents, `account` for human/unknown (callers wrap `iconId` with `vscode.ThemeIcon`) |
