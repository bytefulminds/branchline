<p align="center">
  <img src="public/branchline-mark.svg" width="72" alt="Branchline logo" />
</p>

<h1 align="center">Branchline</h1>
<p align="center"><em>See the flow of your code.</em></p>

Branchline is a fast, local-first, open-source Git desktop client for Windows, macOS and Linux.
It is built with Tauri 2, React, TypeScript and Rust, and drives the native Git CLI instead of
reimplementing Git.

> **Status:** early development. Milestones 0 to 4 are complete and Milestone 5 is in progress:
> Branchline opens a local repository, stages files, hunks and lines, creates and amends commits,
> shows the full history with a commit graph, manages branches, fetches, pulls and pushes, and
> manages stashes and tags, and merges, rebases, cherry-picks and reverts. See [ROADMAP.md](ROADMAP.md).

## What works today

- Open a repository with the native folder picker (`Ctrl+O` / `⌘O`), from the recent list, or
  from the command line (`branchline /path/to/repo`). Selecting a subfolder opens the repository
  root.
- Clone a repository from an address (HTTPS, SSH or a local path) with progress and Stop, or
  create a new one in a new or existing folder, from the welcome screen or the repository menu.
  A failed or stopped clone leaves no files behind.
- Current branch, detached HEAD and repositories without commits.
- Upstream tracking with ahead/behind counts, including upstreams that no longer exist.
- Changed files from `git status`: modified, added, deleted, renamed (with source path), copied,
  type changes, untracked and conflicted files, split into conflicts, unstaged and staged.
- In-progress merge, rebase, cherry-pick, revert and bisect detection.
- Last commit summary, author and date.
- Diff viewer for unstaged, staged and untracked files, with line numbers, hunk headers, CRLF and
  "no newline at end of file" handling, binary detection and a guard for very large diffs.
- One column or side by side (toggle above every diff, remembered). Side by side pairs removed
  and added lines; both columns scroll together and each scrolls sideways on its own. Staging
  hunks and lines works the same in both layouts.
- Syntax highlighting for about 40 languages, chosen by file name. The grammars load on first
  use; diffs over 400 KB or with very long (minified) lines stay plain.
- Stage, unstage and discard whole files, single hunks or selected lines (click, shift-click for
  a range). Discarding always asks for confirmation; staged content is never discarded.
- Drag the line above the commit summary to make the message box taller or shorter (the
  description fills the space, the size is remembered; double-click resets it).
- Conflicted files show their conflict markers and can be marked as resolved, or resolved in
  the merge editor (below).
- File filter, keyboard navigation in the file list (`Space`/`Enter` stages or unstages, `Delete`
  discards), resizable panels, a virtualized list that stays fast with thousands of files.
- Automatic refresh through a file-system watcher (changes made in your editor or terminal show up
  within a second), plus `Ctrl+R` / `⌘R` / `F5`. No polling.
- Clear loading, empty, error and "Git not installed" states.

- Commit and amend from the Changes view: summary and description, a length hint, merge
  messages prefilled, `Ctrl+Enter` / `⌘↵`, and clear errors for missing identity or failing hooks.
- History of all branches, remote branches and tags with a commit graph, ref badges, authors and
  dates. Fast on large repositories: the list is virtualized and loads page by page.
- Search History (`Ctrl+F` / `⌘F`) by message, author or commit id, and filter by author, file
  or folder, date range and the current branch only. Results load page by page like the full
  history, and matches are marked. "Show file history" on a diff opens the commits that
  changed that file.
- Commit details: full message, author and committer, parents, changed files with line counts,
  and a read-only diff per file.
- Branches: list local and remote branches with upstream and ahead/behind, then create, switch,
  rename and delete them. Remote branches check out as tracking branches; unmerged branches need a
  second confirmation before deletion; switching never overwrites uncommitted work.
- Quick branch switcher in the title bar, and right-click (or `Shift+F10`) on a commit to create
  a branch there or check it out.
- Fetch, Pull and Push in the title bar, with ahead/behind counts. Pull fast-forwards by default,
  or merges or rebases on request; a branch without upstream is published to the remote you
  choose. Force push is only possible with lease, after a confirmation.
- Live progress (phase and percentage) in the status bar, and Cancel for every fetch, pull and
  push.
- Clear messages for failed sign-in, unknown SSH hosts, unreachable or missing remotes, rejected
  pushes and diverged branches, with the next step offered where there is one.
- Stashes: stash changes with a message (untracked files included by choice), then apply, pop or
  delete them. The Stashes view shows every stash with its files and diffs. Stash and Pop are
  also in the title bar.
- When local changes block a pull or a branch switch, Branchline offers "Stash, pull and
  reapply" or "Stash and switch" instead of leaving you stuck.
- Tags: create lightweight or annotated tags (from the Tags view or on any commit in History),
  push them, delete them locally or on a remote, check them out or start a branch from them.
  Pushing never overwrites a different tag with the same name on the remote.
- Merge a branch or commit into the current branch (optionally always with a merge commit),
  rebase onto a branch or commit, cherry-pick and revert commits, from the Branches view and the
  History context menu. Rebasing a published branch warns that a force push will follow.
- Interactive rebase ("Rebase interactively from here…" on a commit in History): drag commits
  into a new order (or use `Alt+↑` / `Alt+↓`), and pick, reword, squash, fix up or drop each one.
  Branchline checks the plan before Git runs it.
- Select several commits in History (`Ctrl`/`⌘`+click to add one, `Shift`+click or
  `Shift+↑`/`↓` for a range, `Esc` to go back to one) and cherry-pick them in one go. They are
  applied oldest first; commits already on the branch are skipped, and a conflict stops the
  sequence until you Continue.
- Drag a branch (in Branches, or its label in History) onto another branch or a commit to merge
  or rebase; a menu offers what is possible from there.
- When an operation stops with conflicts, a banner shows what is left (with rebase progress, for
  example "commit 2 of 5") and offers Continue, Skip commit and Abort. Local changes in the way
  can be stashed and reapplied automatically.
- Merge editor for conflicts, in the style of JetBrains' merge tool: your side on the left, the
  result in the middle and the incoming side on the right, each named for the operation (for
  example "main" and "feature/x" in a merge, or the commit being cherry-picked). Changes that do
  not conflict are taken right away; for each conflict, take one side (`»` / `«`), both, or
  neither, or type the result yourself. Undo and redo, `Alt+↑` / `Alt+↓` (or `F7`) between
  changes, "Use all" for one side's whole file, and editing the whole result as text. Saving
  writes the file and marks it as resolved; it refuses if the file changed since the editor
  opened it. Binary files, symbolic links and files deleted on one side get whole-file choices
  (keep one version or delete the file).
- Remotes: list them with their addresses and branch counts, fetch one or all, add a remote
  (optionally fetching it right away), rename it or change its fetch and push addresses, and
  remove it. Addresses are shown without user names or tokens, and a hidden token is kept
  when you save. Passwords in addresses are refused; use a credential helper instead.
- Worktrees: extra working folders for the same repository, each with its own branch checked
  out. Create one with a new branch (from the current branch, any branch or a commit in
  History) or for an existing branch, open it in Branchline, lock or unlock it, and remove it
  (the branch stays; uncommitted changes are only deleted after a second confirmation).
  Worktrees whose folder was deleted can be cleaned up. Branches checked out in another
  worktree are marked in Branches and offer "Open worktree" instead of Switch.
- Settings (`Ctrl+,` / `⌘,`, or the gear in the title bar), saved right away:
  - General: reopen the last repository on start, refresh when the window gets focus, fetch
    in the background every 5 to 60 minutes (quietly; an error is shown once).
  - Git: what the Pull button does (fast-forward, merge or rebase), prune deleted remote
    branches on fetch, push annotated tags with commits.
  - Identity and signing: name, email and commit signing (GPG, SSH or X.509), for all
    repositories (`~/.gitconfig`) or only the open one.
  - Editor and diff: the editor and terminal that "Open in editor", "Open in terminal" and
    "Show in Finder/Explorer" use (repository menu, and a button on each changed file),
    diff layout, syntax highlighting, context lines, ignoring whitespace, tab width and code
    font size.
  - Confirmations: turn off the questions before discarding, force pushing, rebasing a
    published branch or deleting a branch. Deleting unmerged work always asks.
  - AI commit messages: connect your own [Ollama](https://ollama.com) server (local or on
    your network), test the connection, pick a model, the style (Conventional Commits or
    plain), the language and extra team instructions.
- Commit message suggestions: with AI commit messages on, "Suggest message" in the commit box
  writes a summary and description for the staged changes with your Ollama model. The text
  streams in, Esc or Stop cancels it, and a message you had typed can be restored with Undo.
- `Ctrl+1` / `⌘1` Changes, `Ctrl+2` / `⌘2` History, `Ctrl+3` / `⌘3` Branches, `Ctrl+4` / `⌘4`
  Stashes, `Ctrl+5` / `⌘5` Tags, `Ctrl+6` / `⌘6` Worktrees, `Ctrl+7` / `⌘7` Remotes.

## Prerequisites

| | |
|---|---|
| Git | 2.20 or newer on `PATH` (Branchline also checks common install locations) |
| Node.js | 20 or newer (22 LTS recommended) |
| Rust | stable, 1.77 or newer (`rustup` recommended) |

Platform requirements for Tauri 2 (full details: <https://v2.tauri.app/start/prerequisites/>):

- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Windows:** Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11).
- **Linux (Debian/Ubuntu):**
  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

## Getting started

```sh
npm install
npm run app:dev            # run the desktop app with hot reload
npx tauri dev -- -- /path/to/repo     # open a repository on launch
```

`npm run dev` starts only the web frontend in a browser. It renders, but Git features need the
desktop shell and will say so.

## Scripts

| Command | What it does |
|---|---|
| `npm run app:dev` | Desktop app in development mode |
| `npm run app:build` | Production build and installers for the current platform |
| `npm run check` | Typecheck, lint, format check, frontend tests and Rust tests |
| `npm test` | Frontend tests (Vitest + Testing Library) |
| `npm run test:rust` | Rust unit and integration tests (uses temporary Git repositories) |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` | Rust lints |
| `cargo run --release --manifest-path src-tauri/Cargo.toml --example inspect -- <repo> [runs]` | Time repository inspection |

## Project structure

```
docs/                    Design system notes and architecture
public/                  Static assets (logo mark)
src/                     React + TypeScript frontend
  components/            Shared UI components (Button, Menu, Badge, Toast, Splitter, ...)
  features/repository/   Repository state, welcome, loading and error views
  features/changes/      Changed-file model, list, diff and commit box
  features/history/      Commit list, graph and commit details
  features/branches/     Branch list, switcher and branch dialogs
  features/remote/       Remotes view and dialog; fetch, pull and push toolbar and actions
  features/stash/        Stashes view, stash dialog and actions
  features/tags/         Tags view, tag dialog and actions
  features/integrate/    Merge, rebase, cherry-pick, revert and the operation banner
  features/conflicts/    Merge editor (three panes) and its model
  features/worktrees/    Worktrees view, new worktree dialog and actions
  features/settings/     Settings screen and provider
  layouts/               Window shell: title bar, sidebar, status bar, window controls
  services/              IPC wrappers, dialog, platform, local preferences
  styles/                Design tokens and base styles
  types/                 IPC contract types (mirror the Rust models)
src-tauri/               Rust backend
  src/git/runner.rs      Safe Git process execution (timeouts, no shell, hardened config)
  src/git/status.rs      `git status --porcelain=v2 -z` parser
  src/git/repository.rs  Repository inspection and models
  src/git/remote.rs      Remotes, fetch, pull and push
  src/git/stash.rs       Stash save, apply, pop and drop
  src/git/tags.rs        Tag list, create and delete
  src/git/integrate.rs   Merge, rebase, cherry-pick, revert; continue, skip, abort
  src/git/rebase_plan.rs Interactive rebase plans
  src/git/conflict.rs    Three-way view of a conflicted file; saving its resolution
  src/git/worktrees.rs   Worktree list, add, remove, lock and prune
  src/git/create.rs      Clone and init
  src/git/identity.rs    user.name, user.email and commit signing (global or per repository)
  src/settings.rs        Settings file (JSON in the app's configuration folder)
  src/open.rs            Open in editor or terminal, show in the file manager
  src/ai.rs              Commit message suggestions from an Ollama server
  src/commands.rs        Tauri IPC commands (async, off the UI thread)
  src/error.rs           Error model shared with the frontend
  tests/                 Integration tests against real temporary repositories
```

See [docs/architecture.md](docs/architecture.md) for how the layers fit together and
[docs/design-system.md](docs/design-system.md) for the design tokens and component rules.

## Security

- Git runs as a subprocess with an argument vector, never through a shell. Paths are passed as
  literal pathspecs, so a file called `*.txt` never matches other files.
- Interactive prompts are disabled (`GIT_TERMINAL_PROMPT=0`, empty askpass), so commands cannot hang.
- `core.fsmonitor` is forced off for every command, because a cloned repository could otherwise
  make `git status` execute an arbitrary program. A test proves the hook does not run.
- Environment variables that redirect Git (`GIT_DIR`, `GIT_WORK_TREE`, ...) are removed.
- Paths from the UI are validated and canonicalized before use; every command has a timeout.
  Paths that escape the repository (`..`, absolute paths) or point into `.git` are rejected.
- Diffs ignore external diff drivers and textconv filters configured in the repository.
- Partial staging never trusts line content sent by the UI: the backend recomputes the diff,
  checks a fingerprint of the version the user saw, and rebuilds the patch itself.
- Discard re-reads the repository state first and only touches unstaged changes.
- Network commands never prompt: SSH runs in batch mode unless you configured your own SSH
  command, and HTTPS uses your credential helper. Credentials in remote URLs are removed before
  anything reaches the UI, including error messages.
- Force push always uses `--force-with-lease`, so it cannot overwrite commits you have not
  fetched.
- AI suggestions only contact the Ollama server you configured, only when you ask for a
  suggestion (or test the connection), and only send the staged diff (shortened), the list of
  changed files, the branch name and recent commit subjects. Unstaged files are never sent.
  The address may not contain credentials, redirects are not followed, and system proxies
  are skipped for `localhost`. Settings warn when the server is not on this computer.
- The webview has a strict CSP and only the Tauri permissions it needs (window controls and the
  folder picker).

## Performance

Measured, not assumed. Inspection runs `rev-parse` twice, `status` once and `show` once.

| Repository | Changed paths | Median inspect time |
|---|---|---|
| Small demo repository | 5 | 22 ms |
| git/git (82k commits, 4.9k files) | 500 | 33 ms |
| Synthetic, 12,000 untracked files | 12,000 (10,000 returned) | 34 ms |

Release build, Linux x86_64 container, warm file cache, 10 runs each
(`examples/inspect.rs`).

History on git/git (85,000 commits, 1,021 refs), `examples/history.rs`:

| | First page (300 commits) | Every later page, at any depth |
|---|---|---|
| Without a commit-graph file (fresh clone) | 1.03 s | about 30 ms |
| With a commit-graph file (`git commit-graph write --reachable`) | 0.30 s | about 33 ms |

The first page includes one walk over the whole history to get the correct order (children
before parents), which Git can only do quickly with a commit-graph file. Git writes that file
during `git gc` and `git maintenance`; Branchline does not write it for you. Numbers on your machine will differ; macOS and Windows have not been
measured yet.

Startup (release build, same container, Xvfb with software rendering and no GPU): the window maps
within 50 ms and the first UI frame is painted after about 1.1 s (5 runs, 1.06 to 1.12 s,
measured by polling screenshots). This is a pessimistic environment; a native desktop measurement
is still to do.

## Known limitations

- New worktrees go in a folder outside the repository. Branchline shows one repository (or
  worktree) per window; opening a worktree switches the window to it.
- The Tags view shows local tags; it does not show which of them already exist on a remote.
- The merge editor works on text files up to 1 MB; larger files, binary files and symbolic
  links are resolved by keeping one side's version. It has no syntax highlighting and no
  word-level highlighting yet. A bisect can only be stopped from Branchline.
- Interactive rebase cannot include merge commits, and cannot stop to edit a commit's content
  (`edit`); it covers reorder, reword, squash, fixup and drop. Reworded commits skip the
  `pre-commit` and `commit-msg` hooks, like Git's own reword skips `pre-commit`.
- Merge commits cannot be part of a multi-commit cherry-pick; pick them one at a time. At most
  100 commits are picked at once.
- Applying a stash restores staged and unstaged changes separately when Git can; when it
  cannot, everything comes back unstaged. A staged rename that Git puts aside during a pull
  returns as a deleted and an added file.
- Branchline does not ask for passwords. HTTPS remotes need a credential helper (macOS Keychain
  and Git Credential Manager work), SSH keys need an agent or no passphrase, and a new SSH host
  has to be verified once from a terminal.
- One Git operation runs at a time: during a fetch, pull or push, staging waits. On Windows,
  cancelling stops Git itself; its SSH or HTTPS helper exits shortly after.
- The graph shows up to 12 lanes; further lanes are clipped. Merge commits list the files changed
  relative to their first parent.
- Search results are shown without graph lines, because the commits in between are hidden.
  File history follows the path given and does not follow renames.
- Syntax highlighting colors each hunk on its own, so a comment or string that starts above a
  hunk is not recognized inside it.
- Hunk and line operations are not available for untracked files, renames, copies and binary
  files; those are staged as a whole.
- The watcher only applies the root `.gitignore` and `.git/info/exclude` when filtering events;
  changes in folders ignored by nested `.gitignore` files cause an extra (cheap) refresh.
- The changed-file list is capped at 10,000 entries.
- Bare repositories are not supported.
- Paths that are not valid UTF-8 are shown with replacement characters.
- Runs on macOS and Linux; Windows has not been run yet. Automated tests and measurements so far
  ran on Linux.

## License

[MIT](LICENSE)
