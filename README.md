<p align="center">
  <img src="public/branchline-mark.svg" width="72" alt="Branchline logo" />
</p>

<h1 align="center">Branchline</h1>
<p align="center"><em>See the flow of your code.</em></p>

Branchline is a fast, local-first, open-source Git desktop client for Windows, macOS and Linux.
It is built with Tauri 2, React, TypeScript and Rust, and drives the native Git CLI instead of
reimplementing Git.

> **Status:** early development. Milestones 0 and 1 are complete: Branchline opens a local
> repository and shows its real working-tree state. See [ROADMAP.md](ROADMAP.md).

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
- File filter, keyboard navigation in the file list, resizable panels.
- Refresh with `Ctrl+R` / `⌘R` / `F5`, plus an automatic (throttled) refresh when the window
  regains focus. No polling.
- Clear loading, empty, error and "Git not installed" states.

Diffs, staging, commits, history and the commit graph follow in the next milestones.

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
  features/changes/      Changed-file model, list and details panel
  layouts/               Window shell: title bar, sidebar, status bar, window controls
  services/              IPC wrappers, dialog, platform, local preferences
  styles/                Design tokens and base styles
  types/                 IPC contract types (mirror the Rust models)
src-tauri/               Rust backend
  src/git/runner.rs      Safe Git process execution (timeouts, no shell, hardened config)
  src/git/status.rs      `git status --porcelain=v2 -z` parser
  src/git/repository.rs  Repository inspection and models
  src/commands.rs        Tauri IPC commands (async, off the UI thread)
  src/error.rs           Error model shared with the frontend
  tests/                 Integration tests against real temporary repositories
```

See [docs/architecture.md](docs/architecture.md) for how the layers fit together and
[docs/design-system.md](docs/design-system.md) for the design tokens and component rules.

## Security

- Git runs as a subprocess with an argument vector, never through a shell.
- Interactive prompts are disabled (`GIT_TERMINAL_PROMPT=0`, empty askpass), so commands cannot hang.
- `core.fsmonitor` is forced off for every command, because a cloned repository could otherwise
  make `git status` execute an arbitrary program. A test proves the hook does not run.
- Environment variables that redirect Git (`GIT_DIR`, `GIT_WORK_TREE`, ...) are removed.
- Paths from the UI are validated and canonicalized before use; every command has a timeout.
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
(`examples/inspect.rs`). Numbers on your machine will differ; macOS and Windows have not been
measured yet.

Startup (release build, same container, Xvfb with software rendering and no GPU): the window maps
within 50 ms and the first UI frame is painted after about 1.1 s (5 runs, 1.06 to 1.12 s,
measured by polling screenshots). This is a pessimistic environment; a native desktop measurement
is still to do.

## Known limitations

- Diffs, staging, committing, history, graph, branches and remotes are not implemented yet; their
  navigation entries are visible but disabled.
- The changed-file list renders all rows (with `content-visibility`), capped at 10,000 entries.
  Real virtualization is planned with the commit list.
- Bare repositories are not supported.
- Paths that are not valid UTF-8 are shown with replacement characters.
- Runs on macOS and Linux; Windows has not been run yet. Automated tests and measurements so far ran on Linux.

## License

[MIT](LICENSE)
