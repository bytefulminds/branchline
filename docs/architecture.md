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

| `log_page(repo, skip, limit, filter?)` | `LogPage` | History in `--date-order`, paged from a cached topology; with a `LogFilter` only matches (`total` counts them) |
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
| `list_tags(repo)` | `TagInfo[]` | Newest first; annotated tags peeled to their commit |
| `check_tag_name(repo, name)` | `string \| null` | Validation and duplicate check for the tag dialog |
| `create_tag(repo, name, target, message)` | `RepositoryInfo` | A non-empty message makes an annotated tag |
| `delete_tag(repo, name)` | `RepositoryInfo` | Local only |
| `push_tag(repo, name, remote, delete, opId, onProgress)` | `RemoteResult` | Push or delete on the remote; never forced |
| `merge_into_current(repo, request)` | `IntegrateResult` | Source is a branch or commit; `noFf`, `autostash` |
| `rebase_current(repo, onto, autostash)` | `IntegrateResult` | Current branch only (not a detached HEAD) |
| `cherry_pick(repo, oid)` / `revert_commit(repo, oid)` | `IntegrateResult` | Merge commits use their first parent (`-m 1`) |
| `cherry_pick_many(repo, oids)` | `IntegrateResult` | Order given (oldest first), at most 100, no merge commits; `outcome.skipped` counts commits already on the branch |
| `operation_step(repo, step)` | `IntegrateResult` | `continue`, `skip` or `abort` the operation in progress |
| `add_remote(repo, name, url)` / `edit_remote(repo, name, newName, url, pushUrl)` / `remove_remote(repo, name)` | `()` | Names and addresses are validated; an unchanged (redacted) address is never written back |
| `clone_repository(url, dest, opId, onProgress)` | `string` | Streams progress like fetch; `cancel_remote_operation(opId)` stops it and removes what it created |
| `init_repository(path, branch)` | `string` | New or existing folder; `branch` empty means Git's default |
| `get_settings()` / `save_settings(value)` | `Settings` | Saved values come back clamped |
| `get_identity(repo?)` / `set_identity(scope, repo?, values)` | `Identity` / `()` | `scope`: `global` or `repository` |
| `open_in_editor(repo, path?)` / `open_terminal(repo)` / `reveal_in_file_manager(repo, path?)` | `()` | Uses the editor and terminal from the settings |
| `measure_mode()` / `measure_elapsed()` / `finish_measurement(report)` | `boolean` / `number` / `()` | Startup timing with `--measure-startup=<file>` (docs/performance.md); finishing writes the report and quits |
| `git_command_log(since)` / `clear_git_command_log()` | `GitLogEntry[]` / `()` | Commands that started or finished after `since` (a sequence number); the console polls this once a second while open |
| `ai_server_info(provider, url)` | `AiServerInfo` | The provider's chat models (and the Ollama version); `url` is used for Ollama and OpenAI-compatible servers |
| `ai_key_exists(provider)` / `save_ai_key(provider, key)` | `boolean` / `()` | API keys in the system's password store; the key itself never comes back, an empty key removes it |
| `suggest_commit_message(repo, opId, onText)` | `string` | Uses the AI settings; streams the cleaned text so far; `cancel_remote_operation(opId)` stops it |
| `list_worktrees(repo)` | `WorktreeInfo[]` | Branch or detached HEAD, locked, missing, main/open flags, number of changed files |
| `add_worktree(repo, path, target)` | `string` | `target`: `newBranch` (name + start), `branch` or `detached`; returns the folder |
| `remove_worktree(repo, path, force)` / `lock_worktree(repo, path, locked, reason)` / `prune_worktrees(repo)` | `()` / `()` / `number` | Never the main worktree or the open one |
| `conflict_file(repo, path)` | `ConflictFile` | Sides, segments (same / ours / theirs / both / conflict) and a fingerprint |
| `resolve_conflict_text(repo, path, content, fingerprint)` | `RepositoryInfo` | Writes the merged text and runs `git add` |
| `resolve_conflict_side(repo, path, side, fingerprint)` | `RepositoryInfo` | `ours`, `theirs` (`checkout --ours/--theirs`, or `rm` when that side deleted the file) or `delete` |
| `rebase_plan_commits(repo, base)` | `PlanCommit[]` | Commits after `base` on the current branch, oldest first |
| `interactive_rebase(repo, base, plan, autostash)` | `IntegrateResult` | Plan: every commit once, oldest first |

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

## Merge, rebase, cherry-pick and revert

`git/integrate.rs` starts these only when no other operation is in progress. Stopping with
conflicts is a result (`conflicts: true`), not an error; the Changes view then shows a banner
with Continue, Skip commit and Abort, and `RepositoryInfo.operationProgress` gives rebase
progress (read from `rebase-merge/msgnum` and `end`).

- Git never opens an editor: merges and reverts use `--no-edit`, and `GIT_EDITOR` and
  `GIT_SEQUENCE_EDITOR` are a no-op (`:`), so prepared messages are used as they are. Continuing
  a merge commits with `--cleanup=strip`, because without an editor Git would otherwise keep its
  `# Conflicts:` comment lines in the message.
- A branch is merged by its short name when that name resolves to exactly that branch (so Git
  writes its usual "Merge branch 'x'" message), and by its full ref otherwise, for example when
  a tag has the same name.
- Local changes in the way are reported as `checkoutConflict` (`git merge` signals this with exit
  status 2 when changes are staged, and 1 otherwise); the UI offers to retry with `--autostash`.
- A cherry-pick or revert whose changes are already on the branch is skipped and reported as up
  to date, so no empty operation is left behind. Merge commits are picked and reverted relative
  to their first parent.
- Several commits are cherry-picked with one `git cherry-pick a b c`, which applies them in the
  order given; the UI sends them oldest first (reverse History order). When Git stops on a
  commit whose changes are already on the branch, Branchline runs `cherry-pick --skip` and the
  sequence goes on. A conflict stops it; Continue picks the rest. Merge commits are refused in a
  multi-pick because `-m 1` would apply to every commit.
- During a rebase the commit box is disabled: a plain commit in the middle of a rebase would add
  an unrelated commit. Continue finishes the step instead.

## Merge editor

- The three-way view comes from the index stages of the unmerged path (1 base, 2 ours,
  3 theirs, listed by `git ls-files -u`), never from parsing conflict markers. Each side is
  compared with the base by `git diff --unified=0 --diff-algorithm=histogram <blob> <blob>`,
  and the hunks are grouped as in diff3 (`conflict.rs`, `build_segments`): changes that overlap
  or touch form one segment, which is a conflict unless both sides made the same change.
  Without a base (added on both sides) every line is new on both sides.
- Lines keep their line endings, so taking every change from one side rebuilds that version
  byte for byte (tested). Typed text uses the file's dominant line ending, and a missing final
  newline stays missing.
- Sides are named for the operation: in a merge, the current branch and the merged branch
  (from `MERGE_MSG`); in a rebase, the branch being rebased onto (stage 2) and the commit
  being replayed (`REBASE_HEAD`, stage 3); in a cherry-pick or revert, the current branch and
  the commit; after a stash apply, "Stashed changes".
- Versions over 1 MB, binary or non-UTF-8 text, symbolic links, submodules and files deleted
  on one side get whole-file choices only.
- `conflict_file` returns a fingerprint of the stages and the working-tree file. Saving
  recomputes it under the write lock and refuses on a mismatch, so a file edited elsewhere in
  the meantime is never overwritten. Writes refuse to go through symbolic links.
- The frontend model (`mergeModel.ts`) keeps, per change, the result lines and whether each
  side was taken, left out or is pending. Taking a second side appends it, like JetBrains.
  Changes that do not conflict are taken on open; Undo goes back to before that.

## Settings

- `settings.json` lives in the platform's configuration folder (`app_config_dir`, for example
  `~/Library/Application Support/dev.branchline.app/` on macOS). It is read once at startup;
  every field has a default, unknown fields are ignored and values are clamped, so an old or
  hand-edited file always loads. Saving writes a temporary file and renames it.
- The backend reads the settings it needs itself (prune on fetch, follow tags on push, diff
  options, editor and terminal commands), so the UI cannot pass different values per call.
- Diff options (context lines, ignore whitespace) apply to what is shown. Staging single lines
  needs the hunks `git apply` expects, so with non-default options line staging is off and
  `apply_lines` always recomputes the diff with the defaults.
- Identity and signing are not stored by Branchline: they are written to Git's own
  configuration (`--global` or `--local`) with `git config`, so the command line agrees.
  Empty values are unset; values with line breaks are refused (they could inject config).
- Opening an editor, terminal or file manager starts the program directly with the path as a
  separate argument; the configured command is split on spaces and quotes, never run by a
  shell. On macOS an editor that is not on the GUI app's `PATH` is retried as an app name.

## Git console

- `git::command_log` records every call made through `run_git_with` and `run_git_streaming`
  (the only two places that start Git): arguments after `git` (without the safety options
  added to every call), folder, start time, duration, exit code, whether the caller accepts
  that code, and the output. An entry is added when the command starts and updated when it
  ends, each time with a new sequence number, so the UI only asks for what changed.
- Limits: the last 500 commands; 8 KB of stdout and 32 KB of stderr per command (sizes are
  reported, so the UI says when output was cut). Arguments and output go through
  `remote::redact`. Stdin is counted, not stored. Nothing is written to disk.
- `is_read_only` marks commands that only read (status, log, diff, `config --get`...).
  Unknown commands count as changes, so they stay visible. The UI hides reads by default but
  always shows failures.
- No events are pushed: the panel polls `git_command_log(since)` once a second while it is
  open, so a closed console costs nothing beyond recording.

## Login shell PATH

- `shell_env` runs `$SHELL -i -l -c` once at startup, in a background thread, with stdin
  closed and a 5 second limit (the whole process group is killed after that). It prints
  `env` between two marker lines, so output from profiles is ignored, and keeps only PATH.
- `merged_path()` puts the shell's folders in front of Branchline's own (no duplicates, no
  relative folders). The runner sets it on every Git command, so hooks (Husky's `npx`,
  Homebrew or nvm tools) behave as in a terminal; `open.rs` uses it for editors and
  terminals. When the shell cannot be asked, the inherited PATH stays.
- The first Git command waits for the answer if it is not ready yet, so a commit made in the
  first seconds still gets the right PATH. Not used on Windows.

## AI providers and commit messages

- `src/ai/provider.rs` talks to the provider chosen in Settings with `ureq`, from the
  backend, so the webview's CSP stays closed to the network:
  - Ollama: `/api/tags`, `/api/version`, `/api/chat` (NDJSON stream).
  - OpenAI-compatible servers (LM Studio, vLLM, llama.cpp, OpenRouter): `GET {base}/models`
    and `POST {base}/chat/completions` with `stream: true` (server-sent events, text in
    `choices[0].delta.content`, ending with `data: [DONE]`). Optional `Bearer` key.
  - OpenAI: the same API at `https://api.openai.com/v1`, without a temperature (reasoning
    models refuse one). Only chat model ids are listed.
  - Anthropic: `GET /v1/models` and `POST /v1/messages` at `https://api.anthropic.com`, with
    `x-api-key` and `anthropic-version: 2023-06-01`. Text comes in `content_block_delta`
    events with a `text_delta`; `message_stop` ends the answer and `error` events become
    readable errors.
- API keys live in the system's password store (`src/secrets.rs`, entries `ai:anthropic`,
  `ai:openai`, `ai:openai-compatible`), read at most once per run, and never reach the
  webview. A key is never sent over plain `http://` to another computer.
- `src/ai/commit.rs` builds the commit message prompt and cleans the answer.
- The prompt holds the staged diff (`git diff --cached`, no external diff or textconv), the
  `--stat` file list, the branch name and the last ten commit subjects. The diff is shortened
  per file (4,000 characters) and in total (14,000), cut at line ends, so one large generated
  file cannot push the rest out. A diff over 4 MB is left out and only the file list is sent.
- The answer streams in. Each piece is cleaned (reasoning in `<think>` blocks, code
  fences, a "Commit message:" label and wrapping quotes are removed) and the cleaned text so
  far is sent to the UI, which fills the summary and description. Generation stops after
  6,000 characters.
- Errors use the `ai` kind with a message that says what to do: start Ollama, pull the
  model, check the address or the key, add API credit, try again when the service is busy.
  Timeouts allow for a local model that takes minutes to load.
- Addresses: `http` or `https`, no credentials; Ollama host and port only, an
  OpenAI-compatible server may have a path (`/v1`) but no query.
  Redirects are not followed; proxies from the environment are skipped for loopback hosts.
- Nothing is contacted while the feature is off, except when the user clicks Test.

## Updates, links and the command palette

- Updates use the Tauri updater plugin. `latest.json` is published with every release
  (docs/releasing.md); the app reads it from the latest GitLab release, checks the minisign
  signature against the public key in `tauri.conf.json`, and installs only after the user
  agrees, then restarts through the process plugin. The automatic check runs once, 8 seconds
  after start, in release builds only, and can be turned off.
- Web links go through the opener plugin, whose permission only allows Branchline's GitLab
  pages, ollama.com, and package pages on npmjs.com and crates.io (from the license list).
- About is a section of Settings. Its license list comes from
  `src/features/about/licenses.json`, written by `npm run licenses`
  (`scripts/licenses.mjs`): the production npm packages (`npm query .prod`) and every crate
  linked on the four release targets (`cargo metadata --filter-platform`, normal
  dependencies only), each with its LICENSE, COPYING or NOTICE texts, identical texts stored
  once. The file is loaded with a dynamic import, so it is a separate chunk read only when
  About opens. CI runs `npm run licenses:check`, which fails when a dependency changed and
  the file was not regenerated.
- The command palette (`features/commands`) builds its list from the same action providers
  the views use (branches, remotes, stashes, tags, worktrees, integrate), so a command and
  its button always behave the same. Matching is a small fuzzy subsequence match that
  prefers word starts. `shortcuts.ts` is the single list of shortcuts shown in the palette
  and the overview.

## Remotes, clone and init

- Remote names follow Git's rules plus no leading dash or dot and no spaces. Addresses must
  not start with a dash (they would be read as options), may not use the `ext::` transport
  (it runs commands), and may not contain a password (`https://user:secret@…`); user names
  alone are fine. Everything is passed after `--`.
- `list_remotes` shows addresses with the user part replaced by `***` (it can be a token).
  `edit_remote` compares the submitted values with those redacted values and only writes what
  actually changed, so saving a dialog with a hidden token never overwrites it with `***`.
- Clone uses the same streaming runner as fetch (progress, cancel, SSH batch mode, no
  prompts) and the same error classification. The destination must be a new folder or an
  empty one; on failure or cancel, a folder Branchline created is deleted and an existing empty
  folder is emptied again.
- Init accepts an existing folder (files stay, untracked) or a new folder whose parent
  exists, refuses a folder that already has `.git`, and sets the first branch with
  `symbolic-ref`, which works on every supported Git version (`init -b` needs 2.28).

## Worktrees

- `git worktree list --porcelain` is the source of truth. Remove, lock and unlock only accept a
  folder that Git lists (compared after resolving symbolic links), so the UI cannot point Git at
  an arbitrary folder. The main worktree and the one open in Branchline are never removed.
- A new worktree's folder must be absolute, have an existing parent, be missing or empty, and
  lie outside the repository (a worktree inside it would show up as untracked files). Branch
  names go through the same checks as new branches, and every path is passed after `--`.
- `git worktree remove` refuses a folder with changes; that becomes `worktreeDirty` and the UI
  asks again before `--force`. Locked worktrees must be unlocked first. A worktree whose folder
  is gone is cleaned up with `git worktree prune`.
- Git refuses to check out a branch that another worktree has (`switch`, `branch -d` and
  `worktree add` all say "used by worktree at" or, in older Git, "checked out at"); these become
  `branchInWorktree` with the folder in `detail`, and the UI offers to open that worktree.
  `list_branches` adds `worktreePath` to such branches.
- A linked worktree opens like any repository: its Git directory (`.git/worktrees/<name>`)
  holds its own HEAD, index and in-progress operations, while branches, tags and stashes are
  shared.

## Interactive rebase

`git/rebase_plan.rs` builds the rebase plan itself and runs `git rebase --interactive` with
`GIT_SEQUENCE_EDITOR='cat "$BRANCHLINE_REBASE_PLAN" >'`: Git's "editor" only copies the prepared
plan over its todo file. The plan's path is in an environment variable, so it is never parsed by
the shell. Before anything runs, the plan is checked against the current commits: each commit
after the base exactly once (a plan made before a new commit appeared is refused), at least one
commit kept, and no squash or fixup without an earlier kept commit. Ranges with merge commits are
refused.

Rewording is a `pick` followed by `exec git commit --amend --no-verify --cleanup=strip
--file=<path>`; the message is written to a file in the Git directory and the path is quoted for
the shell (a test uses a repository folder named `it's a $HOME repo`). These files and the plan are
removed when the rebase finishes or is aborted, also when it finishes later through Continue.

Drag and drop uses HTML5 drag events with a private data type, so only branches dragged inside
Branchline are accepted. The window sets `dragDropEnabled: false`: Branchline accepts no file
drops, and Tauri's file-drop handling would otherwise intercept in-page drags on Windows.

## Tags

Tag names get the same validation as branch names (`git check-ref-format` plus no leading dash),
and are passed after `--`. Targets are commit ids, never revision expressions. Messages go in as
`--message=<text>`, so a message can never be read as an option. `push_tag` pushes
`refs/tags/<name>:refs/tags/<name>` without force: a different tag with the same name on the
remote is reported as `tagConflict` instead of being replaced. Deleting a tag that is already gone
on the remote counts as done (Git reports that as an error in some versions and as a warning in
others).

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

### Search and filters

- `LogFilter` has a text (message, author or start of a commit id), an author, a file or folder,
  a date range (`YYYY-MM-DD`, inclusive days) and "current branch only". Input is validated:
  no control characters, at most 200 characters, paths through `validate_relative`, dates in
  that exact form. Values are passed as `--grep=`, `--author=` and `--since=` arguments and after
  `--`, so text can never become an option; `--fixed-strings` and `--regexp-ignore-case` make
  them plain, case-insensitive text.
- The author, path, dates and branch go into one `rev-list` (all must match). The text is matched
  in separate lookups (message, author, commit id prefix) and combined, because Git requires
  both `--grep` and `--author` to match when given together.
- The matching ids are kept in the cached history order (so results stay in graph order) and
  cached per filter, so paging through results costs the same as paging through history. The
  UI shows results without graph lines; neighbours in a result list are rarely parent and child.
- The UI waits until typing pauses (300 ms) before searching. Search and filters are kept per
  repository while switching views. "Show file history" sets the path filter and opens History.

## Diff layout and syntax highlighting

- `splitRows` pairs a block of removed lines with the added lines that follow it, top to bottom,
  and fills the shorter side with empty rows. Rows keep hunk and line indices, so line selection,
  hunk actions and partial staging are the same code in both layouts.
- Side by side uses two scroll containers with the same virtual window: the right one drives it,
  the left one follows its vertical position, and each scrolls sideways on its own.
- Syntax highlighting uses highlight.js grammars through `lowlight`, loaded with a dynamic import
  on first use (its own bundle chunk). Each hunk is highlighted twice, as the old text (unchanged
  and removed lines) and the new text (unchanged and added lines), and the result is split back
  into lines. Tokens are only used when they rebuild the line exactly. Diffs over 400 KB or
  with lines over 2,000 characters are not highlighted. Conflict views stay plain.
- The layout and highlighting are settings (`editor.diffLayout`, `editor.syntaxHighlighting`).
  Unknown values in a hand-edited settings file fall back to the default for that field only.
