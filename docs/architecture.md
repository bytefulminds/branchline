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

| `log_page(repo, skip, limit)` | `LogPage` | History in `--date-order`, paged from a cached topology |
| `list_refs(repo)` | `RefInfo[]` | Branches, remote branches and tags (annotated tags peeled) |
| `commit_details(repo, oid)` | `CommitDetails` | Message, people, parents, files against the first parent |
| `commit_file_diff(repo, oid, path, originalPath, force)` | `FileDiff` | Read-only diff of one file in a commit |
| `commit_draft(repo)` | `CommitDraft` | Author identity, HEAD message (for amend), prepared merge message |
| `create_commit(repo, request)` | `RepositoryInfo` | `git commit --file=- --cleanup=whitespace [--amend]` |

| `list_branches(repo)` | `BranchList` | Local and remote branches, upstream, ahead/behind, tip |
| `check_branch_name(repo, name)` | `string \| null` | Live validation message for name inputs |
| `create_branch` / `switch_branch` / `rename_branch` / `delete_branch` | `RepositoryInfo` | Delete without `force` reports `notMerged` |
| `checkout_remote_branch(repo, remoteBranch)` | `RepositoryInfo` | Creates a tracking branch, or switches to it |
| `checkout_detached(repo, oid)` | `RepositoryInfo` | Detached HEAD at a commit |

Branch names are checked with `git check-ref-format` plus Branchline's own rules (no leading
dash, not `HEAD`), and always passed after `--` or as full ref names. Switching uses
`git checkout <name> --`, so a file with the same name as a branch cannot be mistaken for it.
When a switch would overwrite uncommitted changes, Git refuses and Branchline reports which files
are in the way (`checkoutConflict`); nothing is changed.

| `list_remotes(repo)` | `RemoteInfo[]` | Names and URLs, credentials removed |
| `fetch_remote(repo, remote, opId, onProgress)` | `RemoteResult` | `remote: null` fetches all remotes; always prunes |
| `pull_branch(repo, mode, opId, onProgress)` | `RemoteResult` | `fastForward` (default), `merge` or `rebase` |
| `push_branch(repo, request, opId, onProgress)` | `RemoteResult` | Upstream push, publish (`setUpstream`) or force with lease |
| `cancel_remote_operation(opId)` | nothing | Stops a running fetch, pull or push |
| `list_stashes(repo)` | `StashInfo[]` | Newest first, with branch and untracked-files commit |
| `save_stash(repo, message, includeUntracked)` | `RepositoryInfo` | |
| `apply_stash(repo, index, oid, pop)` | `StashResult` | Fails with `stale` if `stash@{index}` is no longer `oid` |
| `drop_stash(repo, index, oid)` | `RepositoryInfo` | Same check |

Commit ids from the UI are accepted only as hexadecimal strings, so they can never be read as
options or revision expressions.

Write commands return the refreshed repository so the UI updates in one round trip. All write
operations go through one process-wide lock, so Branchline never runs two index-changing Git
commands at the same time.

## Fetch, pull and push

`git/remote.rs` runs network commands through `runner::run_git_streaming`:

- **Progress.** Git writes progress to stderr and repaints lines with `\r`. The runner splits on
  `\r` and `\n`; `parse_progress` turns lines such as `Receiving objects:  45% (450/1000)` into
  `{ phase, percent, detail }`, and only changes are forwarded to the UI over a Tauri channel
  (about 7 updates per second on a 410,000 object fetch).
- **Cancellation and timeout.** Each operation has an id. `cancel_remote_operation` sets a flag;
  the runner kills Git and, on macOS and Linux, its whole process group, so helpers such as
  `ssh` stop too. The hard limit is 30 minutes. A test checks that a hanging SSH helper does not
  survive a cancel.
- **No prompts.** `GIT_TERMINAL_PROMPT=0` for HTTPS and `ssh -o BatchMode=yes` for SSH, unless
  the user configured `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`. Credential helpers
  (macOS Keychain, Git Credential Manager) and SSH agents keep working.
- **Arguments.** Remote names must match a configured remote; branches are validated and pushed
  as full refspecs (`refs/heads/x:refs/heads/y`). Pull passes the upstream remote and branch
  explicitly, so the result never depends on `push.default` or similar settings.
- **Force push** is only offered with `--force-with-lease`, expecting the remote branch to be
  where the remote-tracking branch says. If someone pushed since the last fetch, Git refuses
  (`staleLease`).
- **Errors** are classified from Git's output: `authFailed`, `hostKeyUnverified`,
  `networkFailed`, `remoteNotFound`, `pushRejected`, `staleLease`, `remoteRejected`,
  `noUpstream`, `diverged` and `cancelled`. Details drop progress and `hint:` lines, and every
  URL in them is redacted (`https://user:token@host` becomes `https://***@host`).
- A pull that stops with merge or rebase conflicts is reported as a result
  (`conflicts: true`), not as a failure; the conflicts show up in the Changes view.

Pull can stash local changes first (`autostash`, Git 2.27 or newer) and reapply them afterwards.
If the pull stops with merge conflicts, Git holds those changes until the merge is committed or
aborted; `RepositoryInfo.heldChanges` reports that, so the UI can say where they are. If
reapplying conflicts, Git keeps a copy in the stash list (`stashKept`).

## Stashes

`git/stash.rs` addresses a stash by index and commit id together. Indexes shift whenever a stash
is added or removed, also from a terminal, so every apply, pop and drop first checks that
`stash@{index}` still is the commit the user selected and fails with `stale` otherwise. A
stale view can never drop the wrong stash.

Apply and pop restore staged and unstaged changes separately (`--index`) and fall back to a
plain apply when Git cannot. A pop that produces conflicts keeps the stash. Stash commands run
without `GIT_LITERAL_PATHSPECS`, because `git stash --include-untracked` relies on pathspec
magic internally (with the variable set, untracked files are stashed but not removed); they never
receive paths from the UI. `RepositoryInfo.stashCount` and `stashFingerprint` come from one
`git stash list` call per inspection, so the list reloads only when it changes.

One network operation runs per repository at a time; pull also takes the write lock because it
changes the working tree.

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

## History and graph

Correct graph drawing needs children before parents, which only `--date-order` (or
`--topo-order`) guarantees, and that requires Git to walk the whole history. Branchline walks it
once per repository state with `git rev-list --date-order` (commit ids only) and keeps the order
in memory, keyed by a fingerprint of all refs plus HEAD. Each page then asks
`git log --no-walk=unsorted --stdin` for the metadata of exactly its commits, so later pages cost
the same at any depth. `RepositoryInfo.refsFingerprint` tells the UI when history must reload;
working-tree refreshes do not reload it.

The graph layout (`src/features/history/graph.ts`) is a pure, incremental function: each lane
"expects" the next commit id that continues it, branch tips open new lanes, merge parents open
lanes to the right, and lanes that expect the same commit converge at its row. The state carries
over between pages. A randomized test lays out 500 random histories in random page sizes and
checks that every line leaving a row enters the next one and that all lanes close.
