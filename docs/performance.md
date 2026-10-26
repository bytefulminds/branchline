# Performance

Measured, not assumed. This page explains how Branchline is measured and records the
numbers per platform. Every release adds its own numbers: the `measure:*` CI jobs store a
`perf-<platform>.json` with each release pipeline.

## How to measure

Build a release binary (`npm run app:build`, or take one from a release pipeline), then:

```sh
node scripts/measure-startup.mjs <path to branchline> <repository> [runs=5] [out.json]
```

On Linux without a desktop, put `xvfb-run -a dbus-run-session --` in front.

Each run starts Branchline with `--measure-startup=<file>`. The app opens the repository, then
does what a person would do and waits until each result has been painted:

| Step | Measured from |
|---|---|
| Window created | process start |
| First frame painted | process start |
| Repository open and shown | process start (includes `git status` and the file list) |
| Switch to History | the switch, until the first commits are on screen |
| Switch back to Changes | the switch, until the file list is on screen |
| Open a diff | the click on the first changed file, until diff lines are on screen |
| Open the command palette | the shortcut, until the palette is on screen |

Then it writes the times as JSON and quits. The script prints the median of all runs.

## Results

### Linux (x86_64), Branchline 0.1.0

Release build in a container: 2 cores (Xeon, 2.1 GHz), Xvfb with software rendering and no
GPU, warm file cache, 5 runs. This setup is slower than a desktop, especially for the first
frame, which includes starting WebKitGTK without graphics acceleration.

| Step | Small demo repository (5 changes) | git/git (82,000 commits, 4,900 files, 1 change) |
|---|---|---|
| Window created | 122 ms | 102 ms |
| First frame painted | 837 ms | 858 ms |
| Repository open and shown | 961 ms | 1,205 ms |
| Switch to History | 146 ms | 524 ms |
| Switch back to Changes | 39 ms | 25 ms |
| Open a diff | 49 ms | 85 ms |
| Open the command palette | 59 ms | 72 ms |

git/git had a commit-graph file. The History step includes walking the whole history once to
put commits in graph order; later pages take about 30 ms each (below).

### macOS and Windows

Measured by the `measure:macos` and `measure:windows` jobs of the release pipeline; add the
numbers here from their `perf-*.json` artifacts.

On Windows the app can only start in a desktop session. A GitLab runner installed as a
Windows service runs in session 0, where WebView2 cannot open a window (HRESULT
0x80080005, "server execution failed"). The script then reports the measurement as skipped
instead of failing. To measure on Windows, run the runner in a logged-in session instead of as
a service, for example with automatic sign-in and a scheduled task at logon that runs
`gitlab-runner run` from `C:\GitLab-Runner`. Building does not need a desktop, so the service
is fine when you only want installers.

## Git operations (backend only)

Inspection runs `rev-parse` twice, `status` once and `show` once.

| Repository | Changed paths | Median inspect time |
|---|---|---|
| Small demo repository | 5 | 22 ms |
| git/git (82k commits, 4.9k files) | 500 | 33 ms |
| Synthetic, 12,000 untracked files | 12,000 (10,000 returned) | 34 ms |

Release build, Linux x86_64 container, warm file cache, 10 runs each (`examples/inspect.rs`).

History on git/git (85,000 commits, 1,021 refs), `examples/history.rs`:

| | First page (300 commits) | Every later page, at any depth |
|---|---|---|
| Without a commit-graph file (fresh clone) | 1.03 s | about 30 ms |
| With a commit-graph file (`git commit-graph write --reachable`) | 0.30 s | about 33 ms |

The first page includes one walk over the whole history to get the correct order (children
before parents), which Git can only do quickly with a commit-graph file. Git writes that file
during `git gc` and `git maintenance`; Branchline does not write it for you.

## What keeps it fast

- Long lists (changed files, commits, diff lines) are virtualized: only visible rows exist.
- History loads 300 commits at a time; the order is computed once per repository state.
- Syntax highlighting loads on first use, in its own bundle, and skips very large diffs.
- The file watcher refreshes on changes instead of polling.
