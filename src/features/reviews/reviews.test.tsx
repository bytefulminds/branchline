import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { Account, MergeRequest, ReviewList } from "../../types/forge";
import { displayTitle } from "./ReviewsView";

installTauriTestEnvironment();

const ACCOUNT: Account = {
  kind: "gitlab",
  url: "https://gitlab.com",
  host: "gitlab.com",
  username: "ada",
  name: "Ada Lovelace",
  access: "write",
};

const MR = (iid: number, extra: Partial<MergeRequest> = {}): MergeRequest => ({
  projectId: 11,
  projectPath: "acme/demo",
  iid,
  title: `Change ${iid}`,
  webUrl: `https://gitlab.com/acme/demo/-/merge_requests/${iid}`,
  author: { name: "Tom Jansen", username: "tom" },
  sourceBranch: "feature/x",
  targetBranch: "main",
  draft: false,
  createdAt: "2026-10-30T09:00:00Z",
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  comments: 0,
  pipeline: null,
  approvedByYou: false,
  hasConflicts: false,
  ...extra,
});

const LIST = (all: boolean): ReviewList => ({
  account: ACCOUNT,
  project: all ? null : "acme/demo",
  items: all
    ? [MR(1, { pipeline: "failed", comments: 3 }), MR(9, { projectPath: "other/lib" })]
    : [MR(1, { pipeline: "failed", comments: 3 }), MR(2, { draft: true, approvedByYou: true })],
  truncated: false,
});

async function start(
  connected: boolean,
  extra: (cmd: string, args: Record<string, unknown>) => unknown = () => undefined,
) {
  const user = userEvent.setup();
  const state = { accounts: connected ? [ACCOUNT] : [] };
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "forge_accounts") return state.accounts;
    if (cmd === "review_source")
      return {
        remote: "origin",
        host: "gitlab.com",
        project: "acme/demo",
        account: state.accounts[0] ?? null,
      };
    if (cmd === "review_requests") return LIST(args.allProjects as boolean);
    if (cmd === "connect_gitlab") {
      state.accounts = [ACCOUNT];
      return ACCOUNT;
    }
    if (cmd === "disconnect_account") {
      state.accounts = [];
      return null;
    }
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

describe("merge request titles", () => {
  it("leaves out GitLab's draft prefix when the Draft badge shows", () => {
    expect(displayTitle({ title: "Draft: switch to v2", draft: true })).toBe("Switch to v2");
    expect(displayTitle({ title: "[Draft] Add cache", draft: true })).toBe("Add cache");
    expect(displayTitle({ title: "WIP: tidy", draft: true })).toBe("Tidy");
    expect(displayTitle({ title: "Draft: switch to v2", draft: false })).toBe(
      "Draft: switch to v2",
    );
    expect(displayTitle({ title: "Draft:", draft: true })).toBe("Draft:");
  });
});

describe("reviews", () => {
  it("is not offered until a GitLab account is connected", async () => {
    const { user, calls } = await start(false);
    await waitFor(() => expect(calls.some((c) => c.cmd === "review_source")).toBe(true));
    expect(screen.queryByRole("button", { name: /^Reviews/ })).toBeNull();
    await user.keyboard("{Control>}7{/Control}");
    expect(screen.getByRole("heading", { name: "Changes", level: 1 })).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "review_requests")).toBe(false);
  });

  it("connects an account in Settings and then shows the merge requests", async () => {
    const { user, calls } = await start(false);
    await user.keyboard("{Control>},{/Control}");
    await user.click(await screen.findByRole("button", { name: "Accounts" }));
    const token = await screen.findByLabelText("Personal access token");
    expect(screen.getByLabelText("GitLab address")).toHaveValue("https://gitlab.com");
    expect(token).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: /Create a token on GitLab/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "open_gitlab_token_page")?.args.url).toBe(
        "https://gitlab.com",
      ),
    );
    await user.type(token, "glpat-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "connect_gitlab")?.args).toEqual({
        url: "https://gitlab.com",
        token: "glpat-secret",
      }),
    );
    expect(await screen.findByText(/Connected as Ada Lovelace/)).toBeInTheDocument();
    expect(token).toHaveValue("");
    const list = await screen.findByRole("list", { name: "Connected accounts" });
    expect(list).toHaveTextContent("Can read merge requests, comment and approve");
    await user.keyboard("{Escape}");

    const nav = await screen.findByRole("button", { name: /^Reviews/ });
    await waitFor(() => expect(nav).toHaveTextContent("2"));
    await user.click(nav);
    expect(await screen.findByRole("heading", { name: "Reviews", level: 1 })).toBeInTheDocument();
  });

  it("lists merge requests with their state, for the project or all projects", async () => {
    const { user, calls } = await start(true);
    await user.click(await screen.findByRole("button", { name: /^Reviews/ }));
    const list = await screen.findByRole("list", { name: "Merge requests to review" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Change 1");
    expect(rows[0]).toHaveTextContent("!1");
    expect(rows[0]).toHaveTextContent("Tom Jansen");
    expect(rows[0]).toHaveTextContent("feature/x → main");
    expect(within(rows[0]!).getByText("Pipeline failed")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Comments: 3");
    expect(rows[1]).toHaveTextContent("Draft");
    expect(rows[1]).toHaveTextContent("Approved by you");
    expect(screen.getByText("2 merge requests waiting for you")).toBeInTheDocument();

    await user.click(within(rows[0]!).getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "open_forge_page")?.args.url).toBe(MR(1).webUrl),
    );

    await user.selectOptions(screen.getByLabelText("Show merge requests from"), "all");
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "review_requests").at(-1)?.args.allProjects).toBe(true),
    );
    expect(await screen.findByText("other/lib!9")).toBeInTheDocument();
  });

  it("explains errors and shows when nothing waits", async () => {
    let fail = true;
    const { user } = await start(true, (cmd) => {
      if (cmd === "review_requests") {
        if (fail) {
          fail = false;
          throw { kind: "forge", message: "GitLab did not accept the token.", detail: null };
        }
        return { ...LIST(false), items: [] };
      }
    });
    await user.click(await screen.findByRole("button", { name: /^Reviews/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitLab did not accept the token.");
    await user.click(screen.getByRole("button", { name: "Refresh reviews" }));
    expect(await screen.findByRole("heading", { name: "Nothing to review" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disconnects an account after confirmation", async () => {
    const { user, calls } = await start(true);
    await screen.findByRole("button", { name: /^Reviews/ });
    await user.keyboard("{Control>},{/Control}");
    await user.click(await screen.findByRole("button", { name: "Accounts" }));
    const list = await screen.findByRole("list", { name: "Connected accounts" });
    await user.click(within(list).getByRole("button", { name: "Disconnect" }));
    const ask = await screen.findByRole("alertdialog", { name: "Disconnect gitlab.com?" });
    expect(ask).toHaveTextContent("stays valid on GitLab until you revoke it");
    await user.click(within(ask).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "disconnect_account")?.args.url).toBe(ACCOUNT.url),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Reviews/ })).toBeNull());
  });
});
