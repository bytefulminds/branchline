<p align="center">
  <img src="public/branchline-mark.svg" width="72" alt="Branchline logo" />
</p>

<h1 align="center">Branchline</h1>
<p align="center"><em>See the flow of your code.</em></p>

Branchline is a fast, local-first, open-source Git desktop client for Windows, macOS and Linux.
It is built with Tauri 2, React, TypeScript and Rust, and drives the native Git CLI instead of
reimplementing Git.

> **Status:** early development. Milestones 0 to 4 are complete: Branchline opens a local
> repository, stages files, hunks and lines, creates and amends commits, shows the full history
> with a commit graph, manages branches, and fetches, pulls and pushes. See [ROADMAP.md](ROADMAP.md).

## What works today

- Open a repository with the native folder picker (`Ctrl+O` / `⌘O`), from the recent list, or
  from the command line (`branchline /path/to/repo`). Selecting a subfolder opens the repository
  root.
- Current branch, detached HEAD and repositories without commits.
- Upstream tracking with ahead/behind counts, including upstreams that no longer exist.
- Changed files from `git status`: modified, added, deleted, renamed (with source path), copied,
  type changes, untracked and conflicted files, split into conflicts, unstaged and staged.
- In-progress merge, rebase, cherry-pick, revert and bisect detection.
- Last commit summary, author and date.
- Diff viewer for unstaged, staged and untracked files, with line numbers, hunk headers, CRLF and
  "no newline at end of file" handling, binary detection and a guard for very large diffs.
- Stage, unstage and discard whole files, single hunks or selected lines (click, shift-click for
  a range). Discarding always asks for confirmation; staged content is never discarded.
- Conflicted files show their conflict markers and can be marked as resolved.
- File filter, keyboard navigation in the file list (`Space`/`Enter` stages or unstages, `Delete`
  discards), resizable panels, a virtualized list that stays fast with thousands of files.
- Automatic refresh through a file-system watcher (changes made in your editor or terminal show up
  within a second), plus `Ctrl+R` / `⌘R` / `F5`. No polling.
- Clear loading, empty, error and "Git not installed" states.

- Commit and amend from the Changes view: summary and description, a length hint, merge
  messages prefilled, `Ctrl+Enter` / `⌘↵`, and clear errors for missing identity or failing hooks.
- History of all branches, remote branches and tags with a commit graph, ref badges, authors and
  dates. Fast on large repositories: the list is virtualized and loads page by page.
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
- `Ctrl+1` / `⌘1` Changes, `Ctrl+2` / `⌘2` History, `Ctrl+3` / `⌘3` Branches.

Advanced workflows (stash, tags, merge and rebase tools) follow next.

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
  features/remote/       Fetch, pull and push toolbar and actions
  layouts/               Window shell: title bar, sidebar, status bar, window controls
  services/              IPC wrappers, dialog, platform, local preferences
  styles/                Design tokens and base styles
  types/                 IPC contract types (mirror the Rust models)
src-tauri/               Rust backend
  src/git/runner.rs      Safe Git process execution (timeouts, no shell, hardened config)
  src/git/status.rs      `git status --porcelain=v2 -z` parser
  src/git/repository.rs  Repository inspection and models
  src/git/remote.rs      Remotes, fetch, pull and push
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

- Tags, stashes and worktrees are not implemented yet, and remotes cannot be added or edited
  in Branchline yet; their navigation entries are visible but disabled.
- Branchline does not ask for passwords. HTTPS remotes need a credential helper (macOS Keychain
  and Git Credential Manager work), SSH keys need an agent or no passphrase, and a new SSH host
  has to be verified once from a terminal.
- One Git operation runs at a time: during a fetch, pull or push, staging waits. On Windows,
  cancelling stops Git itself; its SSH or HTTPS helper exits shortly after.
- The graph shows up to 12 lanes; further lanes are clipped. Merge commits list the files changed
  relative to their first parent.
- History cannot be searched or filtered yet.
- The diff view is unified only (no side-by-side view yet) and has no syntax highlighting yet.
- Hunk and line operations are not available for untracked files, renames, copies and binary
  files; those are staged as a whole.
- Conflicts can be inspected and marked as resolved, but not edited inside Branchline yet.
- The watcher only applies the root `.gitignore` and `.git/info/exclude` when filtering events;
  changes in folders ignored by nested `.gitignore` files cause an extra (cheap) refresh.
- The changed-file list is capped at 10,000 entries.
- Bare repositories are not supported.
- Paths that are not valid UTF-8 are shown with replacement characters.
- Runs on macOS and Linux; Windows has not been run yet. Automated tests and measurements so far
  ran on Linux.

## License

[MIT](LICENSE)
