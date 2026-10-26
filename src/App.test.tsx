import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import { openButton, REPO, setup, installTauriTestEnvironment } from "./test/harness";
import type { GitError, RepositoryInfo } from "./types/git";

installTauriTestEnvironment();

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
    await screen.findByRole("region", { name: "Changes in src/app.ts" });

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const options = within(list).getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    await screen.findByRole("region", { name: "Changes in lib/b.rs" });
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

  it("shows the spinner in the Refresh button's place while refreshing", async () => {
    const user = userEvent.setup();
    let finish: (v: RepositoryInfo) => void = () => {};
    let slow = false;
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository")
        return slow ? new Promise<RepositoryInfo>((resolve) => (finish = resolve)) : REPO;
    });
    render(<App />);
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });

    slow = true;
    const refresh = screen.getByRole("button", { name: /^Refresh/ });
    await user.click(refresh);
    expect(await screen.findByRole("status", { name: "Refreshing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Refresh/ })).not.toBeInTheDocument();

    finish(REPO);
    const back = await screen.findByRole("button", { name: /^Refresh/ });
    expect(back).toHaveFocus();
    expect(screen.queryByRole("status", { name: "Refreshing" })).not.toBeInTheDocument();
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
