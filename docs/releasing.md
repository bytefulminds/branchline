# Releasing

A release is a version tag. GitLab CI builds the installers on Linux, macOS and Windows,
uploads them, writes `latest.json` for the updater and creates the GitLab release with the
CHANGELOG section as its description.

## Make a release

1. Write the release notes in `CHANGELOG.md` under `## [x.y.z] - date` (move them out of
   `[Unreleased]`).
2. Set the version everywhere: `node scripts/release/bump-version.mjs x.y.z`
3. Commit, then tag and push:

   ```sh
   git commit -am "chore: release x.y.z"
   git tag vx.y.z
   git push origin main vx.y.z
   ```

4. Follow the pipeline. When `release` is green, the release page lists the installers, and
   apps that have "Check for updates" on find the new version shortly after they start.

The `release` job refuses to publish when the tag and the version in `tauri.conf.json`
differ.

## Pipeline

| Job | Runs on | Does |
|---|---|---|
| `check` | every pipeline, GitLab shared runner | `npm run check` (types, lint, format, all tests) and clippy |
| `build:linux` | tags, shared runner (Docker) | AppImage, `.deb`, `.rpm` |
| `build:macos` | tags, group runner tagged `macos` | One universal app (Apple silicon and Intel): `.dmg` and the update archive |
| `build:windows` | tags, group runner tagged `windows` | NSIS `.exe` and `.msi` installers |
| `release` | tags | `latest.json`, upload to the package registry, GitLab release |
| `measure:*` | tags, after each build | Startup and interaction times per platform (`perf-*.json`), allowed to fail |

Files are stored in the project's generic package registry under
`packages/generic/branchline/<version>/`. The release links each file, and links
`latest.json` with the path `/latest.json`, so the newest one is always at
`https://gitlab.com/bytefulminds/branchline/-/releases/permalink/latest/downloads/latest.json`.
The project (and its releases and packages) must be public for the updater and for
downloads without signing in.

## One-time setup

### CI/CD variables (Settings > CI/CD > Variables)

| Variable | Value | Flags |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `_secrets/branchline-updater.key` | Masked, Protected |
| `MACOS_RUNNER_TAG` | the tag of the macOS group runner, if not `macos` | |
| `WINDOWS_RUNNER_TAG` | the tag of the Windows group runner, if not `windows` | |

Protect the tags `v*` (Settings > Repository > Protected tags), so protected variables
are available to tag pipelines and only maintainers can release.

### Runners

The macOS and Windows runners use the shell executor and need, on the machine:

- macOS: Xcode command line tools, Rust (`rustup`), Node.js 22.
- Windows: Visual Studio Build Tools with "Desktop development with C++", Rust (`rustup`,
  MSVC toolchain), Node.js 22, WebView2 (part of Windows 10 and 11). Tauri downloads NSIS
  and WiX itself.

### The update key

Updates are signed with Branchline's own key (minisign, not an OS certificate). The public
half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), and every installed copy
accepts only updates signed with the private half. Keep the private key safe and backed up:

- it lives in `_secrets/branchline-updater.key` on the maintainer's machine (never in Git)
  and in the `TAURI_SIGNING_PRIVATE_KEY` variable;
- if it is lost, installed copies cannot be updated any more; users would have to install
  the next version by hand, after which a new key can be used.

The key has no password; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is set to empty in
`.gitlab-ci.yml`.

## Code signing (not set up yet)

Branchline is not signed with Apple or Microsoft certificates. macOS builds are signed ad
hoc, so they run on Apple silicon, but Gatekeeper asks the user to confirm the first launch;
Windows SmartScreen asks too. The README tells users what to do.

To sign later, add these variables; no pipeline changes are needed, Tauri reads them:

- **macOS** (Apple Developer Program): `APPLE_CERTIFICATE` (base64 of the `.p12`),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` ("Developer ID Application: ..."),
  and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
  `APPLE_TEAM_ID`. The identity overrides the ad hoc `-` in `tauri.release.conf.json`.
- **Windows**: a code signing certificate (or Azure Trusted Signing) configured with
  `bundle.windows.certificateThumbprint` or a `signCommand` in `tauri.release.conf.json`,
  with the certificate installed on the Windows runner.

## Builds on your own machine

`npm run app:build` builds installers for the current platform without the updater files,
so it does not need the update key. To test the release configuration locally, set
`TAURI_SIGNING_PRIVATE_KEY` and run
`npx tauri build --config src-tauri/tauri.release.conf.json`.
