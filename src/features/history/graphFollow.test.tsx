import { render, screen, within } from "@testing-library/react";
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

// feature/login has one commit on top of main; main merged an unnamed fix branch.
const COMMITS = [
  commit(1, "Add login form", 2),
  commit(2, "Merge branch 'fix/empty-city'", 4, 3),
  commit(3, "Handle an empty city", 5),
  commit(4, "Show five days", 5),
  commit(5, "Initial commit"),
];
const REPO_ON_FEATURE: RepositoryInfo = {
  ...REPO,
  head: { kind: "branch", name: "feature/login", oid: id(1) },
};

async function openHistory() {
  const user = userEvent.setup();
  setup((cmd) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO_ON_FEATURE;
    if (cmd === "log_page") return { commits: COMMITS, hasMore: false, total: COMMITS.length };
    if (cmd === "list_refs")
      return [
        { name: "feature/login", kind: "branch", oid: id(1) },
        { name: "main", kind: "branch", oid: id(2) },
        { name: "origin/main", kind: "remote", oid: id(2) },
      ];
    if (cmd === "commit_details")
      return {
        oid: id(1),
        parents: [id(2)],
        authorName: "Grace Hopper",
        authorEmail: "grace@example.com",
        authorDate: "2023-11-14T22:13:20+00:00",
        committerName: "Grace Hopper",
        committerEmail: "grace@example.com",
        committerDate: "2023-11-14T22:13:20+00:00",
        message: "Add login form",
        files: [],
      };
    return undefined;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  await within(list).findByText("Add login form");
  return { user, list };
}

const row = (list: HTMLElement, text: string) =>
  within(list).getByText(text).closest<HTMLElement>('[role="option"]')!;

describe("following a branch in the graph", () => {
  it("highlights the branch from the commit menu, and Escape stops", async () => {
    const { user, list } = await openHistory();
    await user.pointer({ keys: "[MouseRight]", target: row(list, "Add login form") });
    await user.click(await screen.findByRole("menuitem", { name: /Follow this branch/ }));

    expect((await screen.findByText(/Following/)).closest(".bl-history__follow")).toHaveTextContent(
      "Following feature/login · 1 commit",
    );
    expect(row(list, "Add login form")).not.toHaveClass("bl-commit-row--faded");
    expect(row(list, "Show five days")).toHaveClass("bl-commit-row--faded");

    list.focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/Following/)).not.toBeInTheDocument();
    expect(row(list, "Show five days")).not.toHaveClass("bl-commit-row--faded");
  });

  it("follows the branch under a click in the graph", async () => {
    const { user, list } = await openHistory();
    const graph = (text: string) =>
      row(list, text).querySelector<HTMLElement>(".bl-commit-row__graph")!;
    // Lane 0 is kept for main, which starts one row lower: nothing to follow there.
    await user.pointer({
      keys: "[MouseLeft]",
      target: graph("Add login form"),
      coords: { clientX: 10 },
    });
    expect(screen.queryByText(/Following/)).not.toBeInTheDocument();
    // Lane 1 holds the commit of feature/login.
    await user.pointer({
      keys: "[MouseLeft]",
      target: graph("Add login form"),
      coords: { clientX: 24 },
    });
    expect(screen.getByText(/Following/).closest(".bl-history__follow")).toHaveTextContent(
      "Following feature/login",
    );
    // Clicking it again stops following.
    await user.pointer({
      keys: "[MouseLeft]",
      target: graph("Add login form"),
      coords: { clientX: 24 },
    });
    expect(screen.queryByText(/Following/)).not.toBeInTheDocument();
  });

  it("follows main past the branch that was made from it", async () => {
    const { user, list } = await openHistory();
    await user.pointer({ keys: "[MouseRight]", target: row(list, "Show five days") });
    await user.click(await screen.findByRole("menuitem", { name: /Follow this branch/ }));
    expect(screen.getByText(/Following/).closest(".bl-history__follow")).toHaveTextContent(
      "Following main · 3 commits",
    );
    expect(row(list, "Add login form")).toHaveClass("bl-commit-row--faded");
    expect(row(list, "Handle an empty city")).toHaveClass("bl-commit-row--faded");
  });

  it("names a merged branch after its merge", async () => {
    const { user, list } = await openHistory();
    await user.pointer({ keys: "[MouseRight]", target: row(list, "Handle an empty city") });
    await user.click(await screen.findByRole("menuitem", { name: /Follow this branch/ }));
    expect(screen.getByText(/Following/).closest(".bl-history__follow")).toHaveTextContent(
      "Following fix/empty-city (merged) · 1 commit",
    );
  });
});

describe("collapsing merged branches", () => {
  it("hides an unnamed merged branch behind its merge, and shows it again", async () => {
    const { user, list } = await openHistory();
    await user.click(screen.getByRole("button", { name: "Collapse merged branches" }));
    expect(within(list).queryByText("Handle an empty city")).not.toBeInTheDocument();
    const merge = row(list, "Merge branch 'fix/empty-city'");
    expect(merge).toHaveAttribute("aria-expanded", "false");

    await user.click(within(merge).getByText("+1"));
    expect(within(list).getByText("Handle an empty city")).toBeInTheDocument();
    expect(row(list, "Merge branch 'fix/empty-city'")).toHaveAttribute("aria-expanded", "true");

    // Left on the merge collapses it again.
    await user.click(row(list, "Merge branch 'fix/empty-city'"));
    await user.keyboard("{ArrowLeft}");
    expect(within(list).queryByText("Handle an empty city")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show merged branches" }));
    expect(within(list).getByText("Handle an empty city")).toBeInTheDocument();
    expect(within(list).queryByText("+1")).not.toBeInTheDocument();
  });

  it("offers the same in the commit menu", async () => {
    const { user, list } = await openHistory();
    await user.click(screen.getByRole("button", { name: "Collapse merged branches" }));
    await user.pointer({
      keys: "[MouseRight]",
      target: row(list, "Merge branch 'fix/empty-city'"),
    });
    await user.click(await screen.findByRole("menuitem", { name: "Show the 1 merged commit" }));
    expect(within(list).getByText("Handle an empty city")).toBeInTheDocument();
  });
});
