import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { RemoteResult, RepositoryInfo } from "../../types/git";

installTauriTestEnvironment();

const LEASE = "a".repeat(40);
const REWRITTEN: RepositoryInfo = {
  ...REPO,
  upstream: { name: "origin/main", ahead: 1, behind: 2, gone: false },
  rewrite: { lease: LEASE, replaced: 2, pushedSince: 0 },
};
const PUSHED_SINCE: RepositoryInfo = {
  ...REWRITTEN,
  upstream: { name: "origin/main", ahead: 1, behind: 3, gone: false },
  rewrite: { lease: LEASE, replaced: 2, pushedSince: 1 },
};
const result = (repo: RepositoryInfo): RemoteResult => ({
  outcome: {
    updatedRefs: 1,
    conflicts: false,
    upToDate: false,
    stashKept: false,
    target: "origin/main",
  },
  repo,
});

async function open(
  repo: RepositoryInfo,
  extra: (cmd: string, args: Record<string, unknown>) => unknown,
) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return repo.path;
    if (cmd === "inspect_repository") return repo;
    if (cmd === "list_branches") return { local: [], remote: [] };
    if (cmd === "list_remotes") return [{ name: "origin", url: "x", pushUrl: null }];
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  const toolbar = screen.getByRole("group", { name: "Remote" });
  return { user, calls, toolbar };
}

describe("pushing a rewritten branch", () => {
  it("turns Push into a force push pinned to the rewritten commit", async () => {
    const { user, calls, toolbar } = await open(REWRITTEN, (cmd) => {
      if (cmd === "push_branch") return result({ ...REWRITTEN, rewrite: null });
    });
    const button = within(toolbar).getByRole("button", { name: /^Force push/ });
    expect(button).toHaveAttribute(
      "data-tooltip",
      "You rewrote 2 pushed commits: force push to origin/main",
    );
    await user.click(button);
    const dialog = await screen.findByRole("alertdialog", { name: "Force push main?" });
    expect(dialog).toHaveTextContent("You rewrote 2 pushed commits of main");
    await user.click(within(dialog).getByRole("button", { name: "Force push" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "push_branch")?.args.request).toEqual({
        branch: "main",
        remote: null,
        setUpstream: false,
        force: true,
        lease: LEASE,
      }),
    );
  });

  it("when someone pushed since, fetches and offers to bring their commits in", async () => {
    let refused = false;
    const { user, calls, toolbar } = await open(REWRITTEN, (cmd) => {
      if (cmd === "push_branch" && !refused) {
        refused = true;
        return Promise.reject({ kind: "staleLease", message: "The remote moved." });
      }
      if (cmd === "fetch_remote") return result(PUSHED_SINCE);
      if (cmd === "bring_in_pushed")
        return {
          outcome: { conflicts: false, upToDate: false, fastForward: false },
          repo: { ...REWRITTEN, rewrite: { lease: "b".repeat(40), replaced: 3, pushedSince: 0 } },
        };
    });
    await user.click(within(toolbar).getByRole("button", { name: /^Force push/ }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Force push" }),
    );
    const alert = await screen.findByText("Someone pushed to origin/main after your rewrite");
    const toast = alert.closest<HTMLElement>('[role="alert"]')!;
    expect(toast).toHaveTextContent("1 new commit on origin/main would be lost");
    expect(calls.some((c) => c.cmd === "fetch_remote")).toBe(true);
    await user.click(within(toast).getByRole("button", { name: "Bring in their commits" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "bring_in_pushed")).toBe(true));
    expect(await screen.findByText("Brought in their commits")).toBeInTheDocument();
  });

  it("does not force push at all while their new commits are known", async () => {
    const { user, calls, toolbar } = await open(PUSHED_SINCE, () => undefined);
    await user.click(within(toolbar).getByRole("button", { name: /^Force push/ }));
    expect(
      await screen.findByText("Someone pushed to origin/main after your rewrite"),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "push_branch")).toBe(false);
  });
});
