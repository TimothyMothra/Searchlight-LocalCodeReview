# Metrics Baseline — Native TreeViews (pre-webview conversion)

These are the **native-TreeView** `[perf]` numbers captured from the deployed build @ HEAD `6087ffa`, VS Code 1.127.0. They are the "before" baseline used to detect regressions as each pane (Files, Commits, Conversations) is converted from a native `TreeView` to a `WebviewView`.

## Activation / background

- activate total: 3ms
- getRepoRoot: 280ms
- computeDefaults: 181ms
- resolve: 233ms
- background init total: 694ms

## Pane build / data-load (the regression-comparison baselines)

- files.data-load: 303ms, count=4
- files.build: 1ms, count=2, paths=4   (re-render: 0ms)
- commits.data-load: 269ms, count=3, truncated=false
- commits.build: 270ms, count=3
- commits.expand: 213ms/153ms/137ms, count=4/1/2
- conversations.build: 1ms, count=6   (pure in-memory map, no git op)
- comments.render (comparison webview, already converted): 283ms, count=6

## How to use these baselines

After each pane is converted to a webview, compare its new `<view>.build` / `<view>.render` / `<view>.firstPaint` against these; investigate any regression >~2x on build or a data-load delta.
