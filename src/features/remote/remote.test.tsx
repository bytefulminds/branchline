import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type {
  RemoteInfo,
  RemoteOutcome,
  RemoteProgress,
  RemoteResult,
  RepositoryInfo,
} from "../../types/git";

installTauriTestEnvironment();

const ORIGIN: RemoteInfo = {
  name: "origin",
  url: "https://***@example.com/demo.git",
  pushUrl: null,
};
const UPSTREAM: RemoteInfo = {
  name: "upstream",
  url: "git@example.com:team/demo.git",
  pushUrl: null,
};

const outcome = (over: Partial<RemoteOutcome> = {}): RemoteOutcome => ({
  updatedRefs: 0,
  conflicts: false,
  upToDate: false,
  stashKept: false,
  target: null,
  ...over,
});
const result = (over: Partial<RemoteOutcome> = {}, repo = REPO): RemoteResult => ({
  outcome: outcome(over),
  repo,
});

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function open(
  extra: Extra = () => undefined,
  repo: RepositoryInfo = REPO,
  remotes = [ORIGIN],
) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return repo.path;
    if (cmd === "inspect_repository") return repo;
    if (cmd === "list_branches") return { local: [], remote: [] };
    if (cmd === "list_remotes") return remotes;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  const toolbar = screen.getByRole("group", { name: "Remote" });
  return { user, calls, toolbar };
}

/** A pending IPC answer the test resolves or rejects later. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ProgressChannel = { onmessage: (p: RemoteProgress) => void };

describe("remote toolbar", () => {
  it("shows ahead and behind counts and disables what is not possible", async () => {
    const { toolbar } = await open(undefined, REPO, []);
    expect(within(toolbar).getByRole("button", { name: "Pull (1 behind)" })).toBeEnabled();
    expect(within(toolbar).getByRole("button", { name: "Push (2 ahead)" })).toBeEnabled();
    // No remotes: nothing to fetch from.
    expect(within(toolbar).getByRole("button", { name: "Fetch" })).toBeDisabled();
  });

  it("disables pull and push on a detached HEAD", async () => {
    const detached: RepositoryInfo = {
      ...REPO,
      head: { kind: "detached", oid: "b".repeat(40) },
      upstream: null,
    };
    const { toolbar } = await open(undefined, detached);
    expect(within(toolbar).getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(within(toolbar).getByRole("button", { name: "Push" })).toBeDisabled();
    expect(within(toolbar).getByRole("button", { name: "Fetch" })).toBeEnabled();
  });

  it("streams fetch progress in the status bar and reports the result", async () => {
    const pending = deferred<RemoteResult>();
    let channel: ProgressChannel | null = null;
    const { user, calls, toolbar } = await open((cmd, args) => {
      if (cmd === "fetch_remote") {
        channel = args.onProgress as ProgressChannel;
        return pending.promise;
      }
    });
    await user.click(within(toolbar).getByRole("button", { name: "Fetch" }));
    expect(calls.find((c) => c.cmd === "fetch_remote")?.args.remote).toBeNull();

    const status = screen.getByRole("contentinfo");
    expect(within(status).getByText("Fetching")).toBeInTheDocument();
    channel!.onmessage({ phase: "Receiving objects", percent: 45, detail: "450/1000" });
    expect(await within(status).findByText("Receiving objects 45%")).toBeInTheDocument();
    expect(within(status).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "45");
    // Other remote operations wait for this one.
    expect(within(toolbar).getByRole("button", { name: "Pull (1 behind)" })).toBeDisabled();

    pending.resolve(result({ updatedRefs: 3, target: null }));
    expect(await screen.findByText("Fetched")).toBeInTheDocument();
    expect(screen.getByText("3 branches or tags updated.")).toBeInTheDocument();
    expect(within(status).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("cancels a running fetch", async () => {
    const pending = deferred<RemoteResult>();
    const { user, calls, toolbar } = await open((cmd) => {
      if (cmd === "fetch_remote") return pending.promise;
      if (cmd === "cancel_remote_operation") {
        pending.reject({
          kind: "cancelled",
          message: "The operation was cancelled.",
          detail: null,
        });
        return null;
      }
    });
    await user.click(within(toolbar).getByRole("button", { name: "Fetch" }));
    await user.click(
      within(screen.getByRole("contentinfo")).getByRole("button", { name: "Cancel" }),
    );

    const opId = calls.find((c) => c.cmd === "fetch_remote")?.args.opId;
    expect(calls.find((c) => c.cmd === "cancel_remote_operation")?.args.opId).toBe(opId);
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Fetch" })).toBeEnabled();
  });

  it("offers merge or rebase when a fast-forward pull is not possible", async () => {
    const { user, calls, toolbar } = await open((cmd, args) => {
      if (cmd === "pull_branch" && args.mode === "fastForward")
        return Promise.reject({
          kind: "diverged",
          message: "Your branch and its upstream have diverged.",
          detail: "fatal: Not possible to fast-forward, aborting.",
        });
      if (cmd === "pull_branch") return result({ target: "origin/main" });
    });
    await user.click(within(toolbar).getByRole("button", { name: "Pull (1 behind)" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Cannot fast-forward")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Pull with rebase" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "pull_branch").map((c) => c.args.mode)).toEqual([
        "fastForward",
        "rebase",
      ]),
    );
    expect(await screen.findByText("Pulled origin/main")).toBeInTheDocument();
  });

  it("chooses the pull mode from the menu and reports conflicts", async () => {
    const { user, calls, toolbar } = await open((cmd) => {
      if (cmd === "pull_branch")
        return result({ conflicts: true, target: "origin/main" }, { ...REPO, operation: "merge" });
    });
    await user.click(within(toolbar).getByRole("button", { name: "Pull options" }));
    await user.click(screen.getByRole("menuitem", { name: /Pull with merge/ }));
    expect(calls.find((c) => c.cmd === "pull_branch")?.args.mode).toBe("merge");
    expect(await screen.findByText("Pulled with conflicts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show changes" })).toBeInTheDocument();
  });

  it("offers a force push with lease after a rejected push, behind a confirmation", async () => {
    const { user, calls, toolbar } = await open((cmd, args) => {
      if (cmd === "push_branch" && !(args.request as { force: boolean }).force)
        return Promise.reject({
          kind: "pushRejected",
          message: "The remote has commits that you do not have. Pull first, then push again.",
          detail: "! [rejected] main -> main (fetch first)",
        });
      if (cmd === "push_branch") return result({ target: "origin/main" });
    });
    await user.click(within(toolbar).getByRole("button", { name: "Push (2 ahead)" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Push rejected")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Force push…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/force with lease/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Force push" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "push_branch").map((c) => c.args.request)).toEqual([
        { branch: "main", remote: null, setUpstream: false, force: false },
        { branch: "main", remote: null, setUpstream: false, force: true },
      ]),
    );
    expect(await screen.findByText("Force pushed main")).toBeInTheDocument();
  });

  it("publishes a branch without upstream to the chosen remote", async () => {
    const local: RepositoryInfo = { ...REPO, upstream: null };
    const { user, calls, toolbar } = await open(
      (cmd) => {
        if (cmd === "push_branch") return result({ target: "upstream/main" });
      },
      local,
      [ORIGIN, UPSTREAM],
    );
    await user.click(within(toolbar).getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish main" });
    expect(within(dialog).getByRole("radio", { name: /origin/ })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: /upstream/ }));
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "push_branch")?.args.request).toEqual({
        branch: "main",
        remote: "upstream",
        setUpstream: true,
        force: false,
      }),
    );
    expect(await screen.findByText("Published main")).toBeInTheDocument();
  });

  it("explains sign-in failures with Git's own message", async () => {
    const { user, toolbar } = await open((cmd) => {
      if (cmd === "fetch_remote")
        return Promise.reject({
          kind: "authFailed",
          message: "Git could not sign in to the remote. Check your credentials, token or SSH key.",
          detail: "git@example.com: Permission denied (publickey).",
        });
    });
    await user.click(within(toolbar).getByRole("button", { name: "Fetch" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Sign-in failed")).toBeInTheDocument();
    expect(within(alert).getByText(/Permission denied \(publickey\)/)).toBeInTheDocument();
  });
});
