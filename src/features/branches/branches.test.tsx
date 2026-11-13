import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import {
  installTauriTestEnvironment,
  makeHistory,
  openButton,
  REPO,
  setup,
} from "../../test/harness";
import type { BranchInfo, BranchList, RepositoryInfo } from "../../types/git";

installTauriTestEnvironment();

const branch = (over: Partial<BranchInfo>): BranchInfo => ({
  name: "x",
  remote: null,
  oid: "a".repeat(40),
  isCurrent: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  tipTime: 1_700_000_000,
  tipSummary: "Tip",
  ...over,
});

const BRANCHES: BranchList = {
  local: [
    branch({ name: "main", isCurrent: true, upstream: "origin/main", ahead: 2, behind: 1 }),
    branch({ name: "feature/login", tipSummary: "Add login", tipTime: 1_700_000_100 }),
    branch({ name: "old", upstream: "origin/old", upstreamGone: true }),
  ],
  remote: [
    branch({ name: "origin/main", remote: "origin" }),
    branch({ name: "origin/shared", remote: "origin" }),
  ],
};

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function open(extra: Extra = () => undefined, repo: RepositoryInfo = REPO) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return repo.path;
    if (cmd === "inspect_repository") return repo;
    if (cmd === "list_branches") return BRANCHES;
    if (cmd === "check_branch_name") return null;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

async function openBranchesView(extra?: Extra) {
  const ctx = await open(extra);
  await ctx.user.keyboard("{Control>}3{/Control}");
  const view = await screen.findByRole("region", { name: "Branches" });
  await within(view).findByRole("list", { name: "Local branches" });
  /** Show the local or the remote branches. */
  const show = (which: "Local" | "Remote") =>
    ctx.user.click(within(view).getByRole("button", { name: new RegExp(`^${which}`) }));
  return { ...ctx, view, show };
}

describe("branches view", () => {
  it("lists local and remote branches with tracking information", async () => {
    const { view, show } = await openBranchesView();
    const local = within(view).getByRole("list", { name: "Local branches" });
    const rows = within(local).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Current");
    expect(within(rows[0]!).getByLabelText("2 ahead")).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText("1 behind")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("origin/old gone");
    // One list at a time: remote branches are behind the Remote toggle, with their counts.
    expect(within(view).queryByRole("list", { name: "Branches on origin" })).toBeNull();
    expect(within(view).getByRole("button", { name: "Local 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await show("Remote");
    const remote = within(view).getByRole("list", { name: "Branches on origin" });
    expect(within(remote).getAllByRole("listitem")).toHaveLength(2);
    expect(within(view).queryByRole("list", { name: "Local branches" })).toBeNull();
    expect(window.localStorage.getItem("branchline.branches.view")).toBe('"remote"');
    await show("Local");
  });

  it("switches branches and checks out remote branches", async () => {
    const { user, calls, view, show } = await openBranchesView((cmd) =>
      cmd === "switch_branch" || cmd === "checkout_remote_branch" ? REPO : undefined,
    );
    const local = within(view).getByRole("list", { name: "Local branches" });
    await user.click(
      within(within(local).getAllByRole("listitem")[1]!).getByRole("button", { name: "Switch" }),
    );
    expect(calls.find((c) => c.cmd === "switch_branch")?.args).toEqual({
      repo: REPO.path,
      name: "feature/login",
    });
    await show("Remote");
    const remote = within(view).getByRole("list", { name: "Branches on origin" });
    await user.click(
      within(within(remote).getAllByRole("listitem")[1]!).getByRole("button", {
        name: "Check out",
      }),
    );
    expect(calls.find((c) => c.cmd === "checkout_remote_branch")?.args).toEqual({
      repo: REPO.path,
      remoteBranch: "origin/shared",
    });
  });

  it("filters branches", async () => {
    const { user, view } = await openBranchesView();
    await user.type(within(view).getByRole("searchbox", { name: "Filter branches" }), "login");
    const local = within(view).getByRole("list", { name: "Local branches" });
    expect(within(local).getAllByRole("listitem")).toHaveLength(1);
  });

  it("creates a branch with live name validation", async () => {
    const { user, calls, view } = await openBranchesView((cmd, args) => {
      if (cmd === "check_branch_name")
        return (args.name as string).includes("..") ? "Not a valid branch name." : null;
      if (cmd === "create_branch") return REPO;
    });
    await user.click(within(view).getByRole("button", { name: "New branch" }));
    const dialog = await screen.findByRole("dialog", { name: "Create branch" });
    expect(dialog).toHaveTextContent("Starts at main.");
    const input = within(dialog).getByLabelText("Branch name");
    const submit = within(dialog).getByRole("button", { name: "Create branch" });
    expect(submit).toBeDisabled();

    await user.type(input, "feature/login");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
    expect(submit).toBeDisabled();

    await user.clear(input);
    await user.type(input, "bad..name");
    expect(await within(dialog).findByText("Not a valid branch name.")).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "feature/new");
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_branch")?.args).toEqual({
        repo: REPO.path,
        name: "feature/new",
        start: { kind: "head" },
        checkout: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("asks twice before deleting an unmerged branch", async () => {
    let attempts = 0;
    const { user, calls, view } = await openBranchesView((cmd) => {
      if (cmd === "delete_branch") {
        attempts++;
        if (attempts === 1) throw { kind: "notMerged", message: "not merged", detail: null };
        return REPO;
      }
    });
    const rows = within(within(view).getByRole("list", { name: "Local branches" })).getAllByRole(
      "listitem",
    );
    await user.click(
      within(rows[1]!).getByRole("button", { name: "More actions for feature/login" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Delete branch feature/login?" }),
      ).getByRole("button", { name: "Delete branch" }),
    );
    const second = await screen.findByRole("alertdialog", { name: "feature/login is not merged" });
    await user.click(within(second).getByRole("button", { name: "Delete anyway" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "delete_branch").map((c) => c.args.force)).toEqual([
        false,
        true,
      ]),
    );
  });

  it("renames from the context menu with the old name prefilled", async () => {
    const { user, calls, view } = await openBranchesView((cmd) =>
      cmd === "rename_branch" ? REPO : undefined,
    );
    const rows = within(within(view).getByRole("list", { name: "Local branches" })).getAllByRole(
      "listitem",
    );
    fireEvent.contextMenu(rows[1]!, { clientX: 300, clientY: 200 });
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename feature/login" });
    const input = within(dialog).getByLabelText("Branch name");
    expect(input).toHaveValue("feature/login");
    await user.clear(input);
    await user.type(input, "feature/sign-in");
    const submit = within(dialog).getByRole("button", { name: "Rename" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "rename_branch")?.args).toEqual({
        repo: REPO.path,
        old: "feature/login",
        new: "feature/sign-in",
      }),
    );
  });

  it("explains a switch blocked by local changes", async () => {
    const { user, view } = await openBranchesView((cmd) => {
      if (cmd === "switch_branch")
        throw {
          kind: "checkoutConflict",
          message: "Your local changes would be overwritten.",
          detail: "a.txt",
        };
    });
    const rows = within(within(view).getByRole("list", { name: "Local branches" })).getAllByRole(
      "listitem",
    );
    await user.click(within(rows[1]!).getByRole("button", { name: "Switch" }));
    expect(await screen.findByText("Switch blocked by local changes")).toBeInTheDocument();
  });
});

describe("branch switcher in the title bar", () => {
  it("lists recent branches and switches with the keyboard", async () => {
    const { user, calls } = await open((cmd) => (cmd === "switch_branch" ? REPO : undefined));
    const pill = await screen.findByRole("button", { name: /Branch: main/ });
    await waitFor(() => expect(calls.some((c) => c.cmd === "list_branches")).toBe(true));
    await user.click(pill);
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("main"),
      expect.stringContaining("feature/login"),
      expect.stringContaining("old"),
    ]);
    // Checkable items are reachable with the arrow keys.
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "switch_branch")?.args).toEqual({
        repo: REPO.path,
        name: "feature/login",
      }),
    );
  });
});

describe("remote branches in the branch menu", () => {
  it("lists remote branches without a local branch and checks one out", async () => {
    const { user, calls } = await open((cmd) =>
      cmd === "checkout_remote_branch" ? REPO : undefined,
    );
    const pill = await screen.findByRole("button", { name: /Branch: main/ });
    await waitFor(() => expect(calls.some((c) => c.cmd === "list_branches")).toBe(true));
    await user.click(pill);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Check out a remote branch")).toBeInTheDocument();
    // origin/main is tracked by main (listed above), so only origin/shared is offered.
    expect(within(menu).queryByRole("menuitem", { name: /origin\/main/ })).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: /origin\/shared/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "checkout_remote_branch")?.args).toEqual({
        repo: REPO.path,
        remoteBranch: "origin/shared",
      }),
    );
  });
});

describe("cleaning up branches", () => {
  const GONE = (name: string, localOnly = 0, inUse = false) => ({
    name,
    upstream: `origin/${name}`,
    oid: `${name[0]}`.repeat(40),
    tipSummary: `Work on ${name}`,
    tipTime: 1_700_000_000,
    localOnly,
    inUse,
  });

  it("deletes branches whose upstream is gone and that lose nothing, with Undo", async () => {
    const { user, calls, view } = await openBranchesView((cmd) => {
      if (cmd === "gone_branches") return [GONE("old"), GONE("wip", 2), GONE("main", 0, true)];
      if (cmd === "delete_gone_branches") return [[GONE("old")], REPO];
      if (cmd === "create_branch") return REPO;
    });
    await user.click(within(view).getByRole("button", { name: "Clean up branches…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean up branches" });
    const old = await within(dialog).findByRole("checkbox", { name: /old/ });
    expect(old).toBeChecked();
    // Commits only here, or checked out: listed, never offered.
    const kept = within(dialog).getByRole("region", { name: "Kept" });
    expect(kept).toHaveTextContent("2 commits only on this computer");
    expect(kept).toHaveTextContent("checked out");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "Delete 1 branch" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "delete_gone_branches")?.args).toEqual({
        repo: REPO.path,
        names: ["old"],
      }),
    );
    expect(await screen.findByText("Deleted 1 branch")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_branch")?.args).toEqual({
        repo: REPO.path,
        name: "old",
        start: { kind: "commit", oid: "o".repeat(40) },
        checkout: false,
      }),
    );
  });

  it("offers nothing when no upstream is gone", async () => {
    const { view } = await openBranchesView((cmd) =>
      cmd === "list_branches"
        ? { ...BRANCHES, local: BRANCHES.local.filter((b) => !b.upstreamGone) }
        : undefined,
    );
    expect(within(view).queryByRole("button", { name: "Clean up branches…" })).toBeNull();
  });
});

describe("commit context menu", () => {
  it("creates a branch at a commit from the history", async () => {
    const commits = makeHistory(3);
    const { user, calls } = await open((cmd) => {
      if (cmd === "log_page") return { commits, hasMore: false, total: 3 };
      if (cmd === "list_refs") return [];
      if (cmd === "commit_details") return undefined;
      if (cmd === "create_branch") return REPO;
    });
    await user.keyboard("{Control>}2{/Control}");
    const list = await screen.findByRole("listbox", { name: "Commits" });
    const row = within(list).getAllByRole("option")[1]!;
    fireEvent.contextMenu(row, { clientX: 400, clientY: 300 });
    await user.click(await screen.findByRole("menuitem", { name: "Create branch here…" }));
    const dialog = await screen.findByRole("dialog", { name: "Create branch" });
    expect(dialog).toHaveTextContent(`Starts at commit ${commits[1]!.oid.slice(0, 7)}.`);
    await user.type(within(dialog).getByLabelText("Branch name"), "hotfix");
    const submit = within(dialog).getByRole("button", { name: "Create branch" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_branch")?.args).toMatchObject({
        name: "hotfix",
        start: { kind: "commit", oid: commits[1]!.oid },
      }),
    );
  });

  it("opens from the keyboard with Shift+F10", async () => {
    const { user } = await open((cmd) => {
      if (cmd === "log_page") return { commits: makeHistory(2), hasMore: false, total: 2 };
      if (cmd === "list_refs") return [];
    });
    await user.keyboard("{Control>}2{/Control}");
    const list = await screen.findByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    await user.keyboard("{ArrowDown}{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: /Actions for commit/ });
    expect(within(menu).getByRole("menuitem", { name: "Copy commit id" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(list).toHaveFocus();
  });

  it("sorts by name or by last commit and remembers the choice", async () => {
    const extra: Extra = (cmd) => {
      if (cmd === "list_branches")
        return {
          local: [
            branch({ name: "main", isCurrent: true, tipTime: 1 }),
            branch({ name: "release-10", tipTime: 300 }),
            branch({ name: "release-9", tipTime: 100 }),
            branch({ name: "Docs", tipTime: 200 }),
          ],
          remote: [
            branch({ name: "origin/b", remote: "origin", tipTime: 5 }),
            branch({ name: "origin/a", remote: "origin", tipTime: 1 }),
          ],
        };
    };
    const { user, view, show } = await openBranchesView(extra);
    const names = (label: string) =>
      within(within(view).getByRole("list", { name: label }))
        .getAllByRole("listitem")
        .map((li) => li.querySelector(".bl-branch__name .truncate")!.textContent);
    // Natural, case-insensitive order; the current branch stays on top.
    expect(names("Local branches")).toEqual(["main", "Docs", "release-9", "release-10"]);
    await show("Remote");
    expect(names("Branches on origin")).toEqual(["a", "b"]);

    await user.selectOptions(within(view).getByLabelText("Sort branches"), "date");
    expect(names("Branches on origin")).toEqual(["b", "a"]);
    await show("Local");
    expect(names("Local branches")).toEqual(["main", "release-10", "Docs", "release-9"]);
    expect(window.localStorage.getItem("branchline.branches.sort")).toBe('"date"');
  });
});
