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
- **No polling.** Refresh happens on user action and on window focus (throttled to one per 2 s).
  A file-system watcher is planned once staging lands.

## IPC commands

| Command | Returns | Notes |
|---|---|---|
| `git_version` | `GitVersion` | Resolves the Git binary, enforces Git 2.20+ |
| `inspect_repository(path)` | `RepositoryInfo` | Validates the path, resolves the repository root |
| `launch_repository_path` | `string \| null` | First positional command-line argument |

## Extending later

Coding-agent integration is out of scope for now. Because every Git operation already goes through
`git::runner` and is exposed as an explicit command, an agent can later be added as another client
of the same service layer (with its own permission set) without changing the UI architecture.
