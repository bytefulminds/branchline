import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { BranchInfo, FileChange, IntegrateOutcome, RepositoryInfo } from "../../types/git";

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
const BRANCHES = {
  local: [
    branch({ name: "main", isCurrent: true, upstream: "origin/main" }),
    branch({ name: "feature/login", oid: "f".repeat(40) }),
  ],
  remote: [],
};

const result = (over: Partial<IntegrateOutcome> = {}, repo: RepositoryInfo = REPO) => ({
  outcome: { conflicts: false, upToDate: false, fastForward: false, ...over },
  repo,
});

const CONFLICT: FileChange = {
  path: "src/app.ts",
  originalPath: null,
  indexStatus: null,
  worktreeStatus: null,
  conflict: "bothModified",
  isSubmodule: false,
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
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

async function branchMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.keyboard("{Control>}3{/Control}");
  const list = await screen.findByRole("list", { name: "Local branches" });
  const row = within(list).getByText(name).closest("li")!;
  await user.click(within(row).getByRole("button", { name: /More actions/ }));
}

describe("merge and rebase", () => {
  it("merges a branch into the current one, optionally always with a merge commit", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "merge_into_current") return result();
    });
    await branchMenu(user, "feature/login");
    await user.click(await screen.findByRole("menuitem", { name: "Merge into main…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge feature/login into main?" });
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Always create a merge commit" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "merge_into_current")?.args.request).toEqual({
        source: { kind: "branch", name: "feature/login" },
        noFf: true,
        autostash: false,
      }),
    );
    expect(await screen.findByText("Merged feature/login into main")).toBeInTheDocument();
  });

  it("offers to stash and retry when local changes are in the way", async () => {
    const { user, calls } = await open((cmd, args) => {
      if (cmd === "merge_into_current" && !(args.request as { autostash: boolean }).autostash)
        return Promise.reject({
          kind: "checkoutConflict",
          message: "Your local changes would be overwritten.",
          detail: "error: Your local changes to the following files would be overwritten by merge",
        });
      if (cmd === "merge_into_current") return result({ fastForward: true });
    });
    await branchMenu(user, "feature/login");
    await user.click(await screen.findByRole("menuitem", { name: "Merge into main…" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Merge" }),
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Blocked by local changes")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Stash and merge" }));
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.cmd === "merge_into_current")
          .map((c) => (c.args.request as { autostash: boolean }).autostash),
      ).toEqual([false, true]),
    );
    expect(await screen.findByText("Fast-forwarded main to feature/login")).toBeInTheDocument();
  });

  it("warns that rebasing a published branch needs a force push", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "rebase_current") return result();
    });
    await branchMenu(user, "feature/login");
    await user.click(await screen.findByRole("menuitem", { name: "Rebase main onto this…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Rebase main onto feature/login?");
    expect(dialog).toHaveTextContent(/published to origin\/main.*force push/);
    await user.click(within(dialog).getByRole("button", { name: "Rebase" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "rebase_current")?.args).toMatchObject({
        onto: { kind: "branch", name: "feature/login" },
        autostash: false,
      }),
    );
    expect(await screen.findByText("Rebased main onto feature/login")).toBeInTheDocument();
  });
});

describe("cherry-pick and revert", () => {
  async function commitMenu(extra: Extra, index = 1) {
    const commits = makeHistory(3);
    const opened = await open((cmd, args) => {
      if (cmd === "log_page") return { commits, hasMore: false, total: 3 };
      if (cmd === "list_refs") return [];
      if (cmd === "commit_details") return undefined;
      return extra(cmd, args);
    });
    await opened.user.keyboard("{Control>}2{/Control}");
    const list = await screen.findByRole("listbox", { name: "Commits" });
    fireEvent.contextMenu(within(list).getAllByRole("option")[index]!, {
      clientX: 400,
      clientY: 300,
    });
    return { ...opened, oid: commits[index]!.oid };
  }

  it("cherry-picks a commit and reports conflicts", async () => {
    const conflicted: RepositoryInfo = {
      ...REPO,
      operation: "cherryPick",
      changes: [CONFLICT],
      totalChanges: 1,
    };
    const { user, calls, oid } = await commitMenu((cmd) => {
      if (cmd === "cherry_pick") return result({ conflicts: true }, conflicted);
    });
    await user.click(await screen.findByRole("menuitem", { name: "Cherry-pick commit" }));
    await waitFor(() => expect(calls.find((c) => c.cmd === "cherry_pick")?.args.oid).toBe(oid));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Cherry-pick stopped with conflicts")).toBeInTheDocument();
  });

  it("reverts a commit", async () => {
    const { user, calls, oid } = await commitMenu((cmd) => {
      if (cmd === "revert_commit") return result();
    });
    await user.click(await screen.findByRole("menuitem", { name: "Revert commit" }));
    await waitFor(() => expect(calls.find((c) => c.cmd === "revert_commit")?.args.oid).toBe(oid));
    expect(await screen.findByText(`Reverted ${oid.slice(0, 7)}`)).toBeInTheDocument();
  });
});

describe("operation in progress", () => {
  const rebasing: RepositoryInfo = {
    ...REPO,
    head: { kind: "detached", oid: "c".repeat(40) },
    operation: "rebase",
    operationProgress: { step: 2, total: 5, branch: "main" },
    changes: [CONFLICT],
    totalChanges: 1,
  };

  it("shows rebase progress, blocks Continue until resolved, and aborts after confirmation", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "operation_step") return result({}, REPO);
    }, rebasing);
    const banner = screen
      .getAllByRole("status")
      .find((el) => el.classList.contains("bl-operation"))!;
    expect(banner).toHaveTextContent("Rebasing main: commit 2 of 5.");
    expect(banner).toHaveTextContent("Resolve 1 conflicted file, then continue.");
    expect(within(banner).getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(within(banner).getByRole("button", { name: "Skip commit" })).toBeEnabled();
    // Committing directly is not offered in the middle of a rebase.
    expect(screen.getByText(/Resolve the conflict first|Use Continue above/)).toBeInTheDocument();

    await user.click(within(banner).getByRole("button", { name: "Abort" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Abort the rebase?");
    await user.click(within(dialog).getByRole("button", { name: "Abort rebase" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "operation_step")?.args.step).toBe("abort"),
    );
    expect(await screen.findByText("Aborted the rebase")).toBeInTheDocument();
  });

  it("continues once conflicts are resolved", async () => {
    const resolved: RepositoryInfo = { ...rebasing, changes: [], totalChanges: 0 };
    const { user, calls } = await open((cmd) => {
      if (cmd === "operation_step") return result({}, REPO);
    }, resolved);
    const banner = screen
      .getAllByRole("status")
      .find((el) => el.classList.contains("bl-operation"))!;
    expect(banner).toHaveTextContent("All conflicts are resolved. Continue to finish this step.");
    await user.click(within(banner).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "operation_step")?.args.step).toBe("continue"),
    );
    expect(await screen.findByText("Finished the rebase")).toBeInTheDocument();
  });

  it("does not commit directly in the middle of a rebase", async () => {
    const resolved: RepositoryInfo = {
      ...rebasing,
      changes: [{ ...CONFLICT, conflict: null, indexStatus: "modified" }],
    };
    await open(undefined, resolved);
    expect(screen.getByText("Use Continue above to finish this rebase step.")).toBeInTheDocument();
  });
});
