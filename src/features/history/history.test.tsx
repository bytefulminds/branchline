import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import type { CommitDetails, RepositoryInfo } from "../../types/git";

installTauriTestEnvironment();

const COMMITS = makeHistory(300);
const HEAD = COMMITS[0]!.oid;
const REPO_AT_HEAD: RepositoryInfo = { ...REPO, head: { kind: "branch", name: "main", oid: HEAD } };

const DETAILS: CommitDetails = {
  oid: HEAD,
  parents: [COMMITS[1]!.oid],
  authorName: "Grace Hopper",
  authorEmail: "grace@example.com",
  authorDate: "2023-11-14T22:13:20+00:00",
  committerName: "Grace Hopper",
  committerEmail: "grace@example.com",
  committerDate: "2023-11-14T22:13:20+00:00",
  message: "Commit number 0\n\nA longer explanation.",
  files: [
    {
      path: "src/app.ts",
      originalPath: null,
      status: "M",
      additions: 3,
      deletions: 1,
      binary: false,
    },
    {
      path: "img.png",
      originalPath: null,
      status: "A",
      additions: null,
      deletions: null,
      binary: true,
    },
  ],
};

async function openHistory(
  extra: (cmd: string, args: Record<string, unknown>) => unknown = () => undefined,
) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO_AT_HEAD;
    if (cmd === "log_page") {
      const skip = args.skip as number;
      return {
        commits: skip === 0 ? COMMITS : makeHistory(50, 300),
        hasMore: skip === 0,
        total: 350,
      };
    }
    if (cmd === "list_refs")
      return [
        { name: "main", kind: "branch", oid: HEAD },
        { name: "origin/main", kind: "remote", oid: COMMITS[2]!.oid },
        { name: "v1.0", kind: "tag", oid: COMMITS[2]!.oid },
      ];
    if (cmd === "commit_details") return { ...DETAILS, oid: args.oid as string };
    return extra(cmd, args);
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  return { user, calls, list };
}

describe("history", () => {
  it("shows commits with refs, authors and the total count", async () => {
    const { list } = await openHistory();
    expect(screen.getByText("350 commits")).toBeInTheDocument();
    const first = within(list).getAllByRole("option")[0]!;
    expect(first).toHaveTextContent("Commit number 0");
    expect(within(first).getByTitle("Current branch main")).toBeInTheDocument();
    expect(within(list).getByTitle("Remote branch origin/main")).toBeInTheDocument();
    expect(within(list).getByTitle("Tag v1.0")).toBeInTheDocument();
    expect(first.querySelector("svg.bl-graph")).not.toBeNull();
    // Virtualized: far fewer rows than commits.
    expect(within(list).getAllByRole("option").length).toBeLessThan(120);
  });

  it("loads the next page as the end comes into view", async () => {
    const { calls, list } = await openHistory();
    // With few commits rendered, the list asks for more as it nears the end.
    act(() => list.focus());
    await userEvent.keyboard("{End}");
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "log_page" && c.args.skip === 300)).toBe(true),
    );
  });

  it("shows details of the selected commit and opens a file diff", async () => {
    const { user, calls, list } = await openHistory((cmd, args) => {
      if (cmd === "commit_file_diff")
        return {
          path: args.path,
          originalPath: null,
          area: "commit",
          hunks: [
            {
              header: "",
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              section: "",
              lines: [
                {
                  kind: "delete",
                  content: "before",
                  oldLine: 1,
                  newLine: null,
                  noNewline: false,
                  crlf: false,
                },
                {
                  kind: "add",
                  content: "after",
                  oldLine: null,
                  newLine: 1,
                  noNewline: false,
                  crlf: false,
                },
              ],
            },
          ],
          isBinary: false,
          tooLarge: false,
          sizeBytes: 10,
          additions: 1,
          deletions: 1,
          oldMode: null,
          newMode: null,
          change: null,
          supportsPartial: false,
          hasConflictMarkers: false,
          fingerprint: "x",
        };
    });
    const details = await screen.findByRole("region", { name: "Commit details" });
    expect(await within(details).findByText("A longer explanation.")).toBeInTheDocument();
    expect(within(details).getByText("2 files changed")).toBeInTheDocument();

    // Keyboard selection loads another commit.
    act(() => list.focus());
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "commit_details").map((c) => c.args.oid)).toContain(
        COMMITS[1]!.oid,
      ),
    );

    const files = await screen.findByRole("list", { name: "Changed files" });
    await user.click(within(files).getByText("app.ts"));
    const diff = await screen.findByRole("region", { name: /Changes in src\/app.ts at/ });
    expect(await within(diff).findByText("after")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "commit_file_diff")?.args).toMatchObject({
      oid: COMMITS[1]!.oid,
      path: "src/app.ts",
    });
    await user.click(within(diff).getByRole("button", { name: "History" }));
    expect(await screen.findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
  });

  it("links uncommitted work back to the Changes view", async () => {
    const { user } = await openHistory();
    await user.click(screen.getByRole("button", { name: /Uncommitted changes/ }));
    expect(await screen.findByRole("heading", { name: "Changes" })).toBeInTheDocument();
  });

  it("shows an empty state for a repository without commits", async () => {
    const user = userEvent.setup();
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") return { ...REPO, head: { kind: "unborn", name: "main" } };
      if (cmd === "log_page") return { commits: [], hasMore: false, total: 0 };
      if (cmd === "list_refs") return [];
    });
    render(<App />);
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByRole("heading", { name: "No commits yet" })).toBeInTheDocument();
  });
});
