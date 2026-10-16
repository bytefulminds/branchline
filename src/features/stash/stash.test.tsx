import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { CommitDetails, RepositoryInfo, StashInfo } from "../../types/git";

installTauriTestEnvironment();

const STASHES: StashInfo[] = [
  {
    index: 0,
    oid: "c".repeat(40),
    message: "Half-done login form",
    branch: "main",
    autoMessage: false,
    time: Math.floor(Date.now() / 1000) - 3600,
    untrackedOid: "d".repeat(40),
  },
  {
    index: 1,
    oid: "e".repeat(40),
    message: "1a2b3c4 Initial commit",
    branch: "develop",
    autoMessage: true,
    time: Math.floor(Date.now() / 1000) - 86400,
    untrackedOid: null,
  },
];

const WITH_STASHES: RepositoryInfo = { ...REPO, stashCount: 2, stashFingerprint: "stash-2" };

const details = (oid: string, path: string, status: string): CommitDetails => ({
  oid,
  parents: [],
  authorName: "Dev",
  authorEmail: "dev@example.com",
  authorDate: new Date().toISOString(),
  committerName: "Dev",
  committerEmail: "dev@example.com",
  committerDate: new Date().toISOString(),
  message: "stash",
  files: [{ path, originalPath: null, status, additions: 3, deletions: 1, binary: false }],
});

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function open(extra: Extra = () => undefined, repo: RepositoryInfo = WITH_STASHES) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return repo.path;
    if (cmd === "inspect_repository") return repo;
    if (cmd === "list_branches") return { local: [], remote: [] };
    if (cmd === "list_stashes") return repo.stashCount ? STASHES : [];
    if (cmd === "commit_details")
      return args.oid === STASHES[0]!.untrackedOid
        ? details(args.oid as string, "notes/todo.md", "A")
        : details(args.oid as string, "src/login.ts", "M");
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

describe("stashes", () => {
  it("stashes changes with a message from the Changes view", async () => {
    const after: RepositoryInfo = { ...REPO, changes: [], totalChanges: 0, stashCount: 1 };
    const { user, calls } = await open((cmd) => {
      if (cmd === "save_stash") return after;
    }, REPO);
    await user.click(screen.getByRole("button", { name: "Stash changes…" }));
    const dialog = await screen.findByRole("dialog", { name: "Stash changes" });
    expect(within(dialog).getByText(/3 changed files/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /Include untracked files/ })).toBeChecked();
    expect(within(dialog).getByText("(1)")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: /Message/ }), "Try the new layout");
    await user.click(within(dialog).getByRole("checkbox", { name: /Include untracked/ }));
    await user.click(within(dialog).getByRole("button", { name: "Stash" }));

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "save_stash")?.args).toEqual({
        repo: REPO.path,
        message: "Try the new layout",
        includeUntracked: false,
      }),
    );
    expect(await screen.findByText("Changes stashed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists stashes with their files, including untracked ones", async () => {
    const { user } = await open();
    expect(screen.getByRole("button", { name: /Stashes/ })).toHaveTextContent("2");
    await user.keyboard("{Control>}4{/Control}");

    const list = await screen.findByRole("list", { name: "Stashes" });
    const items = within(list).getAllByRole("button");
    expect(items[0]).toHaveTextContent("Half-done login form");
    expect(items[0]).toHaveTextContent("with untracked files");
    expect(items[1]).toHaveTextContent("Changes on develop");

    const files = await screen.findByRole("list", { name: "Stashed files" });
    expect(within(files).getByText("login.ts")).toBeInTheDocument();
    expect(within(files).getByText("todo.md")).toBeInTheDocument();

    await user.click(items[1]!);
    const panel = screen.getByRole("region", { name: "Stash details" });
    expect(within(panel).getByText("1a2b3c4 Initial commit")).toBeInTheDocument();
    expect(within(panel).getByText("stash@{1}")).toBeInTheDocument();
  });

  it("pops the selected stash by index and id", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "apply_stash")
        return { outcome: { conflicts: false, kept: false }, repo: WITH_STASHES };
    });
    await user.keyboard("{Control>}4{/Control}");
    const list = await screen.findByRole("list", { name: "Stashes" });
    await user.click(within(list).getAllByRole("button")[1]!);
    const panel = screen.getByRole("region", { name: "Stash details" });
    await user.click(within(panel).getByRole("button", { name: "Pop" }));

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "apply_stash")?.args).toEqual({
        repo: REPO.path,
        index: 1,
        oid: STASHES[1]!.oid,
        pop: true,
      }),
    );
    expect(await screen.findByText("Stash popped")).toBeInTheDocument();
  });

  it("explains a pop with conflicts and keeps the stash", async () => {
    const { user } = await open((cmd) => {
      if (cmd === "apply_stash")
        return { outcome: { conflicts: true, kept: true }, repo: WITH_STASHES };
    });
    // The title bar Pop takes the newest stash.
    await user.click(
      within(screen.getByRole("group", { name: "Stash" })).getByRole("button", { name: "Pop" }),
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Applied with conflicts")).toBeInTheDocument();
    expect(within(alert).getByText(/The stash is kept/)).toBeInTheDocument();
  });

  it("deletes a stash only after confirmation", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "drop_stash") return WITH_STASHES;
    });
    await user.keyboard("{Control>}4{/Control}");
    await screen.findByRole("list", { name: "Stashes" });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Half-done login form/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.cmd === "drop_stash")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete stash" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "drop_stash")?.args).toEqual({
        repo: REPO.path,
        index: 0,
        oid: STASHES[0]!.oid,
      }),
    );
  });

  it("says so when the stash list changed elsewhere", async () => {
    const { user } = await open((cmd) => {
      if (cmd === "apply_stash")
        return Promise.reject({ kind: "stale", message: "changed", detail: null });
    });
    await user.keyboard("{Control>}4{/Control}");
    await screen.findByRole("list", { name: "Stashes" });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("The stash list changed")).toBeInTheDocument();
  });

  it("offers to stash, pull and reapply when local changes block a pull", async () => {
    const { user, calls } = await open((cmd, args) => {
      if (cmd === "list_remotes") return [{ name: "origin", url: "u", pushUrl: null }];
      if (cmd === "pull_branch" && !args.autostash)
        return Promise.reject({
          kind: "checkoutConflict",
          message: "Your local changes would be overwritten.",
          detail: "error: Your local changes to the following files would be overwritten by merge",
        });
      if (cmd === "pull_branch")
        return {
          outcome: {
            updatedRefs: 1,
            conflicts: false,
            upToDate: false,
            target: "origin/main",
            stashKept: false,
          },
          repo: WITH_STASHES,
        };
    });
    await user.click(screen.getByRole("button", { name: "Pull (1 behind)" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Pull blocked by local changes")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Stash, pull and reapply" }));

    await waitFor(() =>
      expect(
        calls.filter((c) => c.cmd === "pull_branch").map((c) => [c.args.mode, c.args.autostash]),
      ).toEqual([
        ["fastForward", false],
        ["fastForward", true],
      ]),
    );
    expect(await screen.findByText("Pulled origin/main")).toBeInTheDocument();
  });

  it("offers to stash and switch when local changes block a switch", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "list_branches")
        return {
          local: [
            {
              name: "main",
              remote: null,
              oid: "a".repeat(40),
              isCurrent: true,
              upstream: null,
              ahead: 0,
              behind: 0,
              upstreamGone: false,
              tipTime: 1,
              tipSummary: "x",
            },
            {
              name: "feature",
              remote: null,
              oid: "b".repeat(40),
              isCurrent: false,
              upstream: null,
              ahead: 0,
              behind: 0,
              upstreamGone: false,
              tipTime: 2,
              tipSummary: "y",
            },
          ],
          remote: [],
        };
      if (cmd === "switch_branch" && !calls.some((c) => c.cmd === "save_stash"))
        return Promise.reject({
          kind: "checkoutConflict",
          message: "Your local changes would be overwritten.",
          detail: "src/app.ts",
        });
      if (cmd === "save_stash") return WITH_STASHES;
      if (cmd === "switch_branch") return WITH_STASHES;
    });
    await user.click(screen.getByRole("button", { name: /^Branch: main/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /feature/ }));
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Stash and switch" }));

    await waitFor(() =>
      expect(calls.filter((c) => /save_stash|switch_branch/.test(c.cmd)).map((c) => c.cmd)).toEqual(
        ["switch_branch", "save_stash", "switch_branch"],
      ),
    );
    expect(calls.find((c) => c.cmd === "save_stash")?.args.includeUntracked).toBe(true);
    expect(await screen.findByText("Switched to feature")).toBeInTheDocument();
  });

  it("tells where held changes are during a merge", async () => {
    const merging: RepositoryInfo = {
      ...REPO,
      operation: "merge",
      heldChanges: true,
      changes: [
        {
          path: "CHANGELOG.md",
          originalPath: null,
          indexStatus: null,
          worktreeStatus: null,
          conflict: "bothModified",
          isSubmodule: false,
        },
      ],
      totalChanges: 1,
    };
    await open(undefined, merging);
    const banners = screen
      .getAllByRole("status")
      .filter((el) => el.classList.contains("bl-banner"));
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveTextContent(/Merge in progress/);
    expect(banners[0]).toHaveTextContent(/uncommitted changes are put aside by Git/);
  });
});
