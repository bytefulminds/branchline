import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import {
  diffFor,
  installTauriTestEnvironment,
  makeHistory,
  openButton,
  REPO,
  setup,
} from "../../test/harness";
import type { DiffArea, LogFilter, RepositoryInfo } from "../../types/git";
import { resetHistoryFilters } from "./HistoryView";

installTauriTestEnvironment();
beforeEach(resetHistoryFilters);

const COMMITS = makeHistory(40);
const REPO_AT_HEAD: RepositoryInfo = {
  ...REPO,
  head: { kind: "branch", name: "main", oid: COMMITS[0]!.oid },
};

async function openHistory(view = "2") {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO_AT_HEAD;
    if (cmd === "list_refs") return [];
    if (cmd === "file_diff") return diffFor(args as { path: string; area: DiffArea });
    if (cmd === "commit_details")
      return {
        oid: args.oid,
        parents: [],
        authorName: "A",
        authorEmail: "a@example.com",
        authorDate: "2023-11-14T22:13:20+00:00",
        committerName: "A",
        committerEmail: "a@example.com",
        committerDate: "2023-11-14T22:13:20+00:00",
        message: "x",
        files: [],
      };
    if (cmd === "log_page") {
      const filter = args.filter as LogFilter | null;
      if (filter?.path === "../bad")
        throw { kind: "invalidPath", message: "Invalid file path: ../bad" };
      const text = filter?.text.toLowerCase() ?? "";
      const commits = COMMITS.filter((c) => c.summary.toLowerCase().includes(text));
      return { commits, hasMore: false, total: commits.length };
    }
    return undefined;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  if (view === "1") return { user, calls, list: null };
  await user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  return { user, calls, list };
}

const filterCalls = (calls: { cmd: string; args: Record<string, unknown> }[]) =>
  calls.filter((c) => c.cmd === "log_page" && c.args.filter).map((c) => c.args.filter as LogFilter);

describe("history search", () => {
  it("searches after typing pauses, marks matches and clears with Escape", async () => {
    const { user, calls } = await openHistory();
    expect(screen.getByText("40 commits")).toBeInTheDocument();
    const box = screen.getByRole("searchbox", { name: "Search commits" });
    await user.keyboard("{Control>}f{/Control}");
    expect(box).toHaveFocus();
    await user.type(box, "number 1");
    // One search for the whole word, not one per letter.
    expect(await screen.findByText("11 matching commits")).toBeInTheDocument();
    expect(filterCalls(calls)).toHaveLength(1);
    expect(filterCalls(calls)[0]).toMatchObject({ text: "number 1", author: "" });
    const list = screen.getByRole("listbox", { name: "Commits" });
    const first = within(list).getAllByRole("option")[0]!;
    expect(first.querySelector("mark")).toHaveTextContent("number 1");
    // Results have no graph lines: neighbours are not parent and child.
    expect(first.querySelector("svg.bl-graph line, svg.bl-graph path")).toBeNull();

    await user.keyboard("{Escape}");
    expect(await screen.findByText("40 commits")).toBeInTheDocument();
  });

  it("filters by author, path, dates and branch, and explains bad input", async () => {
    const { user, calls } = await openHistory();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const bar = screen.getByRole("group", { name: "Filters" });
    await user.type(within(bar).getByLabelText("Author"), "grace");
    await user.click(within(bar).getByLabelText("Current branch only"));
    await waitFor(() =>
      expect(filterCalls(calls).at(-1)).toMatchObject({ author: "grace", currentBranch: true }),
    );
    expect(screen.getByRole("button", { name: "Filters (2)" })).toBeInTheDocument();

    await user.type(within(bar).getByLabelText("File or folder"), "../bad");
    expect(await within(bar).findByRole("alert")).toHaveTextContent("Invalid file path");

    await user.click(within(bar).getByRole("button", { name: "Clear all" }));
    expect(await screen.findByText("40 commits")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("offers to clear when nothing matches and keeps the search across views", async () => {
    const { user } = await openHistory();
    await user.type(screen.getByRole("searchbox", { name: "Search commits" }), "zebra");
    expect(await screen.findByText("No matching commits")).toBeInTheDocument();
    await user.keyboard("{Control>}1{/Control}");
    await user.keyboard("{Control>}2{/Control}");
    expect(screen.getByRole("searchbox", { name: "Search commits" })).toHaveValue("zebra");
    await user.click(await screen.findByRole("button", { name: "Clear search and filters" }));
    expect(await screen.findByText("40 commits")).toBeInTheDocument();
  });

  it("opens a file's history from its diff", async () => {
    const { user, calls } = await openHistory("1");
    await user.click(await screen.findByText("app.ts"));
    await user.click(await screen.findByRole("button", { name: "Show file history" }));
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByLabelText("File or folder")).toHaveValue("src/app.ts");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
    await waitFor(() => expect(filterCalls(calls).at(-1)).toMatchObject({ path: "src/app.ts" }));
  });
});
