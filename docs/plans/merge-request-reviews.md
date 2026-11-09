# Plan: review merge requests in Branchline, with an AI as a game master

Status: phases 1 (GitLab account and Reviews view), 2 (reading a merge request in
Branchline), 3 (AI providers), 4 (the review quest, with self-review) and the reading part of
8 (Bitbucket Cloud, beta) are built; the rest is planned. Phases 1 to 3 shipped in 0.2.5,
phase 4 and Bitbucket in 0.3.0.

## Goal

A reviewer opens Branchline and sees the merge requests waiting for their review. They open
one, read the changes in Branchline's own diff viewer, and play through the review: an AI asks
questions about each change, the reviewer answers, and what they find turns into review
comments. At the end they post the review and approve or request changes, without opening the
website.

The AI is a game master, not the reviewer. It points at things worth a closer look; the
person decides what is right. Nothing is posted until the person says so.

## Choices made

- **GitLab first** (GitLab.com and self-hosted). GitHub next, then Bitbucket.
- **A mix of question types:** quiz questions with a known answer, and open questions that the
  AI responds to.
- **Several AI providers:** Ollama (private, on your own machine), Anthropic (Claude), OpenAI,
  and any server with an OpenAI-compatible API (LM Studio, vLLM, OpenRouter and others).
- **Memory across reviews:** what a team agreed on in earlier reviews is remembered per
  project and given to the AI next time.
- **Self-review on your own branch,** started by hand only: a quest over your branch's changes
  before you open a merge request. Never started for you, so it is easy to skip.
- **Large merge requests:** every change gets a round up to about 40 changed files. Above that,
  the quest covers the largest and riskiest changes first, and says which files it skipped.
- **Points are visible,** during the quest and in the summary, to motivate a proper review.
- **AI features only exist when AI is on.** With AI turned off in Settings, nothing of the
  quest, self-review, points or review notes appears anywhere in the window: no buttons, menu
  items, palette commands, sidebar entries or hints. See
  [Visible only with AI turned on](#visible-only-with-ai-turned-on).

## How it works for the user

1. **Connect GitLab** in Settings > Accounts with a personal access token. Branchline matches
   the account to repositories by the host of their remote (`gitlab.com` or your own server).
2. **Reviews view** in the sidebar: open merge requests where you are a reviewer, for the open
   repository or for all your projects, with author, title, branches, age, pipeline status and
   whether you already approved.
3. **Open a merge request:** Branchline fetches it and shows its commits and changed files in
   the usual diff viewer (one column or side by side, syntax highlighting). Existing comments
   on GitLab show next to their lines.
4. **Start the review quest** (only shown when AI is turned on). The review is split into rounds, one
   file or a few related changes each. Per round the AI asks one to three questions. A
   progress bar shows how much of the merge request you have covered.
5. **Answer, and find things.** Wrong quiz answers are no failure: the explanation points at
   the line that matters. When you notice a problem, write it down; it becomes a draft
   comment on that line. The AI may suggest a wording; you edit it.
6. **Finish:** a summary with your score, the files covered, and your draft comments. Edit or
   remove any of them, then **Post review** and choose Approve, Comment or Request changes.

The quest is optional. Without an AI, or with the quest skipped, Branchline is still a good
place to read a merge request and leave comments on lines.

### Visible only with AI turned on

All AI parts of this feature follow one switch: "Use AI" in Settings > AI, with the provider
settings below it. When it is off:

- The merge request view shows no "Start review quest" button, no score and no AI comment
  suggestions; it is a plain merge request reader.
- "Review my branch" is not in the Changes view, the branch menu or the command palette.
- The review notes section in Settings and its sidebar or menu entries are not shown.
- Keyboard shortcuts for these actions do nothing and are left out of the shortcut list.
- No AI request is made, and stored review notes and scores are kept but not shown.

Turning AI on makes them appear right away, without a restart; turning it off hides them
again, also in the middle of a quest (the quest ends, its draft comments are kept). Tests
check both states: with AI off, none of these controls are in the page.

## The game

### Question types

| Type                 | Example                                                                     | How it is checked                                                                                     |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Multiple choice      | "What does this change do when `days` is empty?" with three or four answers | The AI writes the answer key together with the question; Branchline checks the choice, no second call |
| True or false        | "After this change, `format_temperature` can return a negative number."     | Same as above                                                                                         |
| Find the line        | "Click the line where the API version is chosen."                           | Branchline checks the clicked line against the line numbers the AI gave                               |
| Spot the risk (open) | "What could go wrong with this new query on a large table?"                 | The AI responds to the answer: agrees and adds what was missed, never asks back. Never "wrong"    |
| Your call (open)     | "Would you keep this as one function or split it?"                          | No right answer; the answer can become a comment                                                      |

Quiz questions keep the pace up and check understanding; open questions are where real
findings come from. Each round mixes both. Questions are asked as structured JSON with a
schema (question, type, choices, answer, explanation, file and lines), and Branchline throws
away questions that do not refer to lines in the diff, so a confused model cannot send the
reviewer to code that does not exist.

### Self-review

"Review my branch" in the Changes view, the branch menu or the command palette starts the same
quest on the current branch's changes against its upstream or the branch it will merge into.
It only starts when you choose it. Findings become notes for yourself instead of review
comments, and the questions lean towards what a reviewer is likely to ask, so you can fix
things before anyone else sees them. It needs no GitLab account, only AI turned on with a
provider set up.

### Large merge requests

Up to about 40 changed files, every change gets a round. Above that, the quest picks the
changes to cover first: the largest ones, source code before generated files and lock
files, and files that earlier review notes say need care. The summary lists the files the
quest skipped, so the reviewer can still read them. The limit is a setting, to tune with real
reviews.

### Score

- Points for each answered question, a bonus for a correct quiz answer at the first try, and
  more for each comment that ends up posted.
- A streak for reviews finished on the day they were requested.
- Coverage: the share of changed lines that were part of a round. 100% coverage is the goal,
  not a high score.
- Points are visible while you play (with a short animation when you earn them) and in the
  summary, because they are there to motivate a proper review. Points come from coverage,
  thought and findings, never from speed, so racing through a review does not pay.
- All of this stays local. It is a personal game, not a leaderboard for managers.

## AI providers

One provider setting, used by both commit message suggestions and reviews:

| Provider          | Connection                       | Notes                                                                            |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Ollama            | Address of the server            | Private: nothing leaves your machine or network. Small models make more mistakes |
| OpenAI-compatible | Address, optional API key, model | LM Studio, vLLM, llama.cpp server, OpenRouter, and others                        |
| Anthropic         | API key, model                   | Claude models                                                                    |
| OpenAI            | API key, model                   |                                                                                  |

**About subscriptions:** a Claude Pro or Max plan or a ChatGPT Plus plan does not include API
use. Apps such as Branchline need an API key from the Claude Console or the OpenAI platform,
which is billed per use, separately from the subscription. Settings will say this plainly,
with a link to where the key is made, and show a rough cost per review (input and output
tokens of the last review).

API keys are stored in the system's credential store (macOS Keychain, Windows Credential
Manager, the Secret Service on Linux), never in the settings file. The provider gets the same
rules as Ollama now: only the address you set is contacted, only when you ask, and the
settings say what is sent. For a cloud provider, the Reviews view shows once per project that
the merge request's code goes to that provider.

Structured output per provider: Ollama `format` with a JSON schema, OpenAI and compatible
servers `response_format` with a JSON schema, Anthropic tool use with an input schema. Where a
server does not support schemas, the answer is parsed and validated, and a bad answer is
retried once.

## Memory across reviews

- **Review notes per project:** after a review, the AI proposes up to three short lessons
  ("This team wants a test for every new endpoint", "Prefer `Result` over panics in the
  backend"). The reviewer keeps, edits or drops each one. Kept notes are given to the AI at the
  start of the next review of that project.
- Notes are stored locally in Branchline's data folder, and can be viewed, edited and deleted
  in Settings > Reviews.
- **Shared with the team (optional):** a `REVIEWING.md` (or a file the team picks) in the
  repository is read as the team's review guide and given to the AI as well. Branchline never
  writes to it on its own; it can offer to copy notes there, as a normal change to commit.
- Earlier comments on the same merge request (from GitLab) are part of the context, so the AI
  does not ask about something that was already discussed.

## GitLab, technically

| Need                            | GitLab API                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check the token, get the user   | `GET /user`                                                                                                                                                                     |
| Merge requests to review        | `GET /merge_requests?scope=all&state=opened&reviewer_username=<me>` (all projects), or `GET /projects/:id/merge_requests?state=opened&reviewer_username=<me>` (this repository) |
| Details, base and head commits  | `GET /projects/:id/merge_requests/:iid` (`diff_refs`), and `/approvals` for approval state                                                                                      |
| The code                        | `git fetch <remote> refs/merge-requests/<iid>/head`, then the normal local diff between the merge base and that commit                                                          |
| Existing comments               | `GET /projects/:id/merge_requests/:iid/discussions`                                                                                                                             |
| Draft comments, posted together | `POST .../draft_notes` with a `position` (base, start and head SHA, paths, old and new line), then `POST .../draft_notes/bulk_publish`                                          |
| Approve, revoke                 | `POST .../approve`, `POST .../unapprove`                                                                                                                                        |
| Request changes                 | Reviewer state "requested changes" where the GitLab version supports it; otherwise a comment. To check against GitLab.com and the oldest self-hosted version we support         |

- The project is found from the remote address (`group/subgroup/project`), so it works with
  SSH and HTTPS remotes and nested groups.
- Token scope: `read_api` is enough to list and read; posting comments and approving needs
  `api`. Settings explains both and works with the read-only token too (posting is then
  disabled).
- Calls are made from Rust (the same HTTP client as the AI code), so the webview's security
  policy does not change. Tokens never reach the frontend.
- Pagination, rate limits (`429` with `Retry-After`), expired or revoked tokens and missing
  permissions all get clear messages, like the remote errors today.

### Code layout

```
src-tauri/src/forge/mod.rs      Forge trait: user, review list, details, discussions, drafts, approve
src-tauri/src/forge/gitlab.rs   GitLab implementation
src-tauri/src/forge/remote.rs   Host and project path from a remote URL
src-tauri/src/secrets.rs        Tokens and API keys in the system credential store
src-tauri/src/ai/               ai.rs split up: provider.rs (Ollama, OpenAI, Anthropic), commit.rs, review.rs
src-tauri/src/review_notes.rs   Review notes per project
src/features/reviews/           Reviews view, merge request view, quest, drafts, summary
src/features/settings/          Accounts section, provider settings, review notes
```

## Phases

Each phase can be released on its own and is tested before the next starts.

1. **GitLab account and Reviews view.** Token in the credential store, project from the remote,
   list of merge requests to review. Tests against a fake GitLab server (like the fake Ollama
   in the AI tests).
2. **Read a merge request in Branchline.** Fetch the ref, commits, diff and existing comments
   (read-only). Useful without any AI.
3. **AI providers.** Split `ai.rs`, add OpenAI-compatible, Anthropic and OpenAI. Commit message
   suggestions use the chosen provider too.
4. **The review quest.** Rounds, question types, visible scoring, draft comments kept
   locally, the limit for large merge requests, and self-review on your own branch.
5. **Post the review.** Draft notes on GitLab, publish, approve or request changes.
6. **Review notes.** Lessons per project, the optional team guide file.
7. **GitHub.** Pull requests where your review is requested, `refs/pull/<n>/head`, review
   comments and reviews.
8. **Bitbucket.** Cloud: built for reading (account with email and API token, lists, reading
   pull requests, also from forks, and the quest). No merge request refs, so the source and
   target branches are fetched instead and the diff starts at their merge base. Posting the
   review comes with phase 5; Data Center later.
