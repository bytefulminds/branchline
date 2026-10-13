# Roadmap

Milestones are only marked complete when the behavior works against real Git and is tested.

## Milestone 0: Inspect and establish the project (done)

- [x] Inspected workspace, `_assets/design_ui.md` and both referenced images
- [x] Tauri 2 + React + TypeScript + Rust project structure
- [x] Design tokens and shared UI foundation
- [x] Dev, test, lint, format and build workflows
- [x] MIT license and documentation

## Milestone 1: First working application (done)

- [x] Native folder picker
- [x] Rust backend inspects the repository with the Git CLI
- [x] Repository path, current branch, detached HEAD, unborn branch
- [x] Changed files and statuses (staged, unstaged, untracked, renamed, conflicted)
- [x] Loading, empty and error states
- [x] Design system applied to the whole window (title bar, toolbar, sidebar, workspace, status bar)
- [x] Invalid paths, non-repositories, bare repositories and Git errors handled without crashing
- [x] Backend tests with temporary repositories; frontend interaction tests
- [x] Runs on macOS and Linux
- [ ] Run and verify on Windows

## Milestone 2: Working tree and diffs

- [ ] Diff viewer (unified and split, syntax-aware, large-diff safe)
- [ ] Stage and unstage files and hunks/lines
- [ ] Discard with confirmation
- [ ] File-system watcher replacing focus-based refresh
- [ ] Virtualized file list

## Milestone 3: Commits and history

- [ ] Commit (with amend), validation and error feedback
- [ ] Incremental history loading, virtualized commit list
- [ ] Commit details and changed files per commit
- [ ] Initial commit graph with lane tokens

## Milestone 4: Branches and remotes

- [ ] Create, switch, rename, delete branches with safety checks
- [ ] Remotes, fetch, pull, push with progress and cancellation

## Milestone 5: Advanced workflows

- [ ] Stash, merge, rebase, cherry-pick, revert, conflict resolution, tags, worktrees

## Milestone 6: Quality and release readiness

- [ ] Startup and interaction performance measurements on all platforms
- [ ] Accessibility review, keyboard shortcut map, command palette
- [ ] Signed packaging and release workflow
