import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import type { GitError, RepositoryInfo } from "./types/git";

const REPO: RepositoryInfo = {
  path: "/Users/dev/projects/demo",
  name: "demo",
  gitDir: "/Users/dev/projects/demo/.git",
  head: { kind: "branch", name: "main", oid: "a".repeat(40) },
  upstream: { name: "origin/main", ahead: 2, behind: 1, gone: false },
  headCommit: {
    oid: "a".repeat(40),
    shortOid: "aaaaaaa",
    summary: "Initial commit",
    authorName: "Dev",
    authorDate: new Date().toISOString(),
  },
  operation: null,
  changes: [
    {
      path: "src/app.ts",
      originalPath: null,
      indexStatus: null,
      worktreeStatus: "modified",
      conflict: null,
      isSubmodule: false,
    },
    {
      path: "notes/new file.md",
      originalPath: null,
      indexStatus: null,
      worktreeStatus: "untracked",
      conflict: null,
      isSubmodule: false,
    },
    {
      path: "lib/b.rs",
      originalPath: "lib/a.rs",
      indexStatus: "renamed",
      worktreeStatus: null,
      conflict: null,
      isSubmodule: false,
    },
  ],
  totalChanges: 3,
  truncated: false,
  inspectedAt: Date.now(),
  durationMs: 12,
};

/** The primary "Open repository" button in the workspace (title bar and sidebar have their own). */
const openButton = () =>
  within(screen.getByRole("main")).getAllByRole("button", { name: /open repository/i })[0]!;

type Handler = (cmd: string, args: Record<string, unknown>) => unknown;

function setup(handler: Handler) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd.startsWith("plugin:window|")) return cmd.endsWith("is_maximized") ? false : null;
      if (cmd === "git_version")
        return { version: "2.45.0", major: 2, minor: 45, path: "/usr/bin/git" };
      return handler(cmd, (args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

beforeEach(() => {
  (globalThis as unknown as { isTauri: boolean }).isTauri = true;
});
afterEach(() => {
  // Unmount while the IPC mocks still exist so listeners unregister cleanly.
  cleanup();
  clearMocks();
  delete (globalThis as unknown as { isTauri?: boolean }).isTauri;
});

describe("App", () => {
  it("opens a repository from the folder picker and shows real backend data", async () => {
    const user = userEvent.setup();
    const calls = setup((cmd) => {
      if (cmd === "plugin:dialog|open") return "/Users/dev/projects/demo/src";
      if (cmd === "inspect_repository") return REPO;
    });
    render(<App />);

    expect(screen.getByRole("heading", { name: "Branchline" })).toBeInTheDocument();
    await screen.findByText("Git 2.45.0");

    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });

    expect(calls.find((c) => c.cmd === "inspect_repository")?.args).toEqual({
      path: "/Users/dev/projects/demo/src",
    });
    const list = screen.getByRole("listbox", { name: "Changed files" });
    expect(within(list).getByText("app.ts")).toBeInTheDocument();
    expect(within(list).getByText("new file.md")).toBeInTheDocument();
    expect(within(list).getAllByRole("img", { name: "Modified" })).toHaveLength(1);
    expect(within(list).getAllByRole("img", { name: "Untracked" })).toHaveLength(1);
    expect(within(list).getAllByRole("img", { name: "Renamed" })).toHaveLength(1);
    expect(screen.getByText("2 unstaged · 1 staged")).toBeInTheDocument();
    // Branch is visible in the title bar and status bar.
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(2);
    // The opened repository is remembered.
    expect(
      JSON.parse(window.localStorage.getItem("branchline.recentRepositories.v1")!)[0].path,
    ).toBe(REPO.path);
  });

  it("supports keyboard navigation through changed files", async () => {
    const user = userEvent.setup();
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") return REPO;
    });
    render(<App />);
    await user.keyboard("{Control>}o{/Control}");
    const list = await screen.findByRole("listbox", { name: "Changed files" });

    act(() => list.focus());
    // Focusing alone does not change the selection; the first arrow key selects the first file.
    expect(within(list).queryAllByRole("option", { selected: true })).toHaveLength(0);
    await user.keyboard("{ArrowDown}");
    expect(within(list).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("complementary", { name: "File details" })).toHaveTextContent(
      "src/app.ts",
    );

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const options = within(list).getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("complementary", { name: "File details" })).toHaveTextContent(
      "lib/a.rs",
    );
  });

  it("shows a specific error for a folder that is not a repository", async () => {
    const user = userEvent.setup();
    const error: GitError = {
      kind: "notARepository",
      message: "This folder is not a Git repository.",
      detail: "fatal: not a git repository (or any of the parent directories): .git",
    };
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return "/tmp/plain";
      if (cmd === "inspect_repository") throw error;
    });
    render(<App />);
    await user.click(openButton());

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("heading", { name: "Not a Git repository" }),
    ).toBeInTheDocument();
    expect(within(alert).getByText("/tmp/plain")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    const calls = setup((cmd) => (cmd === "plugin:dialog|open" ? null : undefined));
    render(<App />);
    await user.click(openButton());
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:dialog|open")).toBe(true));
    expect(calls.some((c) => c.cmd === "inspect_repository")).toBe(false);
    expect(screen.getByRole("heading", { name: "Branchline" })).toBeInTheDocument();
  });

  it("keeps the repository visible and reports a failed refresh", async () => {
    const user = userEvent.setup();
    let fail = false;
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") {
        if (fail)
          throw {
            kind: "timeout",
            message: "The Git command did not finish within 30 seconds.",
            detail: null,
          };
        return REPO;
      }
    });
    render(<App />);
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });

    fail = true;
    await user.keyboard("{Control>}r{/Control}");
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Changes" })).toBeInTheDocument();
  });

  it("drops a slow response when another repository was opened meanwhile", async () => {
    const user = userEvent.setup();
    let resolveSlow: (v: RepositoryInfo) => void = () => {};
    let picks = 0;
    setup((cmd, args) => {
      if (cmd === "plugin:dialog|open") return ++picks === 1 ? "/slow" : REPO.path;
      if (cmd === "inspect_repository") {
        if (args.path === "/slow") return new Promise<RepositoryInfo>((r) => (resolveSlow = r));
        return REPO;
      }
    });
    render(<App />);
    await user.click(openButton());
    await screen.findByText("Opening repository");
    await user.keyboard("{Control>}o{/Control}");
    await screen.findByRole("heading", { name: "Changes" });

    await act(async () => resolveSlow({ ...REPO, name: "slow-repo", path: "/slow" }));
    expect(screen.queryByText("slow-repo")).not.toBeInTheDocument();
  });
});
