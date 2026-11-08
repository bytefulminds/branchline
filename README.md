<div align="center">

<img src="docs/branchline-logo.png" alt="Branchline logo" width="128">

# Branchline

**See the flow of your code: a fast, friendly Git desktop client that shows what Git is
doing and lets you do it with a click.**

**Version 0.2.5** · [download](https://gitlab.com/bytefulminds/branchline/-/releases) for Windows, macOS and Linux

[![pipeline](https://gitlab.com/bytefulminds/branchline/badges/main/pipeline.svg)](https://gitlab.com/bytefulminds/branchline/-/pipelines)
![license: MIT](https://img.shields.io/badge/license-MIT-00D1A0)
![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-60A5FA)

</div>

<p align="center">
  <img src="docs/screenshots/history.png" alt="Branchline showing the history of a repository with a colored commit graph, branch labels and the details of the selected commit" width="900">
</p>

Branchline is a Git client for everyone who would rather look at their repository than
remember commands. Your branches and commits appear as a graph, your changes as clear
diffs, and every everyday Git task, from staging a single line to an interactive rebase, is
a click or a keystroke away.

It is fast and local-first. Branchline runs the Git you already have, so it behaves exactly
like Git in your terminal, stays quick on repositories with tens of thousands of commits, and
your code only leaves your computer when you push it (or ask an AI for a commit message). It is free and open source, made by
Bytefulminds.

## What you can do with Branchline

### Commit exactly what you mean

Stage whole files, single hunks or just the lines you select, and leave the rest for later.
Diffs show your code in the colors of your editor, in one column or side by side, and the
commit box tells you who you commit as before you press Ctrl+Enter.

<p align="center">
  <img src="docs/screenshots/changes-lines.png" alt="The Changes view with two lines selected in a Python diff, ready to stage, and a commit message being written" width="49%">
  <img src="docs/screenshots/diff-split.png" alt="A side-by-side diff of a Python file with syntax highlighting, removed lines on the left and added lines on the right" width="49%">
</p>

### Find anything, fast

Search the whole history by message, author or commit id, and narrow it down by author,
file or folder and dates. Every match is marked. The command palette (Ctrl+K) finds every
action, branch and recent repository in a few letters.

<p align="center">
  <img src="docs/screenshots/history-search.png" alt="History search for the word city, filtered on one author, with every match highlighted" width="49%">
  <img src="docs/screenshots/palette.png" alt="The command palette offering to switch to one of five feature branches" width="49%">
</p>

### Branches and history, your way

Create, switch, merge and rebase branches from a right-click, or drag one branch onto
another. Clean up before you push with "Rewrite history": Branchline finds where your branch
started, you drag commits into a new order and reword, squash or drop them, and squashed
commits are shown grouped under the commit they go into. With AI on, it can suggest which
commits belong together and write their messages.

<p align="center">
  <img src="docs/screenshots/branches.png" alt="The Branches view with a branch menu open: switch, open in a new worktree, merge, rebase, push, rename and delete" width="49%">
  <img src="docs/screenshots/rebase.png" alt="Rewrite history with an AI suggestion: two groups of fixed-up commits, each indented above the commit they go into, with a new message" width="49%">
</p>

### Conflicts without the fear

When a merge, rebase or cherry-pick stops on conflicts, a banner says what is left and what
you can do next. The merge editor puts your side, the result and the incoming side next to
each other. Changes that do not conflict are taken for you; for the rest you pick a side,
both, or type the result yourself.

<p align="center">
  <img src="docs/screenshots/conflict.png" alt="A merge in progress with four conflicted files and the conflict markers of the selected file" width="49%">
  <img src="docs/screenshots/merge-editor.png" alt="The three-pane merge editor with the current branch on the left, the result in the middle and the merged branch on the right" width="49%">
</p>

### See what Git is doing

The Git console (Ctrl+J) shows every Git command Branchline runs, with its exit code, timing
and output. When a commit hook such as Husky or lint-staged says no, "Show Git output" takes
you straight to the reason. Hooks find the same tools as in your terminal, also when you
start Branchline from the Dock.

<p align="center">
  <img src="docs/screenshots/git-console.png" alt="A commit stopped by a pre-commit hook, and the Git console showing the failed command with the linter's messages" width="900">
</p>

### Merge requests to review, right in Branchline

Connect your GitLab account (GitLab.com or your own server) and Reviews shows the merge
requests waiting for you, with their pipeline, comments, conflicts and whether you already
approved. Open one to read its description, discussion, commits and every changed file in
Branchline's own diff viewer, with the comment threads next to the code. Your token stays in
your system's password store. GitHub and Bitbucket come later.

<p align="center">
  <img src="docs/screenshots/reviews.png" alt="The Reviews view with five merge requests waiting for review, showing their pipeline, comments, conflicts and approval" width="49%">
  <img src="docs/screenshots/merge-request.png" alt="A merge request opened in Branchline: its changed files, two comment threads and the diff of api.py" width="49%">
</p>

### Review as a game, with an AI as game master

Turn on AI and start a review quest: for every changed file the AI asks a few questions, from
a quick quiz to "click the line that decides whether the cache is still fresh" to "what
happens to memory when people look up many cities?". It responds to your answers, suggests
review comments you can keep, and you earn points for thought and findings, never for speed.
Play the same quest on your own branch before you open a merge request.

<p align="center">
  <img src="docs/screenshots/quest.png" alt="A review quest: the AI responds to an open answer about the cache and suggests a review comment, above the diff of api.py, with 45 points earned" width="900">
</p>

### Commit messages from the AI you choose

Connect Branchline to [Ollama](https://ollama.com) on your own computer or network, any
OpenAI-compatible server, or Claude or GPT with an API key, and "Suggest message" writes a
summary and description for your staged changes, in the style and language your team uses.
Only when you ask, and with AI turned off, no AI feature appears at all.

<p align="center">
  <img src="docs/screenshots/ai-suggest.png" alt="A Conventional Commits message suggested for the staged changes, filled in the commit box" width="49%">
  <img src="docs/screenshots/ai-settings.png" alt="The AI settings, connected to an Ollama server with a coding model chosen" width="49%">
</p>

### Make it yours

Settings cover how Branchline pulls and fetches, your Git identity and commit signing, your
editor and terminal, the diff layout and which questions it asks before risky actions. About
Branchline lists every open-source package it is built with, with its license.

<p align="center">
  <img src="docs/screenshots/settings.png" alt="The Editor and diff settings: external editor, terminal, diff layout, syntax highlighting, context lines, tab width and font size" width="49%">
  <img src="docs/screenshots/about.png" alt="About Branchline with the version, the Bytefulminds logo and the first ten of 439 open-source packages and their licenses" width="49%">
</p>

And more: clone or create repositories, fetch, pull and push with live progress and Cancel,
stashes (also "stash, pull and reapply" when local changes are in the way), tags, worktrees,
cherry-pick and revert (several commits at once), file history, a file system watcher that
picks up changes from your editor within a second, full keyboard control with screen reader
support, and automatic updates when you agree.

## Getting started

Download Branchline from the
[releases page](https://gitlab.com/bytefulminds/branchline/-/releases): the `-setup.exe` (or
`.msi`) for Windows, the `.dmg` for your Mac (Apple silicon and Intel, macOS 11 or newer), or
the `.AppImage`, `.deb` or `.rpm` for Linux. Branchline needs
[Git](https://git-scm.com/downloads) 2.20 or newer. The apps are not signed yet;
[Install](MANUAL.md#install) in the manual says how to open them the first time.

Or build Branchline from source, with Node.js 20 or newer and Rust 1.77 or newer (plus the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system):

```bash
git clone https://gitlab.com/bytefulminds/branchline.git
cd branchline
npm install
npm run app:dev                        # or: npm run app:build for installers
```

Open a repository from the window (**Ctrl+O**, or a recent one), or straight from the command
line: `branchline ~/code/my-project`.

## Learn more

- **[MANUAL.md](MANUAL.md):** everything Branchline can do, keyboard shortcuts, settings,
  privacy and security, performance and known limitations, and building from source.
- **[CHANGELOG.md](CHANGELOG.md):** what changed in each version.
- **[ROADMAP.md](ROADMAP.md):** what comes next.
- **[docs/architecture.md](docs/architecture.md):** how the code works, for developers (see
  also [For developers](MANUAL.md#for-developers)).

## License

MIT. See [LICENSE](LICENSE).
