import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { BranchInfo, WorktreeInfo } from "../../types/git";
import { defaultWorktreePath } from "./WorktreeDialog";

installTauriTestEnvironment();

const MAIN: WorktreeInfo = {
  path: REPO.path,
  name: "demo",
  head: "a".repeat(40),
  branch: "main",
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  isMain: true,
  isCurrent: true,
  changes: 3,
};
const FIX: WorktreeInfo = {
  ...MAIN,
  path: "/Users/dev/projects/demo-fix",
  name: "demo-fix",
  branch: "fix/crash",
  isMain: false,
  isCurrent: false,
  changes: 2,
};
const GONE: WorktreeInfo = {
  ...FIX,
  path: "/Volumes/usb/demo-old",
  name: "demo-old",
  branch: "old",
  prunable: "gitdir file points to non-existent location",
  changes: null,
};

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
const BRANCHES = {
  local: [
    branch({ name: "main", isCurrent: true }),
    branch({ name: "fix/crash", worktreePath: FIX.path }),
    branch({ name: "feature/x" }),
  ],
  remote: [branch({ name: "origin/feature/y", remote: "origin" })],
};

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function open(extra: Extra = () => undefined, list: WorktreeInfo[] = [MAIN, FIX, GONE]) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return { ...REPO, path: args.path as string };
    if (cmd === "list_branches") return BRANCHES;
    if (cmd === "list_worktrees") return list;
    if (cmd === "check_branch_name") return null;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

async function showWorktrees(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}6{/Control}");
  return screen.findByRole("list", { name: "Worktrees" });
}

const opened = (calls: { cmd: string; args: Record<string, unknown> }[]) =>
  calls.filter((c) => c.cmd === "inspect_repository").map((c) => c.args.path);

describe("worktree paths", () => {
  it("suggests a folder next to the repository", () => {
    expect(defaultWorktreePath("/code/app", "feature/login")).toBe("/code/app-feature-login");
    expect(defaultWorktreePath("/code/app/", "")).toBe("/code/app");
    expect(defaultWorktreePath("C:\\code\\app", "fix #12")).toBe("C:\\code\\app-fix-12");
  });
});

describe("worktrees", () => {
  it("lists worktrees and opens one", async () => {
    const { user, calls } = await open();
    expect(screen.getByRole("button", { name: /Worktrees/ })).toHaveTextContent("3");
    const list = await showWorktrees(user);
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("demo");
    expect(rows[0]).toHaveTextContent("Open");
    expect(rows[0]).toHaveTextContent("3 changes");
    expect(rows[1]).toHaveTextContent("fix/crash");
    expect(rows[2]).toHaveTextContent("Folder is missing");
    expect(screen.getByRole("button", { name: "Clean up 1 missing" })).toBeInTheDocument();

    await user.click(within(rows[1]!).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(opened(calls)).toContain(FIX.path));
  });

  it("creates a worktree with a new branch and opens it", async () => {
    const created = "/Users/dev/projects/demo-feature-new";
    const { user, calls } = await open((cmd) => {
      if (cmd === "add_worktree") return created;
    });
    await showWorktrees(user);
    await user.click(screen.getByRole("button", { name: "New worktree" }));
    const dialog = await screen.findByRole("dialog", { name: "New worktree" });
    await user.type(within(dialog).getByLabelText("Branch name"), "feature/new");
    expect(within(dialog).getByLabelText("Folder")).toHaveValue(created);
    await user.selectOptions(within(dialog).getByLabelText("Starting from"), "origin/feature/y");
    const submit = within(dialog).getByRole("button", { name: "Create worktree" });
    // The branch name is checked by Git first.
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "add_worktree")?.args).toEqual({
        repo: REPO.path,
        path: created,
        target: {
          kind: "newBranch",
          name: "feature/new",
          start: { kind: "branch", name: "origin/feature/y" },
        },
      }),
    );
    await waitFor(() => expect(opened(calls)).toContain(created));
  });

  it("checks out an existing branch and shows Git's refusal in the dialog", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "add_worktree")
        return Promise.reject({
          kind: "invalidPath",
          message: "That folder already exists and is not empty.",
          detail: null,
        });
    });
    await user.keyboard("{Control>}3{/Control}");
    const local = await screen.findByRole("list", { name: "Local branches" });
    const row = within(local).getByText("feature/x").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Open in new worktree/ }));
    const dialog = await screen.findByRole("dialog", { name: "New worktree" });
    expect(within(dialog).getByLabelText("Branch")).toHaveValue("feature/x");
    // Branches checked out elsewhere cannot be picked.
    expect(
      within(dialog).getByRole("option", { name: /fix\/crash \(in another worktree\)/ }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /Open it in Branchline/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create worktree" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("not empty");
    expect(calls.find((c) => c.cmd === "add_worktree")?.args.target).toEqual({
      kind: "branch",
      name: "feature/x",
    });
  });

  it("asks again before removing a worktree with changes", async () => {
    const { user, calls } = await open((cmd, args) => {
      if (cmd === "remove_worktree" && !args.force)
        return Promise.reject({
          kind: "worktreeDirty",
          message: "This worktree has uncommitted or untracked files.",
          detail: FIX.path,
        });
      if (cmd === "remove_worktree") return null;
    });
    const list = await showWorktrees(user);
    const row = within(list).getAllByRole("listitem")[1]!;
    await user.click(within(row).getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Remove/ }));
    const first = await screen.findByRole("alertdialog", { name: "Remove worktree demo-fix?" });
    expect(first).toHaveTextContent("The branch fix/crash stays.");
    await user.click(within(first).getByRole("button", { name: "Remove worktree" }));
    const second = await screen.findByRole("alertdialog", {
      name: "demo-fix has uncommitted changes",
    });
    await user.click(within(second).getByRole("button", { name: "Delete with changes" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "remove_worktree").map((c) => c.args.force)).toEqual([
        false,
        true,
      ]),
    );
    expect(await screen.findByText("Removed worktree demo-fix")).toBeInTheDocument();
  });

  it("the main and the open worktree cannot be removed", async () => {
    const { user } = await open();
    const list = await showWorktrees(user);
    const row = within(list).getAllByRole("listitem")[0]!;
    await user.click(within(row).getByRole("button", { name: /More actions/ }));
    expect(await screen.findByRole("menuitem", { name: /Remove/ })).toBeDisabled();
  });

  it("opens the worktree of a branch checked out elsewhere", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "switch_branch")
        return Promise.reject({
          kind: "branchInWorktree",
          message: "feature/x is checked out in another worktree (/elsewhere/x).",
          detail: "/elsewhere/x",
        });
    });
    await user.keyboard("{Control>}3{/Control}");
    const local = await screen.findByRole("list", { name: "Local branches" });
    const fix = within(local).getByText("fix/crash").closest("li")!;
    expect(fix).toHaveTextContent("worktree");
    await user.click(within(fix).getByRole("button", { name: "Open worktree" }));
    await waitFor(() => expect(opened(calls)).toContain(FIX.path));

    // A worktree made outside Branchline since the list loaded: Git refuses the switch.
    await user.keyboard("{Control>}3{/Control}");
    const again = await screen.findByRole("list", { name: "Local branches" });
    const x = within(again).getByText("feature/x").closest("li")!;
    await user.click(within(x).getByRole("button", { name: "Switch" }));
    await user.click(await screen.findByRole("button", { name: "Open that worktree" }));
    await waitFor(() => expect(opened(calls)).toContain("/elsewhere/x"));
  });
});
