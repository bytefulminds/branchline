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

## Milestone 2: Working tree and diffs (done)

- [x] Unified diff viewer, large-diff safe (virtualized rows, size guard)
- [x] Stage and unstage files, hunks and individual lines
- [x] Discard files, hunks and lines with confirmation
- [x] File-system watcher (focus refresh kept as a fallback)
- [x] Virtualized file list
- [x] Randomized test that checks partial staging, unstaging and discarding byte-for-byte
- [ ] Side-by-side diff view
- [ ] Syntax highlighting in diffs
- [ ] Line staging for untracked files (via intent-to-add)

## Milestone 3: Commits and history (done)

- [x] Commit (with amend), validation and error feedback
- [x] Incremental history loading, virtualized commit list
- [x] Commit details and changed files per commit, read-only file diffs
- [x] Initial commit graph with lane tokens (randomized continuity test)
- [x] macOS app icon on Apple's icon grid
- [ ] History search and filters
- [ ] Graph: click a lane to follow a branch, collapse merged branches

## Milestone 4: Branches and remotes

- [x] Create, switch, rename, delete branches with safety checks
- [x] Check out remote branches as tracking branches; detached checkout of a commit
- [x] Branch switcher in the title bar; commit context menu in History
- [x] Remotes, fetch, pull, push with progress and cancellation

## Milestone 5: Advanced workflows

- [x] Stash: save (with or without untracked files), apply, pop, delete, browse files and diffs
- [x] Stash, pull and reapply; stash and switch
- [x] Tags: create (lightweight or annotated), delete, push, delete on a remote, check out
- [x] Merge, rebase, cherry-pick and revert, with continue, skip and abort
- [x] Interactive rebase: reorder by dragging, reword, squash, fixup, drop
- [x] Drag a branch onto a branch or commit to merge or rebase
- [ ] Cherry-pick several commits at once
- [ ] Conflict resolution
- [ ] Worktrees

## Milestone 6: Quality and release readiness

- [ ] Startup and interaction performance measurements on all platforms
- [ ] Accessibility review, keyboard shortcut map, command palette
- [ ] Signed packaging and release workflow
