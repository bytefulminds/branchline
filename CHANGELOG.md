# Changelog

All notable changes to Branchline. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). The section of a version is also its release
description on GitLab.

## [Unreleased]

### Added

- Review quest (with AI on): Start review quest on a merge request opened in Branchline. For
  every changed file the AI asks one to three questions (quiz, true or false, find the line,
  and open questions it responds to), and may suggest review comments. Click any changed
  line to write a draft comment. Points, coverage and a summary with your draft comments,
  saved per merge request. Binary, generated and lock files are left out, and above 40 files
  the largest changes come first.
- Review my branch: the same quest on your own branch's commits before you open a merge
  request, from Changes, Branches, History or the command palette.
- Bitbucket Cloud: connect with your Atlassian email and an API token, see the pull requests
  to review, yours and all open ones, read them in Branchline (also from forks) and play the
  review quest on them.

### Changed

- Changes: the AI review button now says **Review with AI** instead of showing only an icon.

## [0.2.5] - 2026-11-03

Clean up a branch before you share it with Rewrite history, read merge requests to review in
Branchline, and choose your AI: Ollama, any OpenAI-compatible server, Claude or GPT.

### Added

- Rewrite history: on the newest commit of the current branch (in History, Branches or the
  command palette), Branchline opens the interactive rebase for only that branch's own
  commits: from where the branch was created, or where it forked from the nearest other
  branch. It warns when some of them are already pushed.
- Interactive rebase shows squashed and fixed-up commits indented above the commit they go
  into, and the combined commit can get a message of its own.
- With AI on, the interactive rebase can suggest which commits to combine, with a message for
  each resulting commit, to review before it runs.
- More room in small windows: the History columns Author, Date and Commit can be resized and
  hidden (right-click the headings), the Graph column can be narrowed (lanes that do not fit
  fade out), the commit details panel can be hidden, and the sidebar
  collapses to icons (`Ctrl+B` / `⌘B`). A description that does not fit shows in full on
  hover.
- Reviews (`Ctrl+7` / `⌘7`): the open merge requests on GitLab where you are a reviewer, for
  the repository's project or all projects, with their pipeline, comments, drafts, conflicts
  and whether you already approved. Connect your GitLab account (GitLab.com or your own
  server) with a personal access token in the new Settings > Accounts; the token is kept in
  the system's password store. Three lists: to review (your own merge requests too, when you
  are their reviewer), created by you, and all open in the project, each with its reviewers.
  The lists refresh when Branchline gets focus.
- Read a merge request in Branchline: Open in Reviews fetches its commits with your Git
  credentials and shows the description, discussion, commits and changed files, and each
  file's diff (one column or side by side) with its comment threads.
- The Git console also lists every request Branchline sends to GitLab, with its status and
  response (never the token).
- AI providers: besides Ollama, commit messages can now come from any server with an
  OpenAI-compatible API (LM Studio, vLLM, llama.cpp, OpenRouter), from Anthropic (Claude) or
  from OpenAI. API keys are kept in the system's password store. Settings explains that a
  Claude or ChatGPT subscription does not include the API, and links to where keys are made.
- The branch menu in the title bar also lists remote branches without a local branch, to
  check one out in one click.

### Changed

- Changes lists staged files above unstaged ones, so what goes into the next commit is on
  top.
- In a narrow window, History gives the description room first: Commit, Date and Author make
  way, and the commit details panel shrinks.
- Reviews is shown whenever a GitLab account is connected. In a repository without a remote
  on that server, it lists your merge requests in all projects there.
- Settings > AI commit messages is now Settings > AI, with a general "Use AI" switch. With AI
  off, no AI feature appears anywhere. "Suggest commit messages" is a separate switch below
  it.
- Branchline reads a token or key from the system's password store at most once per run, so
  macOS asks for Keychain access at most once per start.
- Remotes moved into the Branches view: each remote's heading shows its address and has the
  remote's actions (fetch, edit, copy address, remove), and "Add remote" sits on the first
  heading. The separate Remotes view and its shortcut (`Ctrl+7` / `⌘7`) are gone.

### Fixed

- Commit message suggestions with thinking models in Ollama (Qwen 3, DeepSeek R1 and others)
  could take minutes, show nothing and end with a time-out. Branchline now asks these models
  to answer without thinking first, gives Ollama enough context for the whole diff, and stops
  a model that keeps reasoning without answering.
- Stopping a fetch, pull, push or clone right after starting it could be lost, so the
  operation ran on until it finished or timed out. An early stop is now kept until the
  operation starts.

## [0.2.1] - 2026-10-27

Know what Branchline is made of, and a new home page that shows what it can do.

### Added

- About Branchline in Settings: version, update check and links, and every open-source
  package Branchline is built with, with its license and license text. The list shows ten
  packages at a time, with Show more and Show all.

### Changed

- The README is now a tour of Branchline with screenshots. Everything else (features in
  detail, keyboard shortcuts, settings, security, limitations and building from source) moved
  to the new [MANUAL.md](https://gitlab.com/bytefulminds/branchline/-/blob/main/MANUAL.md).

## [0.2.0] - 2026-10-26

Easier troubleshooting: see every Git command Branchline runs, and Git hooks that work the
same as in your terminal.

### Added

- Git console (`Ctrl+J` / `⌘J`): every Git command Branchline runs, with its output, so you
  can see why a hook or command failed. Failed commits and pushes link straight to it.
- Sort branches by name or by last commit.

### Fixed

- Git hooks that use tools from your shell (Husky with `npx`, lint-staged, Homebrew or nvm
  tools) failed with "command not found" when Branchline was started from the Dock or Finder.
  Branchline now uses your login shell's PATH for Git and its hooks.
- The title bar no longer shifts during a refresh: the spinner takes the Refresh button's
  place.

## [0.1.0] - 2026-10-22

The first public release: a fast, local-first Git client for macOS, Windows and Linux that
drives the Git you already have installed.

### Working tree and commits

- Changed files grouped into conflicts, unstaged and staged, with a filter and keyboard
  control. Stage, unstage and discard whole files, single hunks or selected lines.
- Diffs in one column or side by side, with syntax highlighting for about 40 languages.
- Commit and amend, with a resizable message box and optional message suggestions from your
  own Ollama server (nothing leaves your network).
- A three-pane merge editor for conflicts.

### History and branches

- History of all branches, remote branches and tags with a commit graph, page by page on very
  large repositories.
- Search commits by message, author or id, and filter by author, file or folder, dates and the
  current branch. "Show file history" from any diff.
- Branches, tags, stashes and worktrees: create, switch, rename, delete, apply and lock.
- Merge, rebase, interactive rebase, cherry-pick (one or many) and revert, with an operation
  banner to continue, skip or abort.

### Remotes

- Fetch, pull (fast-forward, merge or rebase) and push with live progress and Cancel. Force
  push only with lease, after a confirmation.
- Clone and create repositories; add, edit and remove remotes.

### Everywhere

- Command palette (`Ctrl+K` / `⌘K`) with every action, and a keyboard shortcut overview
  (`Ctrl+/` / `⌘/`).
- Settings for Git behavior, identity and commit signing, editor and diff, confirmations and
  AI suggestions.
- Accessibility review: automated checks on every screen, full keyboard control, screen
  reader labels and contrast of at least 4.5:1.
- Updates: Branchline checks for new releases and installs them after asking.

### Known limitations

- The macOS and Windows builds are not signed yet. See the installation notes in the README.
- See "Known limitations" in the README for the rest.

[Unreleased]: https://gitlab.com/bytefulminds/branchline/-/compare/v0.2.5...main
[0.2.5]: https://gitlab.com/bytefulminds/branchline/-/releases/v0.2.5
[0.2.1]: https://gitlab.com/bytefulminds/branchline/-/releases/v0.2.1
[0.2.0]: https://gitlab.com/bytefulminds/branchline/-/releases/v0.2.0
[0.1.0]: https://gitlab.com/bytefulminds/branchline/-/releases/v0.1.0
