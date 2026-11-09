# Branchline manual

Everything Branchline can do, and how. For a quick tour with screenshots, see the
[README](README.md).

- [Install](#install)
- [Repositories](#repositories)
- [Changes and commits](#changes-and-commits)
- [History and search](#history-and-search)
- [Branches](#branches)
- [Remotes: fetch, pull and push](#remotes-fetch-pull-and-push)
- [Stashes, tags and worktrees](#stashes-tags-and-worktrees)
- [Merge, rebase, cherry-pick and revert](#merge-rebase-cherry-pick-and-revert)
- [Conflicts and the merge editor](#conflicts-and-the-merge-editor)
- [Merge requests (GitLab and Bitbucket)](#merge-requests-gitlab-and-bitbucket)
- [AI](#ai)
- [Git console and hooks](#git-console-and-hooks)
- [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Accessibility](#accessibility)
- [Privacy and security](#privacy-and-security)
- [Performance](#performance)
- [Known limitations](#known-limitations)
- [For developers](#for-developers)

## Install

Download the installer for your system from the
[releases page](https://gitlab.com/bytefulminds/branchline/-/releases). Branchline needs
[Git](https://git-scm.com/downloads) 2.20 or newer. It checks for updates after starting and
installs them when you agree (Settings > General to turn that off).

| System | File | Notes |
|---|---|---|
| macOS 11 or newer (Apple silicon and Intel) | `.dmg` | Drag Branchline to Applications |
| Windows 10 and 11 | `-setup.exe` (or `.msi`) | |
| Linux | `.AppImage`, `.deb` or `.rpm` | AppImage: make it executable (`chmod +x`) and run it. Updates install for the AppImage only |

The installers are not signed with Apple or Microsoft certificates yet, so the system
asks before the first launch:

- **macOS:** open Branchline once, choose Done, then go to System Settings > Privacy &
  Security and choose "Open Anyway" next to the Branchline message.
- **Windows:** in the "Windows protected your PC" window choose "More info", then "Run anyway".

Updates are signed with Branchline's own update key, so only genuine releases are installed.

## Repositories

- Open a repository with the native folder picker (`Ctrl+O` / `⌘O`), from the recent list, or
  from the command line (`branchline /path/to/repo`). Selecting a subfolder opens the repository
  root.
- Clone a repository from an address (HTTPS, SSH or a local path) with progress and Stop, or
  create a new one in a new or existing folder, from the welcome screen or the repository menu.
  A failed or stopped clone leaves no files behind.
- The repository menu also opens the repository in your editor or terminal, or shows it in
  Finder, Explorer or your file manager.
- Current branch, detached HEAD and repositories without commits are all handled.
- Upstream tracking with ahead/behind counts, including upstreams that no longer exist.
- In-progress merge, rebase, cherry-pick, revert and bisect are detected and shown.
- Automatic refresh through a file-system watcher (changes made in your editor or terminal show
  up within a second), plus `Ctrl+R` / `⌘R` / `F5`. No polling.
- Clear loading, empty, error and "Git not installed" states.

## Changes and commits

- Changed files from `git status`: modified, added, deleted, renamed (with source path), copied,
  type changes, untracked and conflicted files, split into conflicts, staged (what goes
  into the next commit, on top) and unstaged.
- Diff viewer for unstaged, staged and untracked files, with line numbers, hunk headers, CRLF and
  "no newline at end of file" handling, binary detection and a guard for very large diffs.
- One column or side by side (toggle above every diff, remembered). Side by side pairs removed
  and added lines; both columns scroll together and each scrolls sideways on its own. Staging
  hunks and lines works the same in both layouts.
- Syntax highlighting for about 40 languages, chosen by file name. The grammars load on first
  use; diffs over 400 KB or with very long (minified) lines stay plain.
- Stage, unstage and discard whole files, single hunks or selected lines (click, shift-click for
  a range). Discarding always asks for confirmation; staged content is never discarded.
- File filter, keyboard navigation in the file list (`Space`/`Enter` stages or unstages,
  `Delete` discards), resizable panels, and a virtualized list that stays fast with thousands of
  files.
- Commit and amend from the Changes view: summary and description, a length hint, merge
  messages prefilled, `Ctrl+Enter` / `⌘↵`, and clear errors for a missing identity or failing
  hooks. The commit box shows the name and email you commit as.
- Drag the line above the commit summary to make the message box taller or shorter (the
  description fills the space, the size is remembered; double-click resets it).

## History and search

- History of all branches, remote branches and tags with a commit graph, ref badges, authors and
  dates. Fast on large repositories: the list is virtualized and loads page by page.
- Commit details: full message, author and committer, parents, changed files with line counts,
  and a read-only diff per file.
- Search History (`Ctrl+F` / `⌘F`) by message, author or commit id, and filter by author, file
  or folder, date range and the current branch only. Results load page by page like the full
  history, and matches are marked.
- "Show file history" on a diff opens the commits that changed that file.
- Make room in a small window: drag the left edge of the Author, Date and Commit column
  headings to resize them (double-click resets one), and right-click the headings to hide or
  show columns or reset them. The Graph column narrows down to about three lanes (drag its
  right edge); lanes that do not fit are cut off with a fade, and a double-click fits all
  lanes again. When the list gets too narrow for the description, Commit, then
  Date, then Author make way until there is room again. Hover a description to read it in
  full. The commit details panel can be hidden with the button next to Filters, and the
  sidebar collapses to icons (`Ctrl+B` / `⌘B`, or the button at its bottom). Branchline
  remembers all of this.
- Right-click (or `Shift+F10`) on a commit to create a branch, tag or worktree there, check it
  out, merge, rebase, cherry-pick or revert it, or copy its id.

## Branches

- List local and remote branches with upstream and ahead/behind, then create, switch, rename
  and delete them. Remote branches check out as tracking branches; unmerged branches need a
  second confirmation before deletion; switching never overwrites uncommitted work.
- Sort by name or by last commit (remembered); the current branch stays on top.
- Quick branch switcher in the title bar: your most recent local branches, and below them
  the newest remote branches that have no local branch yet. Choosing one of those checks it
  out as a tracking branch. Every branch is also in the command palette.
- Drag a branch (in Branches, or its label in History) onto another branch or a commit to merge
  or rebase; a menu offers what is possible from there.

## Remotes: fetch, pull and push

- Fetch, Pull and Push in the title bar, with ahead/behind counts. Pull fast-forwards by
  default, or merges or rebases on request; a branch without upstream is published to the
  remote you choose. Force push is only possible with lease, after a confirmation.
- Live progress (phase and percentage) in the status bar, and Cancel for every fetch, pull and
  push.
- Clear messages for failed sign-in, unknown SSH hosts, unreachable or missing remotes, rejected
  pushes and diverged branches, with the next step offered where there is one.
- Remotes are part of the Branches view: each remote has its own group, with its address and
  branch count in the heading. The heading's menu (or a right-click on it) fetches that remote,
  edits it (rename, or change its fetch and push addresses), copies its address or removes it.
  "Add remote" is on the first remote's heading, in that menu and in the command palette; with
  no remotes yet, Branches shows it in the middle. A new remote can be fetched right away.
  Addresses are shown without user names or tokens, and a hidden token is kept when you save.
  Passwords in addresses are refused; use a credential helper instead.

## Stashes, tags and worktrees

- **Stashes:** stash changes with a message (untracked files included by choice), then apply,
  pop or delete them. The Stashes view shows every stash with its files and diffs. Stash and
  Pop are also in the title bar.
- When local changes block a pull or a branch switch, Branchline offers "Stash, pull and
  reapply" or "Stash and switch" instead of leaving you stuck.
- **Tags:** create lightweight or annotated tags (from the Tags view or on any commit in
  History), push them, delete them locally or on a remote, check them out or start a branch
  from them. Pushing never overwrites a different tag with the same name on the remote.
- **Worktrees:** extra working folders for the same repository, each with its own branch
  checked out. Create one with a new branch (from the current branch, any branch or a commit in
  History) or for an existing branch, open it in Branchline, lock or unlock it, and remove it
  (the branch stays; uncommitted changes are only deleted after a second confirmation).
  Worktrees whose folder was deleted can be cleaned up. Branches checked out in another
  worktree are marked in Branches and offer "Open worktree" instead of Switch.

## Merge, rebase, cherry-pick and revert

- Merge a branch or commit into the current branch (optionally always with a merge commit),
  rebase onto a branch or commit, cherry-pick and revert commits, from the Branches view and the
  History context menu. Rebasing a published branch warns that a force push will follow.
- Interactive rebase ("Rebase interactively from here…" on a commit in History): drag commits
  into a new order (or use `Alt+↑` / `Alt+↓`), and pick, reword, squash, fix up or drop each
  one. Branchline checks the plan before Git runs it.
- Commits you squash or fix up are shown indented above the commit they go into, with a line
  into it and a "+2 combined" badge on that commit. "Edit message" gives the combined commit a
  message of its own, starting from the messages Git would keep.
- Rewrite history ("Rewrite history of …" on the newest commit in History, on the current
  branch in Branches, or in the command palette) shows only the branch's own commits: from
  where the branch was created, or where it forked from the nearest other branch (so a branch
  made from `develop` stops at the commit it was made from). On `main`, `master` or `trunk`
  itself, it shows the commits that are not pushed yet. It stops after the newest
  merge commit, and says how many of the commits are already pushed (those need a force push
  afterwards).
- With AI on, "Suggest with AI" in the rebase window asks your AI provider which neighbouring
  commits belong together (work in progress, typo and review fixes) and for a message for each
  resulting commit. It only fills in the plan: nothing runs until you choose Start rebase, and
  Reset undoes the suggestion. Sent: the commit messages, their changed files and (for up to 40
  commits) shortened diffs.
- Select several commits in History (`Ctrl`/`⌘`+click to add one, `Shift`+click or
  `Shift+↑`/`↓` for a range, `Esc` to go back to one) and cherry-pick them in one go. They are
  applied oldest first; commits already on the branch are skipped, and a conflict stops the
  sequence until you Continue.

## Conflicts and the merge editor

- When an operation stops with conflicts, a banner shows what is left (with rebase progress, for
  example "commit 2 of 5") and offers Continue, Skip commit and Abort. Local changes in the way
  can be stashed and reapplied automatically.
- Conflicted files show their conflict markers and can be marked as resolved, or resolved in
  the merge editor.
- The merge editor shows your side on the left, the result in the middle and the incoming side
  on the right, each named for the operation (for example "main" and "feature/x" in a merge, or
  the commit being cherry-picked). Changes that do not conflict are taken right away; for each
  conflict, take one side (`»` / `«`), both, or neither, or type the result yourself.
- Undo and redo, `Alt+↑` / `Alt+↓` (or `F7`) between changes, "Use all" for one side's whole
  file, and editing the whole result as text.
- Saving writes the file and marks it as resolved; it refuses if the file changed since the
  editor opened it. Binary files, symbolic links and files deleted on one side get whole-file
  choices (keep one version or delete the file).

## Merge requests (GitLab and Bitbucket)

- Connect your account in Settings > Accounts: choose the service (GitLab or Bitbucket Cloud;
  GitHub is planned). For GitLab, enter the address (GitLab.com or your own server) and a
  personal access token. Make the token under your own profile, so it acts as you. "Create a token on GitLab" opens the right page with
  the name and the `api` scope filled in; `read_api` is enough to only read. Branchline checks
  the token before it keeps it, and says what it may do.
- The token is kept in your system's password store (macOS Keychain, Windows Credential
  Manager, or the Secret Service on Linux, such as GNOME Keyring or KWallet), never in a
  settings file. Disconnect deletes it there; revoke it on GitLab to make it stop working.
- With an account connected, the sidebar shows **Reviews** (`Ctrl+7` / `⌘7`) with the number
  of open merge requests where you are a reviewer, your own included when you set yourself as
  reviewer. When the open repository has a remote on that server, its project is used (in a
  fork the `upstream` remote's project, otherwise `origin`), and its merge requests open in
  Branchline. Otherwise Reviews lists your merge requests in all projects on the server (the
  first connected account), and they open on the website. Without an account, Reviews is not
  shown at all.
- Three lists: **To review** (you are a reviewer), **Created by you** and **All open**. For
  the repository's project, Branchline reads all of its open merge requests and picks the
  ones for you itself, by your user id. **All projects** on the server asks GitLab to filter
  instead; All open is for one project only.
- Each merge request shows its title, number, author, source and target branch, when it was
  last updated, its reviewers, and whether it is a draft, has conflicts, has comments, what
  its pipeline did, and whether you already approved it. The lists load when the repository
  opens, with Refresh, and when the window gets focus (at most every 30 seconds, with
  Settings > General > Refresh when Branchline gets focus); they are not polled. Up to 50
  merge requests are listed, newest activity first.
- Every request Branchline sends to GitLab is listed in the Git console (`Ctrl+J` / `⌘J`):
  the address, the HTTP status, how long it took and the response, never the token. The
  details fetched per row (pipeline, approvals) count as routine reads.
- **Open** (or double-click) reads a merge request of the repository's project in Branchline.
  Its commits are fetched from the remote with your usual Git credentials (with progress and
  Stop), into `refs/branchline/merge-requests/<number>`, so they never show up as a branch or
  in History. The diff is computed locally between the merge request's base and its newest
  commit; GitLab only provides the details and the comments.
- The left side shows the overview (description, discussion and commits) and the changed
  files with their line counts and how many comment threads each has. Choosing a file shows
  its diff, in one column or side by side, with that file's comment threads above it: their
  line, whether they are resolved, and whether they were made on an older version. System
  notes such as "added 1 commit" are left out.
- **Bitbucket Cloud** works the same way, with pull requests (`#4`) instead of merge
  requests (`!4`). Bitbucket signs in with your Atlassian account's **email address** and an
  **API token with scopes** (app passwords no longer work): "Create a token on Bitbucket" opens
  the Atlassian page. Give it `read:user`, `read:pullrequest` and `read:repository` for
  Bitbucket; `write:pullrequest` will be needed for commenting and approving later. Both are
  kept together in the password store. Bitbucket Data Center is not supported yet.
- Bitbucket has no merge request refs, so opening a pull request fetches its source branch
  (from the fork when it comes from one, at the same kind of address as your remote) and its
  target branch into `refs/branchline/pull-requests/<number>/`, and the diff starts where the
  branch forked from the target. Pull requests to review are listed per repository: across
  all of Bitbucket only **Created by you** is available. Build statuses show as the pipeline.
- Merge requests of other projects (in All projects) open on the website, as does the button
  next to Open. Posting comments and approving from Branchline are planned; see
  [the plan](docs/plans/merge-request-reviews.md).

## Review quest (AI)

With AI on (Settings > AI), a merge request opened in Branchline has **Start review quest**.
The AI is the game master, not the reviewer: it asks questions that make you look closely at
the change, and you decide what is right.

- One round per changed file, with one to three questions:
  - **Quiz** (multiple choice) and **true or false**: answer once; the explanation says why,
    and the lines that matter light up in the diff.
  - **Find the line**: click the right line in the diff.
  - **Your take**: an open question. The AI responds to your answer, never calls it wrong and
    never asks you something back, and may suggest a review comment you can edit and keep.
- An answered question stays in view until **Next question**; **Skip question** and **Skip
  file** are always there.
- Click any added or removed line to write a draft comment on it.
- Points: 10 per answer, 5 more for a quiz question right or an open answer with some
  thought, 15 per draft comment and 5 per file finished. Coverage is the share of changed
  lines in finished files. Points are for thought and findings, never for speed.
- Binary, generated and lock files get no round. Above 40 files, the files with the most
  changed lines get one. The summary lists everything that was left out.
- The summary shows your points, coverage and draft comments: edit or remove them, or copy
  them all. Posting them to GitLab from Branchline comes in a later version.
- Progress is saved per merge request on this computer, so you can stop and continue later.
  A new commit on the merge request starts a new quest.
- **Review my branch** (**Review with AI** in Changes, the current branch's menu in Branches,
  the newest commit's menu in History, or the command palette) plays the same quest on your
  own branch: its commits since it was created or forked, without uncommitted changes. The
  questions are what a reviewer is likely to ask, and findings become notes for yourself.
- Sent to your AI provider per round: the title and description, the file's diff with line
  numbers (shortened to fit) and earlier comments on that file. Nothing is sent with AI off,
  and with AI off none of this appears anywhere.

## AI

- Turn on **Use AI** in Settings > AI and choose a provider:
  - **Ollama** (private): a model on your own computer or network, from
    [ollama.com](https://ollama.com).
  - **OpenAI-compatible server**: LM Studio, vLLM, the llama.cpp server, OpenRouter and
    others. Use the address that ends in `/v1`; an API key is optional.
  - **Anthropic** (Claude) or **OpenAI** (GPT): cloud models with an API key. A Claude Pro
    or Max plan, or a ChatGPT plan, does not include the API: make a key in the Claude
    Console or on the OpenAI platform (Settings links to both). API use is billed per use,
    separately from a subscription.
- API keys go to the system's password store, never into Branchline's settings file, and
  never come back to the window. Test lists the provider's models; pick one, then the
  message style (Conventional Commits or plain), the language and extra team instructions.
- With AI off, no AI feature appears anywhere in Branchline and nothing is sent.
- With AI and "Suggest commit messages" on, "Suggest message" in the commit box writes a summary and
  description for the staged changes. The text streams in, `Esc` or Stop cancels it, and a
  message you had typed can be restored with Undo.
- Thinking models (Qwen 3, DeepSeek R1, gpt-oss) are asked to answer without a thinking
  step in Ollama, which is much faster for commit messages. Branchline also sets Ollama's
  context size so the whole shortened diff fits.
- Only the staged diff (shortened), the list of changed files, the branch name and recent commit
  subjects are sent, and only when you ask. See [Privacy and security](#privacy-and-security).

## Git console and hooks

- The Git console (`Ctrl+J` / `⌘J`, or "Git console" in the status bar) lists every Git command
  Branchline runs, with its folder, exit code, duration and output, so you can see why a hook or
  command failed.
- Routine reads such as `status` are hidden unless you ask for them; failures always show.
  Filter on failed commands only, or search the commands and their output.
- A failed commit or push offers "Show Git output", which opens the console on that command.
- Requests to GitLab and Bitbucket show up there too (see
  [Merge requests](#merge-requests-gitlab-and-bitbucket)).
  Copy a command to run it yourself in a terminal.
- Git hooks such as Husky and lint-staged find the same tools as your terminal. Apps started
  from the Dock or Finder get a minimal PATH, so at startup Branchline asks your login shell
  for its PATH once (in the background, at most 5 seconds) and uses it for Git, hooks, your
  editor and terminal. Profiles can check `BRANCHLINE_RESOLVING_SHELL_ENV` to skip slow
  parts. Windows sets PATH for the whole system, so nothing changes there.

## Settings

Open Settings with `Ctrl+,` / `⌘,` or the gear in the title bar. Changes are saved right away.

- **General:** reopen the last repository on start, refresh when the window gets focus, fetch
  in the background every 5 to 60 minutes (quietly; an error is shown once), check for updates.
- **Git:** what the Pull button does (fast-forward, merge or rebase), prune deleted remote
  branches on fetch, push annotated tags with commits.
- **Identity and signing:** name, email and commit signing (GPG, SSH or X.509), for all
  repositories (`~/.gitconfig`) or only the open one.
- **Accounts:** GitLab and Bitbucket accounts for the Reviews view; see
  [Merge requests](#merge-requests-gitlab-and-bitbucket).
- **Editor and diff:** the editor and terminal that "Open in editor", "Open in terminal" and
  "Show in Finder/Explorer" use (repository menu, and a button on each changed file), diff
  layout, syntax highlighting, context lines, ignoring whitespace, tab width and code font size.
- **Confirmations:** turn off the questions before discarding, force pushing, rebasing a
  published branch or deleting a branch. Deleting unmerged work always asks.
- **AI:** see [AI](#ai).
- **About Branchline** (also "About Branchline" in the command palette): version, update
  check, links, and every open-source package Branchline is built with, with its license and
  license text. The list shows ten packages at a time; search it, show more, or show all.

## Keyboard shortcuts

The command palette (`Ctrl+K` / `⌘K`, or the button in the title bar) finds every action, view,
branch and recent repository by typing a few letters. `Ctrl+/` / `⌘/` or `?` shows every
keyboard shortcut in the app.

| Windows and Linux | macOS | Action |
|---|---|---|
| `Ctrl+K` or `Ctrl+Shift+P` | `⌘K` or `⇧⌘P` | Command palette |
| `Ctrl+O` | `⌘O` | Open a repository |
| `Ctrl+R` or `F5` | `⌘R` | Refresh |
| `Ctrl+1` to `Ctrl+6` | `⌘1` to `⌘6` | Changes, History, Branches, Stashes, Tags, Worktrees |
| `Ctrl+7` | `⌘7` | Reviews (with a GitLab or Bitbucket account connected) |
| `Ctrl+F` | `⌘F` | Search commits in History |
| `Ctrl+Enter` | `⌘↵` | Commit |
| `Ctrl+J` | `⌘J` | Git console |
| `Ctrl+B` | `⌘B` | Collapse or expand the sidebar |
| `Ctrl+,` | `⌘,` | Settings |
| `Ctrl+/` or `?` | `⌘/` or `?` | All keyboard shortcuts |
| `Space` / `Enter` | `Space` / `Enter` | Stage or unstage the selected file |
| `Delete` | `Delete` | Discard the selected file |
| `Shift+F10` | `Shift+F10` | Context menu of the selected commit |
| `Alt+↑` / `Alt+↓` | `⌥↑` / `⌥↓` | Previous or next change in the merge editor; move a commit in interactive rebase |

## Accessibility

Branchline works with the keyboard and screen readers: lists, diffs (arrow keys and `Space`
select lines), dialogs and panels. See [docs/accessibility.md](docs/accessibility.md).

## Privacy and security

- Git runs as a subprocess with an argument vector, never through a shell. Paths are passed as
  literal pathspecs, so a file called `*.txt` never matches other files.
- Interactive prompts are disabled (`GIT_TERMINAL_PROMPT=0`, empty askpass), so commands cannot
  hang.
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
- AI suggestions only contact the provider you chose (your Ollama or OpenAI-compatible
  server, or the API of Anthropic or OpenAI), only when you ask for a suggestion (or test
  the connection), and only send the staged diff (shortened), the list of changed files, the
  branch name and recent commit subjects. Unstaged files are never sent. Addresses may not
  contain credentials, redirects are not followed, and system proxies are skipped for
  `localhost`. Settings warn when the server is not on this computer, and say plainly that a
  cloud provider gets your staged changes.
- API keys are stored in the system's password store and never reach the app's web view.
  Branchline reads them at most once per run, and never sends a key over plain `http://` to
  another computer.
- GitLab tokens and Bitbucket credentials (email and API token) are stored in the system's
  password store and never reach the app's web view; Branchline sends them only to the server
  they were made for (Bitbucket: api.bitbucket.org), in a request header (never in an
  address). Addresses must use `https://` (plain `http://` only for a server on
  this computer), may not contain credentials, and redirects are not followed. Merge request
  pages open in the browser only when they belong to a connected server.
- The webview has a strict CSP and only the Tauri permissions it needs (window controls, the
  folder picker, the app version, installing updates and restarting). Web links open in the
  browser only for Branchline's own GitLab pages, ollama.com, the API key pages of Anthropic
  and OpenAI, and package pages on npmjs.com and crates.io.
- Updates are only installed when their signature matches the update key built into
  Branchline, and only after you agree. The update check only contacts the release page on
  GitLab.
- The Git console log stays in memory (the last 500 commands, at most 8 KB of output and
  32 KB of messages each) and is gone when Branchline quits. Credentials in URLs are removed
  before anything is stored; what Branchline sends on standard input (patches, commit
  messages) is not kept.

## Performance

On a modest Linux machine with software rendering, Branchline shows a repository about a
second after starting, switches views in tens of milliseconds and opens History on git/git
(82,000 commits) in about half a second. Long lists are virtualized and history loads page
by page. Method and all numbers per platform: [docs/performance.md](docs/performance.md).

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
- The graph shows up to 12 lanes; further lanes are clipped. Merge commits list the files
  changed relative to their first parent.
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
- Reviews work with GitLab and Bitbucket Cloud (GitHub and Bitbucket Data Center are not
  supported yet) and list at most 50 merge requests. On Linux, keeping a token needs a running Secret Service (GNOME Keyring,
  KWallet); without one, Settings says so.
- Reading a merge request shows its comments above the file's diff, not between the lines,
  and shows descriptions and comments as plain text (Markdown is not formatted yet). It
  lists the first 100 commits and comment threads. The fetched `refs/branchline/...` refs stay
  in the repository; `git update-ref -d` removes one.
- Runs on macOS and Linux; Windows has not been run yet. Automated tests and measurements so far
  ran on Linux.

## For developers

### Prerequisites

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

### Getting started

```sh
npm install
npm run app:dev            # run the desktop app with hot reload
npx tauri dev -- -- /path/to/repo     # open a repository on launch
```

`npm run dev` starts only the web frontend in a browser. It renders, but Git features need the
desktop shell and will say so.

### Scripts

| Command | What it does |
|---|---|
| `npm run app:dev` | Desktop app in development mode |
| `npm run app:build` | Production build and installers for the current platform |
| `npm run check` | Typecheck, lint, format check, frontend tests and Rust tests |
| `npm test` | Frontend tests (Vitest + Testing Library) |
| `npm run test:rust` | Rust unit and integration tests (uses temporary Git repositories) |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run licenses` / `npm run licenses:check` | Regenerate or check the open-source package list shown in About |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` | Rust lints |
| `cargo run --release --manifest-path src-tauri/Cargo.toml --example inspect -- <repo> [runs]` | Time repository inspection |
| `node scripts/measure-startup.mjs <binary> <repo>` | Time startup and interactions of a built app ([docs/performance.md](docs/performance.md)) |
| `node scripts/release/bump-version.mjs <version>` | Set the version everywhere before a release ([docs/releasing.md](docs/releasing.md)) |

### Project structure

```
docs/                    Architecture, design system, accessibility, performance, releasing
  screenshots/           Images used in the README
scripts/                 Startup measurement, license list and release scripts
public/                  Static assets (logo mark)
src/                     React + TypeScript frontend
  components/            Shared UI components (Button, Menu, Badge, Toast, Splitter, ...)
  features/repository/   Repository state, welcome, loading and error views
  features/changes/      Changed-file model, list, diff, syntax highlighting and commit box
  features/history/      Commit list, graph, search filters and commit details
  features/branches/     Branch list, switcher and branch dialogs
  features/remote/       Remote dialog; fetch, pull and push toolbar and actions
  features/stash/        Stashes view, stash dialog and actions
  features/tags/         Tags view, tag dialog and actions
  features/integrate/    Merge, rebase, cherry-pick, revert and the operation banner
  features/conflicts/    Merge editor (three panes) and its model
  features/worktrees/    Worktrees view, new worktree dialog and actions
  features/settings/     Settings screen and provider
  features/about/        About section and the open-source package list
  features/console/      Git console
  features/reviews/      Reviews view and the accounts and review state behind it
  features/commands/     Command palette, keyboard shortcut map
  features/updates/      Update checks
  features/measure/      Startup and interaction timing (--measure-startup)
  layouts/               Window shell: title bar, sidebar, status bar, window controls
  services/              IPC wrappers, dialog, platform, local preferences
  styles/                Design tokens and base styles
  types/                 IPC contract types (mirror the Rust models)
src-tauri/               Rust backend
  src/git/runner.rs      Safe Git process execution (timeouts, no shell, hardened config)
  src/git/command_log.rs In-memory log of Git commands for the Git console
  src/git/status.rs      `git status --porcelain=v2 -z` parser
  src/git/repository.rs  Repository inspection and models
  src/git/log.rs         History pages, search and filters
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
  src/secrets.rs         Tokens and API keys in the system's password store
  src/forge/             GitLab and Bitbucket accounts, remote parsing, requests to review
  src/shell_env.rs       PATH from the login shell, for hooks
  src/open.rs            Open in editor or terminal, show in the file manager
  src/ai/                AI providers (Ollama, OpenAI-compatible, Anthropic, OpenAI) and
                         commit message suggestions
  src/measure.rs         Startup timing report
  src/commands.rs        Tauri IPC commands (async, off the UI thread)
  src/error.rs           Error model shared with the frontend
  tests/                 Integration tests against real temporary repositories
```

See [docs/architecture.md](docs/architecture.md) for how the layers fit together and
[docs/design-system.md](docs/design-system.md) for the design tokens and component rules.
