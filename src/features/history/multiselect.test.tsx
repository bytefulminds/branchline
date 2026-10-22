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
import type { RepositoryInfo } from "../../types/git";
import { EMPTY_SELECTION, nextSelection, oldestFirst, single } from "./selection";

installTauriTestEnvironment();

const COMMITS = makeHistory(12);
// Commit 8 is a merge (a second parent outside the list).
COMMITS[8] = { ...COMMITS[8]!, parents: [COMMITS[9]!.oid, "f".repeat(40)] };
const HEAD = COMMITS[0]!.oid;
const REPO_AT_HEAD: RepositoryInfo = { ...REPO, head: { kind: "branch", name: "main", oid: HEAD } };
const oidOf = (i: number) => COMMITS[i]!.oid;

describe("commit selection", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("selects one, toggles one, or a range from the anchor", () => {
    let s = nextSelection(EMPTY_SELECTION, "b", "replace", order);
    expect([...s.oids]).toEqual(["b"]);
    s = nextSelection(s, "d", "range", order);
    expect([...s.oids]).toEqual(["b", "c", "d"]);
    expect(s.focus).toBe("d");
    // The range is redrawn from the same anchor.
    s = nextSelection(s, "a", "range", order);
    expect([...s.oids]).toEqual(["a", "b"]);
    s = nextSelection(s, "e", "toggle", order);
    expect([...s.oids].sort()).toEqual(["a", "b", "e"]);
    s = nextSelection(s, "e", "toggle", order);
    expect([...s.oids].sort()).toEqual(["a", "b"]);
    expect(s.focus).toBe("a");
    // The last selected commit cannot be toggled off.
    s = nextSelection(single("c"), "c", "toggle", order);
    expect([...s.oids]).toEqual(["c"]);
  });

  it("orders selected commits oldest first and drops ones no longer listed", () => {
    expect(oldestFirst(new Set(["d", "b", "zz"]), order)).toEqual(["d", "b"]);
  });
});

async function openHistory(extra: (cmd: string, args: Record<string, unknown>) => unknown) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO_AT_HEAD;
    if (cmd === "log_page") return { commits: COMMITS, hasMore: false, total: COMMITS.length };
    if (cmd === "list_refs") return [{ name: "main", kind: "branch", oid: HEAD }];
    if (cmd === "list_branches") return { local: [], remote: [] };
    if (cmd === "commit_details") return undefined;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  const row = (i: number) => within(list).getAllByRole("option")[i]!;
  return { user, calls, list, row };
}

describe("cherry-picking several commits", () => {
  it("selects with Ctrl+click and Shift+click, then picks them oldest first", async () => {
    const { user, calls, list, row } = await openHistory((cmd) => {
      if (cmd === "cherry_pick_many")
        return {
          outcome: { conflicts: false, upToDate: false, fastForward: false, skipped: 1 },
          repo: REPO_AT_HEAD,
        };
    });
    expect(list).toHaveAttribute("aria-multiselectable", "true");
    await user.click(row(2));
    await user.keyboard("{Shift>}");
    await user.click(row(4));
    await user.keyboard("{/Shift}{Control>}");
    await user.click(row(6));
    await user.keyboard("{/Control}");
    for (const i of [2, 3, 4, 6]) expect(row(i)).toHaveAttribute("aria-selected", "true");
    for (const i of [1, 5]) expect(row(i)).toHaveAttribute("aria-selected", "false");

    const panel = await screen.findByRole("region", { name: "4 commits selected" });
    const listed = within(panel)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".truncate")?.textContent);
    expect(listed).toEqual([
      "Commit number 6",
      "Commit number 4",
      "Commit number 3",
      "Commit number 2",
    ]);

    await user.click(
      within(panel).getByRole("button", { name: "Cherry-pick 4 commits onto main" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Cherry-pick 4 commits onto main?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cherry-pick 4 commits" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "cherry_pick_many")?.args.oids).toEqual([
        oidOf(6),
        oidOf(4),
        oidOf(3),
        oidOf(2),
      ]),
    );
    expect(await screen.findByText("Cherry-picked 3 commits onto main")).toBeInTheDocument();
    expect(screen.getByText("1 commit was already on main and skipped.")).toBeInTheDocument();
  });

  it("extends the selection with Shift+arrows and goes back to one with Escape", async () => {
    const { user, list, row } = await openHistory(() => undefined);
    await user.click(row(1));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(await screen.findByRole("region", { name: "3 commits selected" })).toBeInTheDocument();
    expect(list).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /commits selected/ })).not.toBeInTheDocument();
    expect(row(3)).toHaveAttribute("aria-selected", "true");
    expect(row(1)).toHaveAttribute("aria-selected", "false");
  });

  it("offers the selection in the context menu and refuses merge commits", async () => {
    const { user, row } = await openHistory(() => undefined);
    await user.click(row(7));
    await user.keyboard("{Control>}");
    await user.click(row(8));
    await user.keyboard("{/Control}");

    fireEvent.contextMenu(row(7), { clientX: 200, clientY: 200 });
    const menu = await screen.findByRole("menu", { name: "Actions for 2 commits" });
    const item = within(menu).getByRole("menuitem", { name: /Cherry-pick 2 commits onto main/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent("merge commit");
    await user.keyboard("{Escape}");

    const panel = screen.getByRole("region", { name: "2 commits selected" });
    expect(within(panel).getByRole("alert")).toHaveTextContent("merge commit");
    expect(
      within(panel).getByRole("button", { name: "Cherry-pick 2 commits onto main" }),
    ).toBeDisabled();

    // Right-clicking a commit outside the selection goes back to that one commit.
    fireEvent.contextMenu(row(2), { clientX: 200, clientY: 200 });
    expect(
      await screen.findByRole("menu", { name: `Actions for commit ${oidOf(2).slice(0, 7)}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /commits selected/ })).not.toBeInTheDocument();
  });
});
