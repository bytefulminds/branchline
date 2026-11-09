import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { toAriaShortcut } from "../../components/Button";
import { DRAFT, installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { RepositoryInfo } from "../../types/git";
import { commitBlocker, joinMessage, resetCommitDrafts, splitMessage } from "./CommitBox";

installTauriTestEnvironment();
beforeEach(resetCommitDrafts);

/** REPO has one staged rename (lib/b.rs). */
const CLEAN: RepositoryInfo = { ...REPO, changes: [], totalChanges: 0 };

async function openRepo(
  repo: RepositoryInfo,
  extra: (cmd: string, args: Record<string, unknown>) => unknown = () => undefined,
) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return repo.path;
    if (cmd === "inspect_repository") return repo;
    return extra(cmd, args);
  });
  render(<App />);
  await user.click(openButton());
  const form = await screen.findByRole("form", { name: "Commit" });
  return { user, calls, form };
}

describe("commit message helpers", () => {
  it("maps shortcut hints to aria-keyshortcuts", () => {
    expect(toAriaShortcut("Ctrl+↵")).toBe("Control+Enter");
    expect(toAriaShortcut("⌘↵")).toBe("Meta+Enter");
    expect(toAriaShortcut("Ctrl+Shift+↵")).toBe("Control+Shift+Enter");
    expect(toAriaShortcut("⌘⇧↵")).toBe("Meta+Shift+Enter");
    expect(toAriaShortcut("⌘O")).toBe("Meta+O");
  });

  it("splits and joins summary and description", () => {
    expect(splitMessage("Title\r\n\r\nBody\nmore")).toEqual({
      summary: "Title",
      description: "Body\nmore",
    });
    expect(joinMessage({ summary: " Title ", description: "\n Body \n" })).toBe("Title\n\nBody");
    expect(joinMessage({ summary: "Only", description: "  " })).toBe("Only");
  });

  it("explains why committing is blocked", () => {
    const msg = { summary: "x", description: "" };
    expect(commitBlocker(CLEAN, msg, false)).toBe("Stage changes to commit.");
    expect(commitBlocker(CLEAN, msg, true)).toBeNull();
    expect(commitBlocker(REPO, { summary: " ", description: "" }, false)).toBe("Enter a summary.");
    const conflicted = {
      ...REPO,
      changes: [{ ...REPO.changes[0]!, conflict: "bothModified" as const }],
    };
    expect(commitBlocker(conflicted, msg, false)).toBe("Resolve the conflict first.");
    expect(commitBlocker({ ...CLEAN, operation: "merge" }, msg, false)).toBeNull();
  });
});

describe("commit box", () => {
  it("commits staged changes with summary and description", async () => {
    const { user, calls, form } = await openRepo(REPO, (cmd) =>
      cmd === "create_commit" ? CLEAN : undefined,
    );
    const submit = within(form).getByRole("button", { name: /Commit 1 file/ });
    expect(submit).toBeDisabled();
    expect(within(form).getByText("Enter a summary.")).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Commit summary"), "Add parser");
    await user.type(within(form).getByLabelText("Commit description"), "Handles CRLF.");
    expect(within(form).getByText("As Dev <dev@example.com>")).toBeInTheDocument();
    await user.click(submit);

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_commit")?.args).toEqual({
        repo: REPO.path,
        request: { message: "Add parser\n\nHandles CRLF.", amend: false },
      }),
    );
    expect(await screen.findByText("Commit created")).toBeInTheDocument();
    expect(within(form).getByLabelText("Commit summary")).toHaveValue("");
  });

  it("submits with Ctrl+Enter", async () => {
    const { user, calls, form } = await openRepo(REPO, (cmd) =>
      cmd === "create_commit" ? CLEAN : undefined,
    );
    await user.type(
      within(form).getByLabelText("Commit summary"),
      "Quick fix{Control>}{Enter}{/Control}",
    );
    await waitFor(() => expect(calls.some((c) => c.cmd === "create_commit")).toBe(true));
  });

  it("commits and pushes, with the button or Ctrl+Shift+Enter", async () => {
    const pushed = {
      outcome: {
        updatedRefs: 1,
        conflicts: false,
        upToDate: false,
        stashKept: false,
        target: "origin/main",
      },
      repo: CLEAN,
    };
    const { user, calls, form } = await openRepo(REPO, (cmd) => {
      if (cmd === "create_commit") return CLEAN;
      if (cmd === "list_remotes")
        return [{ name: "origin", url: "https://example.com/demo.git", pushUrl: null }];
      if (cmd === "push_branch") return pushed;
    });
    const push = within(form).getByRole("button", { name: "Commit and push" });
    await user.type(within(form).getByLabelText("Commit summary"), "Add parser");
    await waitFor(() => expect(push).toBeEnabled());
    await user.click(push);
    await waitFor(() => expect(calls.some((c) => c.cmd === "push_branch")).toBe(true));
    const order = calls
      .map((c) => c.cmd)
      .filter((c) => c === "create_commit" || c === "push_branch");
    expect(order).toEqual(["create_commit", "push_branch"]);
    expect(calls.find((c) => c.cmd === "push_branch")?.args.request).toMatchObject({
      branch: "main",
      force: false,
    });
  });

  it("commits and pushes with Ctrl+Shift+Enter", async () => {
    const { user, calls, form } = await openRepo(REPO, (cmd) => {
      if (cmd === "create_commit") return CLEAN;
      if (cmd === "list_remotes")
        return [{ name: "origin", url: "https://example.com/demo.git", pushUrl: null }];
    });
    await waitFor(() => expect(calls.some((c) => c.cmd === "list_remotes")).toBe(true));
    await user.type(
      within(form).getByLabelText("Commit summary"),
      "Quick fix{Control>}{Shift>}{Enter}{/Shift}{/Control}",
    );
    await waitFor(() => expect(calls.some((c) => c.cmd === "push_branch")).toBe(true));
  });

  it("does not offer Commit and push while amending or without a remote", async () => {
    const { user, form } = await openRepo(REPO, (cmd) => (cmd === "list_remotes" ? [] : undefined));
    const push = within(form).getByRole("button", { name: "Commit and push" });
    await user.type(within(form).getByLabelText("Commit summary"), "Add parser");
    expect(push).toBeDisabled();
    expect(push).toHaveAttribute("title", "No remotes configured");
  });

  it("prefills the previous message when amending", async () => {
    const { user, calls, form } = await openRepo(CLEAN, (cmd) =>
      cmd === "create_commit" ? CLEAN : undefined,
    );
    expect(within(form).getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(within(form).getByText("Stage changes to commit.")).toBeInTheDocument();
    const amend = within(form).getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeEnabled());
    await user.click(amend);
    expect(within(form).getByLabelText("Commit summary")).toHaveValue("Initial commit");
    expect(within(form).getByLabelText("Commit description")).toHaveValue("With details.");
    await user.click(within(form).getByRole("button", { name: "Amend last commit" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_commit")?.args.request).toEqual({
        message: "Initial commit\n\nWith details.",
        amend: true,
      }),
    );
  });

  it("shows a missing identity clearly", async () => {
    const { user, form } = await openRepo(REPO, (cmd) => {
      if (cmd === "create_commit")
        throw {
          kind: "identityMissing",
          message: "Git does not know who you are.",
          detail: "*** Please tell me who you are.",
        };
    });
    await user.type(within(form).getByLabelText("Commit summary"), "x");
    await user.click(within(form).getByRole("button", { name: /Commit 1 file/ }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("Git does not know who you are.");
    expect(alert).toHaveTextContent('git config --global user.name "Your Name"');
  });

  it("prefills a prepared merge message", async () => {
    const merging: RepositoryInfo = { ...CLEAN, operation: "merge" };
    const { form } = await openRepo(merging, (cmd) =>
      cmd === "commit_draft" ? { ...DRAFT, preparedMessage: "Merge branch 'feature'" } : undefined,
    );
    await waitFor(() =>
      expect(within(form).getByLabelText("Commit summary")).toHaveValue("Merge branch 'feature'"),
    );
    expect(within(form).getByRole("button", { name: "Commit merge" })).toBeEnabled();
  });

  it("clears an untouched merge message when the merge is aborted, but keeps edits", async () => {
    const merging: RepositoryInfo = { ...CLEAN, operation: "merge" };
    let state: RepositoryInfo = merging;
    for (const edit of [false, true]) {
      resetCommitDrafts();
      state = merging;
      const { user, form } = await openRepo(merging, (cmd) => {
        if (cmd === "inspect_repository") return state;
        if (cmd === "commit_draft")
          return {
            ...DRAFT,
            preparedMessage: state.operation ? "Merge branch 'feature'" : null,
          };
        if (cmd === "operation_step") {
          state = CLEAN;
          return {
            outcome: { conflicts: false, upToDate: false, fastForward: false },
            repo: CLEAN,
          };
        }
      });
      const summary = within(form).getByLabelText("Commit summary");
      await waitFor(() => expect(summary).toHaveValue("Merge branch 'feature'"));
      if (edit) {
        await user.clear(summary);
        await user.type(summary, "My own words");
      }
      await user.click(screen.getByRole("button", { name: "Abort" }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Abort merge" }),
      );
      await waitFor(() => expect(screen.queryByText("Merge in progress.")).not.toBeInTheDocument());
      await waitFor(() => expect(summary).toHaveValue(edit ? "My own words" : ""));
      cleanup();
    }
  });
});

describe("commit message size", () => {
  it("resizes the description from the line above the summary and resets on Enter", async () => {
    const { user } = await openRepo(REPO);
    const handle = screen.getByRole("separator", { name: "Resize commit message" });
    const description = screen.getByRole("textbox", { name: "Commit description" });
    expect(handle).toHaveAttribute("aria-orientation", "horizontal");
    expect(description.style.height).toBe("64px");
    handle.focus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(description.style.height).toBe("96px");
    await user.keyboard("{ArrowDown}");
    expect(description.style.height).toBe("80px");
    await user.keyboard("{Enter}");
    expect(description.style.height).toBe("64px");
    await user.keyboard("{Home}");
    expect(description.style.height).toBe("40px");
  });
});
