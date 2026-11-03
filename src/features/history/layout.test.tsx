import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../App";
import {
  installTauriTestEnvironment,
  makeHistory,
  openButton,
  REPO,
  setup,
} from "../../test/harness";
import { GRAPH_MIN } from "./HistoryView";

installTauriTestEnvironment();
afterEach(() => window.localStorage.clear());

async function openHistory() {
  const commits = makeHistory(3).map((c, i) =>
    i === 0 ? { ...c, summary: "A very long description that a narrow window cuts off" } : c,
  );
  const user = userEvent.setup();
  setup((cmd) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "log_page") return { commits, hasMore: false, total: commits.length };
    if (cmd === "list_refs") return [];
    if (cmd === "commit_details") return undefined;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  return { user, list };
}

const main = () => document.querySelector(".bl-history__main") as HTMLElement;

describe("history layout", () => {
  it("shows a cut-off description in full on hover", async () => {
    const { list } = await openHistory();
    const row = within(list).getAllByRole("option")[0]!;
    expect(row.querySelector(".bl-commit-row__message")).toHaveAttribute(
      "title",
      "A very long description that a narrow window cuts off",
    );
  });

  it("resizes columns, hides them from the header menu and remembers it", async () => {
    const { user } = await openHistory();
    const author = screen.getByRole("separator", { name: "Resize the Author column" });
    expect(author).toHaveAttribute("aria-valuenow", "160");
    author.focus();
    // The handle is on the column's left edge: dragging left (or ←) widens it.
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(author).toHaveAttribute("aria-valuenow", "192");
    expect(main().style.getPropertyValue("--history-columns")).toContain("192px");

    fireEvent.contextMenu(document.querySelector(".bl-history__columns")!, {
      clientX: 400,
      clientY: 120,
    });
    const authorItem = await screen.findByRole("menuitemcheckbox", { name: "Author" });
    expect(authorItem).toHaveAttribute("aria-checked", "true");
    await user.click(authorItem);
    expect(main()).toHaveClass("bl-history--no-author");
    expect(screen.queryByRole("separator", { name: "Resize the Author column" })).toBeNull();
    expect(main().style.getPropertyValue("--history-columns")).not.toContain("192px");
    expect(JSON.parse(window.localStorage.getItem("branchline.history.hideAuthor")!)).toBe(true);

    fireEvent.contextMenu(document.querySelector(".bl-history__columns")!, {
      clientX: 400,
      clientY: 120,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Reset columns" }));
    expect(main()).not.toHaveClass("bl-history--no-author");
    expect(screen.getByRole("separator", { name: "Resize the Author column" })).toHaveAttribute(
      "aria-valuenow",
      "160",
    );
  });

  it("narrows the graph column down to its minimum, and fits it again", async () => {
    const commits = makeHistory(8).map((c, i) => ({
      ...c,
      // Eight branches side by side: eight lanes.
      parents: i < 7 ? [(100 + i).toString(16).padStart(40, "0")] : c.parents,
    }));
    const user = userEvent.setup();
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") return REPO;
      if (cmd === "log_page") return { commits, hasMore: false, total: commits.length };
      if (cmd === "list_refs") return [];
      if (cmd === "commit_details") return undefined;
    });
    render(<App />);
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    await user.keyboard("{Control>}2{/Control}");
    await screen.findByRole("listbox", { name: "Commits" });
    const graph = screen.getByRole("separator", { name: "Resize the Graph column" });
    const fit = Number(graph.getAttribute("aria-valuemax"));
    expect(Number(graph.getAttribute("aria-valuenow"))).toBe(fit);
    expect(main()).not.toHaveClass("bl-history--graph-clipped");

    graph.focus();
    await user.keyboard("{Home}");
    expect(graph).toHaveAttribute("aria-valuenow", String(GRAPH_MIN));
    expect(main().style.getPropertyValue("--graph-width")).toBe(`${GRAPH_MIN}px`);
    expect(main()).toHaveClass("bl-history--graph-clipped");

    await user.keyboard("{Enter}");
    expect(Number(graph.getAttribute("aria-valuenow"))).toBe(fit);
    expect(main()).not.toHaveClass("bl-history--graph-clipped");
  });

  it("hides and shows the commit details panel", async () => {
    const { user } = await openHistory();
    await waitFor(() => expect(document.querySelector(".bl-history__details")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Hide commit details" }));
    expect(document.querySelector(".bl-history__details")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize commit details" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show commit details" }));
    expect(document.querySelector(".bl-history__details")).not.toBeNull();
  });

  it("collapses the sidebar to icons, with a button and Ctrl+B", async () => {
    const { user } = await openHistory();
    const sidebar = () => document.querySelector(".bl-sidebar") as HTMLElement;
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar()).toHaveClass("bl-sidebar--collapsed");
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
    // The views stay reachable by name, with their name on hover.
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
      "title",
      expect.stringContaining("History"),
    );
    await user.keyboard("{Control>}b{/Control}");
    expect(sidebar()).not.toHaveClass("bl-sidebar--collapsed");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });
});
