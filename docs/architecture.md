# Architecture

Branchline keeps Git logic in Rust and presentation in React. The two sides talk through a small,
typed set of Tauri commands.

```
React UI (components, layouts, features)
   │  uses
Frontend services (src/services/git.ts)      typed wrappers around invoke()
   │  Tauri IPC (JSON)
IPC commands (src-tauri/src/commands.rs)     async, run Git work via spawn_blocking
   │  calls
Git service (src-tauri/src/git/*)            no Tauri types; unit and integration tested
   │  spawns
Native Git CLI
```

## Rules

- **The UI never decides Git state.** It renders what the backend returns. There is no mocked or
  simulated repository data outside of tests.
- **Machine-readable Git output.** Status uses `--porcelain=v2 -z`; commit metadata uses NUL
  separated `--format` fields. Paths are never parsed from human-readable output.
- **One error model.** `GitError` (Rust) serializes to `{ kind, message, detail }`. The frontend
  maps `kind` to specific titles and hints and shows `detail` (Git's stderr) on request.
- **Contracts mirrored by hand.** `src/types/git.ts` mirrors the serde output. The Rust test
  `serializes_to_camel_case_contract` guards the field names.
- **Stale responses are dropped.** Each repository request carries a monotonic id; a slow answer
  for a repository the user already left is ignored.
- **No polling.** Refresh happens on file-system events, user actions and window focus
  (throttled). Refreshes requested while another refresh or a write operation runs are coalesced
  into one follow-up refresh.

## IPC commands

| Command | Returns | Notes |
|---|---|---|
| `git_version` | `GitVersion` | Resolves the Git binary, enforces Git 2.20+ |
| `inspect_repository(path)` | `RepositoryInfo` | Validates the path, resolves the repository root |
| `launch_repository_path` | `string \| null` | First positional command-line argument |
| `file_diff(repo, path, originalPath, area, force)` | `FileDiff` | `area`: unstaged, staged, untracked or conflicted |
| `stage_files(repo, paths)` | `RepositoryInfo` | `git add -A -- paths` |
| `unstage_files(repo, paths)` | `RepositoryInfo` | `git reset` (or `git rm --cached` before the first commit) |
| `discard_files(repo, paths)` | `RepositoryInfo` | Checks status first; restores from the index or deletes untracked files |
| `apply_lines(repo, request)` | `RepositoryInfo` | Stage, unstage or discard hunks or lines |
| `watch_repository(repo)` / `unwatch_repository` | none | Emits `repository-changed` events |

Write commands return the refreshed repository so the UI updates in one round trip. All write
operations go through one process-wide lock, so Branchline never runs two index-changing Git
commands at the same time.

## Partial staging

1. The UI sends the file, the action, the selected hunk and line indices, and the fingerprint of
   the diff it displayed.
2. The backend recomputes the diff and rejects the request (`stale`) if the fingerprint changed.
3. `git/patch.rs` builds a patch from the selection. Forward patches (stage) turn unselected
   removals into context and drop unselected additions; reverse patches (unstage, discard) do the
   opposite, so the side Git matches against is always the real file.
4. `git apply --cached [--reverse] --recount` applies it; discard applies to the working tree.

A randomized integration test edits a file, picks random line selections across hunks and checks
the resulting index and working tree byte-for-byte against an independent computation.

## File watching

`watcher.rs` uses `notify` (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on
Windows). It ignores read-only events, Git-internal files that do not affect status (objects,
logs, lock files) and paths ignored by the root `.gitignore`, then debounces bursts into one
`repository-changed` event. Ignoring read-only events matters: otherwise the files `git status`
reads would trigger the next refresh, forever. `tests/watcher.rs` guards against that.

## Extending later

Coding-agent integration is out of scope for now. Because every Git operation already goes through
`git::runner` and is exposed as an explicit command, an agent can later be added as another client
of the same service layer (with its own permission set) without changing the UI architecture.
