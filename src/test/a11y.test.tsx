/**
 * Automated accessibility checks (axe-core) over every main screen and dialog.
 *
 * jsdom has no layout, so rules that need rendering (color contrast, target size) are
 * checked by hand instead; see docs/accessibility.md. Everything else axe knows about
 * (names, roles, ARIA state, labels, landmarks, duplicate ids, list structure) must pass.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it } from "vitest";
import App from "../App";
import { audit } from "./axe";
import { installTauriTestEnvironment, makeHistory, openButton, REPO, setup } from "./harness";
import type { RepositoryInfo } from "../types/git";

installTauriTestEnvironment();

const COMMITS = makeHistory(30);
const REPO_AT_HEAD: RepositoryInfo = {
  ...REPO,
  head: { kind: "branch", name: "main", oid: COMMITS[0]!.oid },
  stashCount: 1,
};
const identity = {
  name: "Ada",
  email: "ada@example.com",
  signCommits: false,
  signingFormat: "",
  signingKey: "",
};

async function start() {
  const user = userEvent.setup();
  setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO_AT_HEAD;
    if (cmd === "log_page") return { commits: COMMITS, hasMore: false, total: COMMITS.length };
    if (cmd === "list_refs") return [{ name: "main", kind: "branch", oid: COMMITS[0]!.oid }];
    if (cmd === "commit_details")
      return {
        oid: args.oid,
        parents: [COMMITS[1]!.oid],
        authorName: "Grace Hopper",
        authorEmail: "grace@example.com",
        authorDate: "2023-11-14T22:13:20+00:00",
        committerName: "Grace Hopper",
        committerEmail: "grace@example.com",
        committerDate: "2023-11-14T22:13:20+00:00",
        message: "Commit number 0",
        files: [
          {
            path: "src/app.ts",
            originalPath: null,
            status: "M",
            additions: 1,
            deletions: 1,
            binary: false,
          },
        ],
      };
    if (cmd === "list_branches")
      return {
        local: [
          {
            name: "main",
            remote: null,
            oid: COMMITS[0]!.oid,
            isCurrent: true,
            upstream: "origin/main",
            ahead: 2,
            behind: 1,
            upstreamGone: false,
            tipTime: 1_700_000_000,
            tipSummary: "Commit number 0",
          },
        ],
        remote: [],
      };
    if (cmd === "list_stashes")
      return [
        {
          index: 0,
          name: "stash@{0}",
          message: "WIP on main",
          branch: "main",
          oid: "c".repeat(40),
          time: 1_700_000_000,
          includesUntracked: false,
        },
      ];
    if (cmd === "list_worktrees") return [];
    if (cmd === "list_tags") return [];
    if (cmd === "list_remotes")
      return [{ name: "origin", url: "https://example.com/repo.git", pushUrl: null }];
    if (cmd === "get_identity") return { global: identity, repository: null };
    if (cmd === "plugin:app|version") return "0.1.0";
    if (cmd === "git_command_log")
      return (args.since as number) > 0
        ? []
        : [
            {
              id: 1,
              seq: 1,
              startedAt: 1_700_000_000_000,
              durationMs: 40,
              cwd: REPO.path,
              args: ["commit", "-F", "-"],
              readOnly: false,
              exitCode: 1,
              ok: false,
              error: null,
              stdout: "",
              stdoutBytes: 0,
              stderr: "pre-commit hook failed",
              stderrBytes: 22,
              stdinBytes: 10,
            },
          ];
    return undefined;
  });
  render(<App />);
  return user;
}

describe("accessibility (axe)", () => {
  it("welcome screen", async () => {
    await start();
    await screen.findByRole("heading", { level: 1 });
    await audit("welcome");
  });

  it("every workspace view", async () => {
    const user = await start();
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    await user.click(await screen.findByText("app.ts"));
    await screen.findByRole("region", { name: "Changes in src/app.ts" });
    await audit("changes with diff");

    await user.click(screen.getByRole("button", { name: "Side by side" }));
    await screen.findByLabelText("Old version");
    await audit("side-by-side diff");

    const views: [string, string][] = [
      ["2", "History"],
      ["3", "Branches"],
      ["4", "Stashes"],
      ["5", "Tags"],
      ["6", "Worktrees"],
    ];
    for (const [key, name] of views) {
      await user.keyboard(`{Control>}${key}{/Control}`);
      await screen.findByRole("heading", { name, level: 1 });
      await audit(name);
    }

    await user.keyboard("{Control>}2{/Control}");
    await user.click(await screen.findByRole("button", { name: /^Filters/ }));
    await screen.findByRole("group", { name: "Filters" });
    await audit("history filters");

    await user.keyboard("{Control>}j{/Control}");
    const consolePanel = await screen.findByRole("region", { name: "Git console" });
    await user.click(await within(consolePanel).findByRole("button", { name: /git commit/ }));
    await within(consolePanel).findByText("pre-commit hook failed");
    await audit("Git console");
  }, 20_000);

  it("dialogs: palette, shortcuts, about, settings", async () => {
    const user = await start();
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });

    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Command palette" });
    await audit("command palette");
    await user.keyboard("{Escape}");

    await user.keyboard("{Control>}/{/Control}");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await audit("shortcuts");
    await user.keyboard("{Escape}");

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: "Command" }), "about");
    await user.keyboard("{Enter}");
    const settingsAbout = await screen.findByRole("dialog", { name: "Settings" });
    await within(settingsAbout).findByRole("list", { name: "Open-source packages" });
    await audit("about");
    await user.keyboard("{Escape}");

    await user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    for (const section of [
      "General",
      "Git",
      "Identity & signing",
      "Editor & diff",
      "Confirmations",
      "AI commit messages",
    ]) {
      await user.click(within(settings).getByRole("button", { name: section }));
      await audit(`settings: ${section}`);
    }
  }, 30_000);
});
