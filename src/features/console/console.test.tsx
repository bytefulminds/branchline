import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import { formatCommand, type GitLogEntry } from "../../services/gitLog";
import { mergeEntries, visibleEntries } from "./GitConsole";

installTauriTestEnvironment();

const entry = (over: Partial<GitLogEntry>): GitLogEntry => ({
  id: 1,
  seq: 1,
  startedAt: Date.UTC(2026, 9, 26, 12, 0, 0),
  durationMs: 12,
  program: "git",
  cwd: REPO.path,
  args: ["status"],
  readOnly: true,
  exitCode: 0,
  ok: true,
  error: null,
  stdout: "",
  stdoutBytes: 0,
  stderr: "",
  stderrBytes: 0,
  stdinBytes: null,
  ...over,
});

const LOG: GitLogEntry[] = [
  entry({ id: 1, seq: 1, args: ["status", "--porcelain=v2"] }),
  entry({ id: 2, seq: 2, args: ["add", "--", "src/app.ts"], readOnly: false }),
  entry({
    id: 3,
    seq: 3,
    args: ["commit", "-F", "-"],
    readOnly: false,
    ok: false,
    exitCode: 1,
    stdinBytes: 14,
    stderr: "lint: 2 problems in app.py",
    stderrBytes: 26,
  }),
];

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function openApp(extra: Extra = () => undefined) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "git_command_log") return LOG.filter((e) => e.seq > (args.since as number));
    if (cmd === "clear_git_command_log") return null;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

describe("console helpers", () => {
  it("quotes commands like a shell and merges updates by id", () => {
    expect(formatCommand(["commit", "-m", "it's done"])).toBe(`git commit -m 'it'\\''s done'`);
    expect(formatCommand(["add", "--", "notes/new file.md", ""])).toBe(
      "git add -- 'notes/new file.md' ''",
    );
    expect(formatCommand(["GET", "/api/v4/user"], "GitLab")).toBe("GitLab GET /api/v4/user");
    const running = entry({ id: 5, ok: null, durationMs: null });
    const merged = mergeEntries([entry({ id: 4 }), running], [{ ...running, ok: true, seq: 9 }]);
    expect(merged.map((e) => [e.id, e.ok])).toEqual([
      [4, true],
      [5, true],
    ]);
  });

  it("hides routine reads but never failures", () => {
    const failedRead = entry({ id: 9, ok: false, args: ["rev-parse", "HEAD"] });
    const all = [...LOG, failedRead];
    const ids = (f: Parameters<typeof visibleEntries>[1]) =>
      visibleEntries(all, f).map((e) => e.id);
    expect(ids({ hideReads: true, failedOnly: false, text: "" })).toEqual([2, 3, 9]);
    expect(ids({ hideReads: false, failedOnly: false, text: "" })).toEqual([1, 2, 3, 9]);
    expect(ids({ hideReads: false, failedOnly: true, text: "" })).toEqual([3, 9]);
    expect(ids({ hideReads: false, failedOnly: false, text: "LINT" })).toEqual([3]);
  });
});

describe("Git console", () => {
  it("opens with Ctrl+J, hides routine reads and shows a failed hook's output", async () => {
    const { user, calls } = await openApp();
    await user.keyboard("{Control>}j{/Control}");
    const panel = await screen.findByRole("region", { name: "Git console" });
    const list = await within(panel).findByRole("list", { name: "Git commands" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(within(panel).getByText("2 commands · 1 hidden")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "git_command_log")?.args.since).toBe(0);

    const commit = within(list).getByRole("button", { name: /git commit -F -/ });
    expect(within(commit).getByLabelText("Failed")).toBeInTheDocument();
    await user.click(commit);
    expect(commit).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText("lint: 2 problems in app.py")).toBeInTheDocument();
    expect(within(panel).getByText("Exit code 1 (failed) · 12 ms")).toBeInTheDocument();
    expect(within(panel).getByText("14 B sent to Git (not shown)")).toBeInTheDocument();

    await user.click(within(panel).getByLabelText("Hide routine reads"));
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);

    await user.click(within(panel).getByRole("button", { name: "Clear the console" }));
    expect(calls.some((c) => c.cmd === "clear_git_command_log")).toBe(true);

    // The status bar button closes it again.
    await user.click(screen.getByRole("button", { name: "Git console" }));
    expect(screen.queryByRole("region", { name: "Git console" })).not.toBeInTheDocument();
  });

  it("opens on the failed command from a failed commit", async () => {
    const { user } = await openApp((cmd) => {
      if (cmd === "create_commit")
        return Promise.reject({
          kind: "commitFailed",
          message: "The commit was not created.",
          detail: "lint: 2 problems in app.py",
        });
    });
    await user.type(screen.getByLabelText("Commit summary"), "Add app");
    await user.click(screen.getByRole("button", { name: /^Commit \d+ file/ }));
    await user.click(await screen.findByRole("button", { name: "Show Git output" }));
    const panel = await screen.findByRole("region", { name: "Git console" });
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: /git commit -F -/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
  });
});
