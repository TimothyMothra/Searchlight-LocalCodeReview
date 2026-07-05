<#
.SYNOPSIS
    One-command, PII-free demo repo for capturing a Searchlight screenshot.

.DESCRIPTION
    Produces a self-contained throwaway git repo with:
      * a base branch (`main`) and a compare branch (`feature/demo`),
      * a handful of changed files across NESTED folders (so the Changed Files
        pane renders a real tree),
      * 2 commits on the compare branch, and
      * a seeded v2 `.vscode/searchlight-reviews/feature-demo_main/` review
        (comments.json + registry.json) so all four panes are populated.

    The seeded review contains ZERO PII: neutral human author "reviewer" and an
    agent author block for "Copilot". It follows the v2 schema in
    docs/data-model.md exactly.

    The demo is written OUTSIDE this repo by default (under $env:TEMP) so it
    never dirties the extension's working tree. Override with -Path.

.PARAMETER Path
    Destination folder for the throwaway demo repo.
    Default: "$env:TEMP\searchlight-demo".

.PARAMETER Force
    Delete the destination folder first if it already exists.

.EXAMPLE
    pwsh -File scripts\demo-setup.ps1
    Creates the demo at $env:TEMP\searchlight-demo, ready to open in VS Code.

.EXAMPLE
    pwsh -File scripts\demo-setup.ps1 -Path C:\temp\sl-demo -Force
#>
[CmdletBinding()]
param(
    [string] $Path = (Join-Path $env:TEMP 'searchlight-demo'),
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

function Write-DemoFile {
    param([string] $Relative, [string] $Content)
    $full = Join-Path $Path $Relative
    $dir = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # UTF-8 without BOM, LF line endings — matches what the extension writes.
    $normalized = $Content -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($full, $normalized, (New-Object System.Text.UTF8Encoding($false)))
}

# --- 0. Preconditions -------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is not on PATH. Install Git and retry.'
}

if (Test-Path $Path) {
    if ($Force) {
        Write-Host "Removing existing demo at $Path ..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $Path
    }
    else {
        throw "Destination already exists: $Path`nRe-run with -Force to overwrite."
    }
}

New-Item -ItemType Directory -Path $Path -Force | Out-Null
Write-Host "Creating Searchlight demo repo at: $Path" -ForegroundColor Cyan

Push-Location $Path
try {
    # --- 1. init + local identity (scoped to this repo only) ----------------
    git init -q -b main
    git config user.name  'reviewer'
    git config user.email 'reviewer@example.com'

    # --- 2. base branch `main` — initial content ----------------------------
    Write-DemoFile 'README.md' @'
# Widget Service

A tiny demo service used to showcase the Searchlight local code review flow.
'@

    Write-DemoFile 'src/api/handlers.ts' @'
export function getWidget(id: string) {
  // Look up a widget by id.
  const widget = db.find(id);
  return widget;
}
'@

    Write-DemoFile 'src/utils/format.ts' @'
export function formatName(first: string, last: string): string {
  return first + " " + last;
}
'@

    git add -A
    git commit -q -m 'Initial widget service'

    # --- 3. compare branch `feature/demo` — changes across nested folders ---
    git checkout -q -b feature/demo

    # modify an existing base file
    Write-DemoFile 'src/api/handlers.ts' @'
export function getWidget(id: string) {
  // Look up a widget by id.
  const widget = db.find(id);
  if (!widget) {
    throw new Error("not found");
  }
  return widget;
}
'@

    # add a new nested file
    Write-DemoFile 'src/api/routes.ts' @'
import { getWidget } from "./handlers";

export const routes = {
  "GET /widget/:id": (req: any) => getWidget(req.params.id),
};
'@

    # modify a utils file
    Write-DemoFile 'src/utils/format.ts' @'
export function formatName(first: string, last: string): string {
  return `${first} ${last}`.trim();
}
'@

    git add -A
    git commit -q -m 'Add routes and harden widget lookup'

    # add a component + a test in more nested folders (second commit)
    Write-DemoFile 'src/components/Button.tsx' @'
export function Button({ label }: { label: string }) {
  return <button className="btn">{label}</button>;
}
'@

    Write-DemoFile 'tests/api/handlers.test.ts' @'
import { getWidget } from "../../src/api/handlers";

test("throws when widget missing", () => {
  expect(() => getWidget("nope")).toThrow();
});
'@

    git add -A
    git commit -q -m 'Add Button component and handler test'

    $baseSha    = (git rev-parse main).Trim()
    $compareSha = (git rev-parse 'feature/demo').Trim()

    # --- 4. seed a PII-free v2 review (feature/demo vs main) -----------------
    # Layout: .vscode/searchlight-reviews/<compare>_<base>/  ("/" -> "-")
    $reviewDir = '.vscode/searchlight-reviews/feature-demo_main'

    # Single-quoted here-string: backticks, $ and {} in the JSON body stay
    # literal. SHA placeholders are substituted afterwards.
    $comments = @'
{
  "version": 2,
  "sourceBranch": "feature/demo",
  "targetBranch": "main",
  "sourceCommit": "__COMPARE_SHA__",
  "targetCommit": "__BASE_SHA__",
  "seqCounter": 3,
  "threads": [
    {
      "id": "t-1",
      "filePath": "src/api/handlers.ts",
      "startLine": 5,
      "endLine": 7,
      "state": "unresolved",
      "seq": 1,
      "tags": ["bug"],
      "comments": [
        {
          "id": "c-1",
          "body": "Throwing a bare Error here loses the widget id. Can we include it in the message so callers can log which lookup failed?",
          "timestamp": "2026-07-03T09:00:00.000Z",
          "author": { "kind": "human", "name": "reviewer" }
        },
        {
          "id": "c-2",
          "body": "Good catch. Updated to throw new Error(`widget ${id} not found`) so the id is preserved in logs.\n\n~Written by 🤖 Copilot",
          "timestamp": "2026-07-03T09:04:00.000Z",
          "replyTo": "c-1",
          "author": {
            "kind": "agent",
            "name": "Copilot",
            "model": "Claude Opus 4.8",
            "reasoning": "high",
            "version": "1.0.69"
          }
        }
      ]
    },
    {
      "id": "t-2",
      "filePath": "src/utils/format.ts",
      "startLine": 2,
      "endLine": 2,
      "state": "unresolved",
      "seq": 2,
      "tags": ["question", "change"],
      "comments": [
        {
          "id": "c-3",
          "body": "Should formatName collapse internal whitespace too, or is trimming the ends enough for now?",
          "timestamp": "2026-07-03T09:10:00.000Z",
          "author": { "kind": "human", "name": "reviewer" }
        }
      ]
    },
    {
      "id": "t-3",
      "filePath": "src/components/Button.tsx",
      "startLine": 1,
      "endLine": 3,
      "state": "resolved",
      "seq": 3,
      "tags": ["praise"],
      "comments": [
        {
          "id": "c-4",
          "body": "Clean, minimal component — nice.",
          "timestamp": "2026-07-03T09:15:00.000Z",
          "author": { "kind": "human", "name": "reviewer" }
        }
      ]
    }
  ]
}
'@
    $comments = $comments.Replace('__COMPARE_SHA__', $compareSha).Replace('__BASE_SHA__', $baseSha)
    Write-DemoFile "$reviewDir/comments.json" $comments

    # registry.json — documented layout (list of reviews + activeReviewId).
    $registry = @'
{
  "version": 2,
  "activeReviewId": "feature-demo_main",
  "reviews": [
    {
      "id": "feature-demo_main",
      "sourceBranch": "feature/demo",
      "targetBranch": "main",
      "createdAt": "2026-07-03T09:00:00.000Z"
    }
  ]
}
'@
    Write-DemoFile "$reviewDir/registry.json" $registry

    # commit the seeded review so `git status` in the demo repo is clean
    git add -A
    git commit -q -m 'Seed Searchlight review for demo'

    # leave the compare branch checked out so the extension picks up feature/demo
    git checkout -q feature/demo
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Demo repo ready.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps to capture the screenshot:' -ForegroundColor Cyan
Write-Host '  1. Install the extension (from this repo):  pwsh -File scripts\deploy-local.ps1'
Write-Host "  2. Open the demo folder in VS Code:         code `"$Path`""
Write-Host '  3. Run "Searchlight: Start Review" (or open the Searchlight panel) and'
Write-Host '     compare  feature/demo  ->  main.'
Write-Host '  4. Frame the 4 panes (Comparison / Changed Files / Commits / Conversations);'
Write-Host '     the "src/api/handlers.ts" [bug] thread shows the human + Copilot reply.'
Write-Host '  5. Save the screenshot to:  docs\images\screenshot.png  (in THIS repo).'
Write-Host ''
