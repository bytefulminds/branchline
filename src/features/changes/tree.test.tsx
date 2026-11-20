import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { FileChange, RepositoryInfo } from "../../types/git";

installTauriTestEnvironment();

const change = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  originalPath: null,
  indexStatus: null,
  worktreeStatus: "modified",
  conflict: null,
  isSubmodule: false,
  ...over,
});

const TREE_REPO: RepositoryInfo = {
  ...REPO,
  changes: [
    change("src/app.ts"),
    change("src/util/format.ts"),
    change("README.md"),
    change("build/out.js", { worktreeStatus: "untracked" }),
    change("build/out.map", { worktreeStatus: "untracked" }),
  ],
  totalChanges: 5,
};

async function open() {
  const user = userEvent.setup();
  const calls = setup((cmd) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return TREE_REPO;
    if (cmd === "stage_files" || cmd === "discard_files") return TREE_REPO;
    return undefined;
  });
  render(<App />);
  await user.click(openButton());
  const list = await screen.findByRole("listbox", { name: "Changed files" });
  return { user, calls, list };
}

const folderRow = (list: HTMLElement, name: string) =>
  [...list.querySelectorAll<HTMLElement>(".bl-folder-row")].find(
    (r) => r.querySelector(".bl-file-row__name")?.textContent === name,
  )!;

describe("changed files as a tree", () => {
  it("shows folders with their file counts, and files under them", async () => {
    const { list } = await open();
    expect(folderRow(list, "src")).toHaveTextContent("2");
    expect(folderRow(list, "util")).toHaveTextContent("1");
    // The folder is shown by the tree, not repeated after each file name.
    const app = within(list).getByRole("option", { name: /app\.ts/ });
    expect(app.querySelector(".bl-file-row__dir")).toBeNull();
    // The sidebar counts the changes and, apart, the untracked files.
    const nav = screen.getByRole("button", { name: /^Changes/ });
    expect(nav).toHaveTextContent("3");
    expect(nav).toHaveTextContent("+2 untracked files");
  });

  it("stages every file in a folder from its row", async () => {
    const { user, calls, list } = await open();
    await user.click(
      folderRow(list, "src").querySelector<HTMLElement>('[data-tooltip="Stage folder"]')!,
    );
    expect(calls.find((c) => c.cmd === "stage_files")?.args.paths).toEqual([
      "src/util/format.ts",
      "src/app.ts",
    ]);
  });

  it("stages the selected file's folder with Shift+Space", async () => {
    const { user, calls, list } = await open();
    await user.click(within(list).getByRole("option", { name: /format\.ts/ }));
    act(() => list.focus());
    await user.keyboard("{Shift>} {/Shift}");
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "stage_files")?.args.paths).toEqual([
        "src/util/format.ts",
      ]),
    );
  });

  it("deletes the untracked files of a folder after asking", async () => {
    const { user, calls, list } = await open();
    await user.click(within(list).getByText("Untracked files"));
    await user.click(
      folderRow(list, "build").querySelector<HTMLElement>('[data-tooltip="Delete these files"]')!,
    );
    const dialog = await screen.findByRole("alertdialog", { name: "Delete 2 untracked files?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete files" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "discard_files")?.args.paths).toEqual([
        "build/out.js",
        "build/out.map",
      ]),
    );
  });

  it("closes a folder, and switches back to a flat list", async () => {
    const { user, list } = await open();
    await user.click(folderRow(list, "src"));
    expect(within(list).queryByRole("option", { name: /app\.ts/ })).not.toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /README\.md/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show as a list" }));
    expect(list.querySelector(".bl-folder-row")).toBeNull();
    const app = within(list).getByRole("option", { name: /app\.ts/ });
    expect(app.querySelector(".bl-file-row__dir")).toHaveTextContent("src");
    expect(screen.getByRole("button", { name: "Show as a tree of folders" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
