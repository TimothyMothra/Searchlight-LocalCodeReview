# Demo screenshots

The canonical README screenshot lives at **`docs/images/screenshot.png`** (referenced by the
top-level `README.md`). Generate its dataset with the one-command demo script:

```powershell
pwsh -File scripts\deploy-local.ps1        # install the extension into local VS Code
pwsh -File scripts\demo-setup.ps1 -Force   # build a throwaway, PII-free demo repo in %TEMP%
```

Then open the generated folder in VS Code, compare `feature/demo → main`, frame the four panes
(Comparison / Changed Files / Commits / Conversations) with the `src/api/handlers.ts` `[bug]` thread
visible, and save the capture to `docs/images/screenshot.png`.

See `../../DEMO.md` for the full, repeatable instructions — the **Screenshot dataset** section
(`scripts\demo-setup.ps1`), plus Option A (F5 dev host), Option B (sideload the `.vsix`), and
Option C (VM sideload via hyperloop).
