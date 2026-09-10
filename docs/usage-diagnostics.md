# Local feature usage

`searchlight.usageLogging` is **on by default**, independently of performance logging. No opt-in or
export is required to collect it. `[usage]` JSON lines appear in **Output > Searchlight** and in
VS Code's normal local output logs. There is no telemetry service, network upload, user/device ID,
or usage data written into the repository.

## What is observed

| Signal | Interpretation |
|---|---|
| Command started/completed/failed | Which Searchlight operations were invoked and whether their handlers returned or threw |
| Pane actions | Branch selection/update/pinning; file opening/review toggles/folder expansion; commit expansion/collapse/file opening; discussion navigation/expansion/resolve controls |
| Pane visibility and focused-window duration | Which panes were available on screen, including panes with zero interactions |
| Active editor observations/transitions | Git-backed diffs versus Searchlight diffs, ordinary text editors, other editors, or no active editor |
| Discussion created/replied/resolved/reopened | Successful persistence of a discussion mutation, separately from command invocation |
| Discussion exposed | Existing threads attached to currently visible editors; repeated unchanged reconciliation is not counted again |
| Read conversation | `viewConversation` pane action / `searchlight.viewConversation` command, independent of code navigation |

All four panes appear in the summary, even when never opened. In particular, a visible Commits pane
with zero commit actions is different from actively using commit inspection. Passive rendering,
background refreshes and `ready`/render acknowledgements are **not** feature actions.

Messages contain fixed action/context labels and counts/booleans, not filenames, paths, refs,
commit IDs, editor titles, source text, comment text, authors or thread IDs. Only a temporary
per-activation run ID links usage with the performance trace.

## Source Control versus Searchlight

The public VS Code API exposes editor inputs, not a reliable history of which sidebar launched a
file. A diff containing `git://` content is classified as `git-diff`; a diff containing
`searchlight-diff://` content is `searchlight-diff`. Ordinary files (including an untracked file
opened from Source Control) remain `text-editor`: the extension does not guess their origin.
Unsupported editor types are `other`, rather than being attributed to Source Control.
Read-only conversation tabs have their own `searchlight-conversation` editor context so reading
Copilot responses is not misclassified as inspecting code.

Use command-start events to associate a discussion action with its editor context at invocation.
An async command can finish after the user changes editors, so completion/mutation context may
differ. Initial restored editors and panes are observations, not clicks. Visibility is exposure,
not proof of attention or reading; multiple panes can be visible together, so their durations
must not be added as exclusive work time. Focused-window duration pauses when VS Code loses focus
or usage logging is disabled.
Editor transitions compare stable input values rather than VS Code's replaceable Tab objects.
Those comparison keys stay only in memory; filenames and URI values are never emitted.

Pane actions, commands, and saved mutations describe different stages of the same interaction;
do not add their counts together. A completed command means its handler returned, not necessarily
that the user confirmed a dialog or that a mutation occurred.

## Summaries and capture

Per-run summaries retain aggregate counts/durations and a bounded recent-event history (2,000
events, with an eviction count). A summary is logged every minute and during normal deactivation.
Command and discussion counts are also grouped by editor context, so evidence of discussion use
in Git-backed diffs survives eviction of individual recent events. Hiding a pane is not a visit.
**Searchlight: Export Startup Diagnostics** also includes the usage summary in its JSON report.
Snapshots do not reset counters.

Cross-session analysis can read VS Code's retained local logs. The in-memory aggregates reset on
activation; this is not a permanent analytics database. Preserve an export when a measurement
must outlive VS Code's log retention. No features are disabled or rearranged automatically based
on usage.

## Inline discussions without opening Searchlight

The extension now activates at `onStartupFinished`, in addition to the existing review-file and
implicit view/command triggers. It registers the comment controller and discovers existing
discussions without starting comparison Git queries. An already-visible editor satisfies the
comment deferral gate; otherwise the existing editor-change/fallback timer applies.

Heavy comparison initialization is shared and starts only when a Searchlight pane, a
comparison-dependent command, or a **new** inline discussion needs a target. Replies and state
changes on already-bound discussions use their existing review file without initializing the
comparison. A first new discussion initializes the current comparison automatically, so it does
not require a prior visit to the Searchlight sidebar or arbitrarily select an old review.

The performance trace includes `startup.comparisonDeferred` and
`startup.comparisonRequested`. With early activation, activation-relative content readiness may
include time spent in Source Control before opening Searchlight. Subtract the comparison-request
milestone for demand-to-readiness latency; host sampling restarts for that demand as well.
