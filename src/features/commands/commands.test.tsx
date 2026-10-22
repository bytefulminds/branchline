import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { BranchInfo } from "../../types/git";
import { fuzzyMatch } from "./fuzzy";

installTauriTestEnvironment();

const branch = (name: string, isCurrent = false): BranchInfo => ({
  name,
  remote: null,
  oid: "b".repeat(40),
  isCurrent,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  tipTime: 0,
  tipSummary: `Tip of ${name}`,
  worktreePath: null,
});

async function start({
  open = true,
  extra = () => undefined,
}: {
  open?: boolean;
  extra?: (cmd: string, args: Record<string, unknown>) => unknown;
} = {}) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "list_branches")
      return { local: [branch("main", true), branch("feature/login")], remote: [] };
    if (cmd === "switch_branch") return REPO;
    if (cmd === "log_page") return { commits: [], hasMore: false, total: 0 };
    if (cmd === "list_refs") return [];
    if (cmd === "plugin:app|version") return "0.1.0";
    return extra(cmd, args);
  });
  render(<App />);
  if (open) {
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
  }
  return { user, calls };
}

const palette = () => screen.getByRole("dialog", { name: "Command palette" });

describe("command palette", () => {
  it("opens with Ctrl+K, finds commands fuzzily and runs one with Enter", async () => {
    const { user } = await start();
    await user.keyboard("{Control>}k{/Control}");
    const input = within(palette()).getByRole("combobox", { name: "Command" });
    expect(input).toHaveFocus();
    await user.type(input, "go hist");
    const first = within(palette()).getAllByRole("option")[0]!;
    expect(first).toHaveTextContent("Go to History");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
  });

  it("lists branches to switch to and moves with the arrow keys", async () => {
    const { user, calls } = await start();
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await user.type(within(palette()).getByRole("combobox"), "switch");
    const options = await within(palette()).findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Switch to feature/login")]),
    );
    // The current branch is not offered.
    expect(palette()).not.toHaveTextContent("Switch to main");
    const index = options.findIndex((o) => o.textContent?.includes("feature/login"));
    for (let i = 0; i < index; i++) await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "switch_branch")?.args).toMatchObject({
        name: "feature/login",
      }),
    );
  });

  it("shows why a command cannot run and closes with Escape", async () => {
    const { user } = await start({ open: false });
    await user.click(screen.getByRole("button", { name: /^Commands/ }));
    await user.type(within(palette()).getByRole("combobox"), "go to branches");
    const option = within(palette()).getAllByRole("option")[0]!;
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent("Open a repository first");
    await user.keyboard("{Enter}");
    expect(palette()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("says when nothing matches", async () => {
    const { user } = await start();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(within(palette()).getByRole("combobox"), "zzqx");
    expect(within(palette()).getByRole("status")).toHaveTextContent("No commands match");
  });
});

describe("shortcuts and about", () => {
  it("opens the shortcut overview with Ctrl+/ or ?, but not while typing", async () => {
    const { user } = await start();
    await user.keyboard("{Control>}/{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByRole("heading", { name: "Merge editor" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Command palette");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("textbox", { name: "Commit summary" }));
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toHaveValue("?");
  });

  it("shows the version and checks for updates from About", async () => {
    let update: unknown = null;
    const { user } = await start({
      extra: (cmd) => (cmd === "plugin:updater|check" ? update : undefined),
    });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(within(palette()).getByRole("combobox"), "about");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "About Branchline" });
    expect(await within(dialog).findByText("Branchline 0.1.0")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Branchline is up to date")).toBeInTheDocument();

    update = {
      rid: 1,
      currentVersion: "0.1.0",
      version: "0.2.0",
      date: null,
      body: "",
      rawJson: {},
    };
    await user.click(within(dialog).getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Branchline 0.2.0 is available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeInTheDocument();
  });
});

describe("fuzzy matching", () => {
  it("matches subsequences and prefers word starts and runs", () => {
    expect(fuzzyMatch("nb", "New branch…")?.indices).toEqual([0, 4]);
    expect(fuzzyMatch("xyz", "New branch")).toBeNull();
    const start = fuzzyMatch("push", "Push")!.score;
    const inside = fuzzyMatch("push", "Force push (with lease)…")!.score;
    expect(start).toBeGreaterThan(inside);
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });
});
