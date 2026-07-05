#requires -Version 5.1
<#
.SYNOPSIS
    Build the Searchlight extension and install it into local (host) VS Code.

.DESCRIPTION
    Compiles + packages the extension into searchlight-0.0.1.vsix (at repo root,
    already gitignored) and installs it with `code --install-extension ... --force`.

.PARAMETER InstallOnly
    Skip compile + package and just (re)install the existing .vsix. Use this for a
    quick reinstall when nothing has changed.

.EXAMPLE
    pwsh -File scripts/deploy-local.ps1            # build + install
    pwsh -File scripts/deploy-local.ps1 -InstallOnly  # reinstall existing .vsix
#>
[CmdletBinding()]
param(
    [switch]$InstallOnly
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's directory, so cwd doesn't matter.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vsix = Join-Path $repoRoot 'searchlight-0.0.1.vsix'

Push-Location $repoRoot
try {
    if (-not $InstallOnly) {
        Write-Host "==> Compiling (npm run compile)..." -ForegroundColor Cyan
        npm run compile
        if ($LASTEXITCODE -ne 0) { throw "npm run compile failed (exit $LASTEXITCODE)." }

        Write-Host "==> Packaging (npx @vscode/vsce package)..." -ForegroundColor Cyan
        npx @vscode/vsce package
        if ($LASTEXITCODE -ne 0) { throw "vsce package failed (exit $LASTEXITCODE)." }
    }

    if (-not (Test-Path $vsix)) {
        throw "Expected .vsix not found at $vsix. Run without -InstallOnly to build it first."
    }

    # Locate the `code` CLI: PATH first, then the default install location.
    $codeCmd = (Get-Command code -ErrorAction SilentlyContinue).Source
    if (-not $codeCmd) {
        $fallback = 'C:\Program Files\Microsoft VS Code\bin\code.cmd'
        if (Test-Path $fallback) { $codeCmd = $fallback }
    }
    if (-not $codeCmd) {
        throw "Could not find the 'code' CLI on PATH or at 'C:\Program Files\Microsoft VS Code\bin\code.cmd'."
    }

    Write-Host "==> Installing via $codeCmd ..." -ForegroundColor Cyan
    & $codeCmd --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed (exit $LASTEXITCODE)." }

    Write-Host "==> Installed extensions matching 'searchlight':" -ForegroundColor Cyan
    & $codeCmd --list-extensions --show-versions | Select-String -Pattern 'searchlight'

    Write-Host ""
    Write-Host "Done. In VS Code run 'Developer: Reload Window' to pick up the new build." -ForegroundColor Green
}
finally {
    Pop-Location
}
