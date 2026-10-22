import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { diffFor, openButton, REPO, setup, installTauriTestEnvironment } from "../../test/harness";
import type { RepositoryInfo } from "../../types/git";

/** The mouse-only icon on a file row (hidden from assistive tech; the keyboard uses Space). */
function rowAction(list: HTMLElement, path: string, tooltip: string): HTMLElement {
  const row = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    (o.getAttribute("title") ?? "").endsWith(path),
  )!;
  return row.querySelector<HTMLElement>(`[data-tooltip="${tooltip}"]`)!;
}

installTauriTestEnvironment();

/** REPO after staging src/app.ts. */
const STAGED: RepositoryInfo = {
  ...REPO,
  inspectedAt: REPO.inspectedAt + 1,
  changes: REPO.changes.map((c) =>
    c.path === "src/app.ts" ? { ...c, indexStatus: "modified", worktreeStatus: null } : c,
  ),
};

async function openRepo(handler: Parameters<typeof setup>[0] = () => undefined) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    return handler(cmd, args);
  });
  render(<App />);
  await user.click(openButton());
  const list = await screen.findByRole("listbox", { name: "Changed files" });
  return { user, calls, list };
}

const option = (list: HTMLElement, name: string) =>
  within(list)
    .getAllByRole("option")
    .find((o) => o.textContent?.includes(name))!;

describe("staging", () => {
  it("stages a file from its row action and shows the returned state", async () => {
    const { user, calls, list } = await openRepo((cmd) =>
      cmd === "stage_files" ? STAGED : undefined,
    );
    await user.click(rowAction(list, "src/app.ts", "Stage"));
    expect(calls.find((c) => c.cmd === "stage_files")?.args).toEqual({
      repo: REPO.path,
      paths: ["src/app.ts"],
    });
    await screen.findByText("1 unstaged · 2 staged");
  });

  it("stages and unstages the selected file with Space", async () => {
    const { user, calls, list } = await openRepo((cmd) => {
      if (cmd === "stage_files") return STAGED;
      if (cmd === "unstage_files") return REPO;
    });
    act(() => list.focus());
    await user.keyboard("{ArrowDown}");
    expect(option(list, "app.ts")).toHaveAttribute("aria-selected", "true");
    await user.keyboard(" ");
    await screen.findByText("1 unstaged · 2 staged");
    // The selection moved to the next unstaged file.
    expect(option(list, "new file.md")).toHaveAttribute("aria-selected", "true");
    expect(calls.filter((c) => c.cmd === "stage_files")).toHaveLength(1);
  });

  it("unstages both paths of a rename", async () => {
    const { user, calls, list } = await openRepo((cmd) =>
      cmd === "unstage_files" ? REPO : undefined,
    );
    await user.click(rowAction(list, "lib/b.rs", "Unstage"));
    expect(calls.find((c) => c.cmd === "unstage_files")?.args).toEqual({
      repo: REPO.path,
      paths: ["lib/a.rs", "lib/b.rs"],
    });
  });

  it("asks before discarding and does nothing when cancelled", async () => {
    const { user, calls, list } = await openRepo((cmd) =>
      cmd === "discard_files" ? REPO : undefined,
    );
    await user.click(rowAction(list, "src/app.ts", "Discard changes"));
    const dialog = await screen.findByRole("alertdialog", { name: "Discard changes to app.ts?" });
    // Cancel has focus for destructive dialogs.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "discard_files")).toBe(false);

    await user.click(rowAction(list, "src/app.ts", "Discard changes"));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(calls.some((c) => c.cmd === "discard_files")).toBe(true));
  });

  it("deleting an untracked file says so", async () => {
    const { user, list } = await openRepo();
    act(() => list.focus());
    await user.keyboard("{ArrowDown}{ArrowDown}{Delete}");
    expect(
      await screen.findByRole("alertdialog", { name: "Delete new file.md?" }),
    ).toHaveTextContent("deleted from disk");
  });

  it("stages selected lines with the diff fingerprint", async () => {
    const { user, calls, list } = await openRepo((cmd) =>
      cmd === "apply_lines" ? STAGED : undefined,
    );
    await user.click(option(list, "app.ts"));
    const diff = await screen.findByRole("region", { name: "Changes in src/app.ts" });
    const rows = await within(diff).findAllByText(/^(old|new)$/);
    // Click the first line, then shift-click the second to select the range.
    await user.click(rows[0]!);
    await user.keyboard("{Shift>}");
    await user.click(rows[1]!);
    await user.keyboard("{/Shift}");
    expect(within(diff).getByRole("status")).toHaveTextContent("2 lines selected");

    await user.click(within(diff).getByRole("button", { name: "Stage lines" }));
    expect(calls.find((c) => c.cmd === "apply_lines")?.args).toEqual({
      repo: REPO.path,
      request: {
        path: "src/app.ts",
        action: "stage",
        fingerprint: "fp-src/app.ts",
        selections: [{ hunk: 0, lines: [1, 2] }],
      },
    });
  });

  it("stages a whole hunk", async () => {
    const { user, calls, list } = await openRepo((cmd) =>
      cmd === "apply_lines" ? STAGED : undefined,
    );
    await user.click(option(list, "app.ts"));
    const diff = await screen.findByRole("region", { name: "Changes in src/app.ts" });
    await user.click(await within(diff).findByRole("button", { name: "Stage hunk" }));
    const req = calls.find((c) => c.cmd === "apply_lines")?.args.request as {
      selections: unknown;
    };
    expect(req.selections).toEqual([{ hunk: 0, lines: null }]);
  });

  it("explains a stale selection instead of failing silently", async () => {
    const { user, list } = await openRepo((cmd) => {
      if (cmd === "apply_lines")
        throw { kind: "stale", message: "The file changed since it was displayed.", detail: null };
    });
    await user.click(option(list, "app.ts"));
    const diff = await screen.findByRole("region", { name: "Changes in src/app.ts" });
    await user.click(await within(diff).findByRole("button", { name: "Stage hunk" }));
    expect(await screen.findByText("The file changed")).toBeInTheDocument();
  });

  it("refreshes when the watcher reports a change", async () => {
    const { calls } = await openRepo();
    await waitFor(() => expect(calls.some((c) => c.cmd === "watch_repository")).toBe(true));
    const before = calls.filter((c) => c.cmd === "inspect_repository").length;
    await act(() => emit("repository-changed", { repo: REPO.path }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "inspect_repository").length).toBe(before + 1),
    );
    // Events for other repositories are ignored.
    await act(() => emit("repository-changed", { repo: "/somewhere/else" }));
    expect(calls.filter((c) => c.cmd === "inspect_repository").length).toBe(before + 1);
  });

  it("renders large lists virtually", async () => {
    const many: RepositoryInfo = {
      ...REPO,
      changes: Array.from({ length: 5000 }, (_, i) => ({
        path: `gen/file_${i}.txt`,
        originalPath: null,
        indexStatus: null,
        worktreeStatus: "untracked" as const,
        conflict: null,
        isSubmodule: false,
      })),
      totalChanges: 5000,
    };
    const user = userEvent.setup();
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") return many;
    });
    render(<App />);
    await user.click(openButton());
    const list = await screen.findByRole("listbox", { name: "Changed files" });
    const rendered = within(list).getAllByRole("option");
    expect(rendered.length).toBeLessThan(100);
    expect(rendered[0]).toHaveAttribute("aria-setsize", "5000");
  });

  it("uses the diff fixture for every area", () => {
    expect(diffFor({ path: "x", area: "untracked" }).supportsPartial).toBe(false);
  });
});
