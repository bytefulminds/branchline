import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { RepositoryInfo } from "../../types/git";

installTauriTestEnvironment();

const id = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number, summary: string, ...parents: number[]) => ({
  oid: id(n),
  parents: parents.map(id),
  authorName: "Grace Hopper",
  authorEmail: "grace@example.com",
  authorTime: 1_700_000_000 - n * 3600,
  summary,
});

// main: 1 <- 2 <- 3 (HEAD), and 4 on another branch merged... 5 is the root.
const COMMITS = [
  commit(1, "Add login form", 2),
  commit(2, "Debug logging", 3),
  commit(3, "Merge branch 'side'", 5, 4),
  commit(4, "Side work", 5),
  commit(5, "Initial commit"),
  commit(6, "Other branch work", 5),
];
const ON_MAIN: RepositoryInfo = {
  ...REPO,
  head: { kind: "branch", name: "main", oid: id(1) },
  upstream: null,
};
const ok = { outcome: { conflicts: false, upToDate: false, fastForward: false }, repo: ON_MAIN };

async function openHistory() {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return ON_MAIN;
    if (cmd === "log_page") return { commits: COMMITS, hasMore: false, total: COMMITS.length };
    if (cmd === "list_refs")
      return [
        { name: "main", kind: "branch", oid: id(1) },
        { name: "other", kind: "branch", oid: id(6) },
      ];
    if (cmd === "rebase_plan_commits") {
      // Oldest first after the base: main is 3 <- 2 <- 1.
      const after = args.base === id(3) ? [2, 1] : args.base === id(2) ? [1] : [];
      return after.map((n) => ({
        oid: id(n),
        summary: COMMITS.find((c) => c.oid === id(n))!.summary,
        message: `${COMMITS.find((c) => c.oid === id(n))!.summary}\n\nWhy it matters.`,
        authorName: "Grace Hopper",
        authorTime: 0,
      }));
    }
    if (cmd === "reset_to_commit") return ON_MAIN;
    if (cmd === "interactive_rebase") return ok;
    return undefined;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  await within(list).findByText("Add login form");
  return { user, calls, list };
}

const itemFor = async (
  user: ReturnType<typeof userEvent.setup>,
  list: HTMLElement,
  text: string,
  name: RegExp,
) => {
  const row = within(list).getByText(text).closest<HTMLElement>('[role="option"]')!;
  await user.pointer({ keys: "[MouseRight]", target: row });
  return screen.findByRole("menuitem", { name });
};

const menuFor = async (
  user: ReturnType<typeof userEvent.setup>,
  list: HTMLElement,
  text: string,
) => {
  const row = within(list).getByText(text).closest<HTMLElement>('[role="option"]')!;
  await user.pointer({ keys: "[MouseRight]", target: row });
  return screen.findByRole("menuitem", { name: /Drop commit/ });
};

describe("dropping a commit from the history", () => {
  it("asks, then drops it and keeps the commits after it", async () => {
    const { user, calls, list } = await openHistory();
    await user.click(await menuFor(user, list, "Debug logging"));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Are you sure you want to drop 1 commit?",
    });
    expect(dialog).toHaveTextContent('"Debug logging" and its changes are removed from main.');
    expect(dialog).toHaveTextContent("The commit after it is applied again");
    await user.click(within(dialog).getByRole("button", { name: "Drop commit" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args).toMatchObject({
        base: id(3),
        autostash: false,
        plan: [
          { oid: id(2), action: "drop" },
          { oid: id(1), action: "pick" },
        ],
      }),
    );
    expect(calls.find((c) => c.cmd === "rebase_plan_commits")?.args.base).toBe(id(3));
  });

  it("is not offered for merges, the first commit or other branches", async () => {
    const { user, list } = await openHistory();
    expect(await menuFor(user, list, "Merge branch 'side'")).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Drop commit/ })).toHaveTextContent(
      "Merge commits cannot be changed here",
    );
    await user.keyboard("{Escape}");
    expect(await menuFor(user, list, "Initial commit")).toHaveTextContent(
      "The first commit cannot be changed here",
    );
    await user.keyboard("{Escape}");
    expect(await menuFor(user, list, "Other branch work")).toHaveTextContent(
      "Not a commit of main",
    );
  });
});

describe("rewriting one commit from the history", () => {
  it("edits a commit message", async () => {
    const { user, calls, list } = await openHistory();
    await user.click(await itemFor(user, list, "Debug logging", /Edit commit message/));
    const dialog = await screen.findByRole("dialog", {
      name: `Edit the message of ${id(2).slice(0, 7)}`,
    });
    const summary = within(dialog).getByLabelText("Summary");
    expect(summary).toHaveValue("Debug logging");
    expect(within(dialog).getByLabelText(/Description/)).toHaveValue("Why it matters.");
    await user.clear(summary);
    await user.type(summary, "Add debug logging");
    await user.click(within(dialog).getByRole("button", { name: "Save message" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args).toMatchObject({
        base: id(3),
        plan: [
          { oid: id(2), action: "reword", message: "Add debug logging\n\nWhy it matters." },
          { oid: id(1), action: "pick" },
        ],
      }),
    );
  });

  it("moves a commit up and down by swapping it with its neighbour", async () => {
    const { user, calls, list } = await openHistory();
    await user.click(await itemFor(user, list, "Debug logging", /Move commit up/));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args).toMatchObject({
        base: id(3),
        plan: [
          { oid: id(1), action: "pick" },
          { oid: id(2), action: "pick" },
        ],
      }),
    );
    // The newest commit cannot move up; one above a merge cannot move down.
    expect(await itemFor(user, list, "Add login form", /Move commit up/)).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(await itemFor(user, list, "Debug logging", /Move commit down/)).toBeDisabled();
  });

  it("resets the branch from a submenu, soft, mixed or hard", async () => {
    const { user, calls, list } = await openHistory();
    const reset = await itemFor(user, list, "Debug logging", /Reset main to this commit/);
    expect(reset).toHaveAttribute("aria-haspopup", "menu");
    await user.click(reset);
    const sub = await screen.findByRole("menu", { name: "Reset main to this commit" });
    await user.click(within(sub).getByRole("menuitem", { name: /Hard/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: `Reset main to ${id(2).slice(0, 7)} (hard)?`,
    });
    expect(dialog).toHaveTextContent("all uncommitted changes are discarded");
    await user.click(within(dialog).getByRole("button", { name: "Reset and discard" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "reset_to_commit")?.args).toEqual({
        repo: REPO.path,
        oid: id(2),
        mode: "hard",
      }),
    );
  });

  it("opens the reset submenu with the keyboard", async () => {
    const { user, list } = await openHistory();
    const reset = await itemFor(user, list, "Debug logging", /Reset main to this commit/);
    reset.focus();
    await user.keyboard("{ArrowRight}");
    const sub = await screen.findByRole("menu", { name: "Reset main to this commit" });
    await waitFor(() => expect(within(sub).getByRole("menuitem", { name: /Soft/ })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(within(sub).getByRole("menuitem", { name: /Mixed/ })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(
      screen.queryByRole("menu", { name: "Reset main to this commit" }),
    ).not.toBeInTheDocument();
    expect(reset).toHaveFocus();
  });

  it("drops several selected commits at once", async () => {
    const { user, calls, list } = await openHistory();
    const row = (t: string) => within(list).getByText(t).closest<HTMLElement>('[role="option"]')!;
    await user.click(row("Add login form"));
    await user.keyboard("{Control>}");
    await user.click(row("Debug logging"));
    await user.keyboard("{/Control}");
    await user.pointer({ keys: "[MouseRight]", target: row("Debug logging") });
    await user.click(await screen.findByRole("menuitem", { name: /Drop 2 commits/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Are you sure you want to drop 2 commits?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Drop 2 commits" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args).toMatchObject({
        base: id(3),
        plan: [
          { oid: id(2), action: "drop" },
          { oid: id(1), action: "drop" },
        ],
      }),
    );
  });
});
