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
import type { BranchInfo, PlanCommit, RefInfo } from "../../types/git";
import { DEFAULT_SETTINGS } from "../../types/settings";
import { applySuggestion, combineTargets, type Row } from "./InteractiveRebaseDialog";
import { REF_MIME } from "./refDrag";

installTauriTestEnvironment();

const oid = (n: number) => n.toString(16).padStart(40, "0");
// Oldest first, as the backend returns them.
const PLAN: PlanCommit[] = [1, 2, 3].map((n) => ({
  oid: oid(100 + n),
  summary: `Commit ${n}`,
  message: `Commit ${n}\n\nBody ${n}`,
  authorName: "Ada",
  authorTime: 1_700_000_000 + n,
}));

const branch = (over: Partial<BranchInfo>): BranchInfo => ({
  name: "x",
  remote: null,
  oid: "a".repeat(40),
  isCurrent: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  tipTime: 1_700_000_000,
  tipSummary: "Tip",
  ...over,
});
const BRANCHES = {
  local: [
    branch({ name: "main", isCurrent: true }),
    branch({ name: "feature/login", oid: "f".repeat(40) }),
    branch({ name: "feature/other", oid: "e".repeat(40) }),
  ],
  remote: [branch({ name: "origin/main", remote: "origin" })],
};
const ok = { outcome: { conflicts: false, upToDate: false, fastForward: false }, repo: REPO };

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function open(extra: Extra = () => undefined) {
  const commits = makeHistory(4);
  const refs: RefInfo[] = [
    { name: "main", kind: "branch", oid: commits[0]!.oid },
    { name: "feature/login", kind: "branch", oid: commits[2]!.oid },
  ];
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "list_branches") return BRANCHES;
    if (cmd === "log_page") return { commits, hasMore: false, total: commits.length };
    if (cmd === "list_refs") return refs;
    if (cmd === "commit_details") return undefined;
    if (cmd === "rebase_plan_commits") return PLAN;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls, commits };
}

async function openPlan(extra?: Extra) {
  const opened = await open(extra);
  await opened.user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  fireEvent.contextMenu(within(list).getAllByRole("option")[3]!, { clientX: 300, clientY: 200 });
  await opened.user.click(
    await screen.findByRole("menuitem", { name: /Rebase interactively from here/ }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Rebase main interactively" });
  const plan = await within(dialog).findByRole("list", { name: /Rebase plan/ });
  return { ...opened, dialog, plan, base: opened.commits[3]!.oid };
}

const summaries = (plan: HTMLElement) =>
  within(plan)
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".bl-irebase__summary-text, textarea")!.textContent);

/** A DataTransfer stand-in that keeps what was set during dragstart. */
function transfer() {
  const store: Record<string, string> = {};
  return {
    get types() {
      return Object.keys(store);
    },
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

const AI_ON = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: true, model: "m" } };
// History's newest commit is HEAD, so "Rewrite history" is offered on it.
const AT_HEAD = { ...REPO, head: { kind: "branch" as const, name: "main", oid: "0".repeat(40) } };

async function openRewrite(extra: Extra = () => undefined) {
  const opened = await open((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "inspect_repository") return AT_HEAD;
    if (cmd === "rewrite_base")
      return {
        base: oid(100),
        from: "origin/develop",
        commits: 3,
        published: 1,
        afterMerge: false,
        limited: false,
      };
  });
  await opened.user.keyboard("{Control>}2{/Control}");
  const list = await screen.findByRole("listbox", { name: "Commits" });
  const rows = within(list).getAllByRole("option");
  // Older commits do not offer it.
  fireEvent.contextMenu(rows[2]!, { clientX: 300, clientY: 200 });
  expect(await screen.findByRole("menuitem", { name: /Rebase interactively/ })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /Rewrite history/ })).toBeNull();
  await opened.user.keyboard("{Escape}");
  fireEvent.contextMenu(rows[0]!, { clientX: 300, clientY: 200 });
  await opened.user.click(await screen.findByRole("menuitem", { name: /Rewrite history of main/ }));
  const dialog = await screen.findByRole("dialog", { name: "Rewrite history of main" });
  const plan = await within(dialog).findByRole("list", { name: /Rebase plan/ });
  return { ...opened, dialog, plan };
}

const rows = (actions: string[]): Row[] =>
  actions.map((action, i) => ({
    oid: oid(200 + i),
    summary: `R${i}`,
    message: `R${i}`,
    authorName: "A",
    authorTime: 0,
    action: action as Row["action"],
    draft: `R${i}`,
  }));

describe("squash groups", () => {
  it("finds the commit each squash goes into, past drops and other squashes", () => {
    // Newest first: R0 squash, R1 fixup, R2 drop, R3 pick, R4 squash (nothing below).
    expect(combineTargets(rows(["squash", "fixup", "drop", "pick", "squash"]))).toEqual([
      3,
      3,
      null,
      null,
      null,
    ]);
  });

  it("applies an AI suggestion to the original order", () => {
    const original = rows(["pick", "pick", "pick"]);
    const applied = applySuggestion(original, {
      groups: [
        { commits: [oid(202), oid(201)], message: "feat: two in one", reason: "Same change." },
        { commits: [oid(200)], message: "R0", reason: null },
      ],
    });
    expect(applied.map((r) => r.action)).toEqual(["pick", "fixup", "reword"]);
    expect(applied[2]).toMatchObject({ draft: "feat: two in one", aiReason: "Same change." });
  });
});

describe("interactive rebase", () => {
  it("reorders, rewords and squashes, and sends the plan oldest first", async () => {
    const { user, calls, dialog, plan, base } = await openPlan((cmd) => {
      if (cmd === "interactive_rebase") return ok;
    });
    expect(summaries(plan)).toEqual(["Commit 3", "Commit 2", "Commit 1"]);
    const start = within(dialog).getByRole("button", { name: "Start rebase" });
    expect(start).toBeDisabled();

    // Move "Commit 1" to the top with the keyboard.
    within(plan)
      .getByRole("button", { name: /^Move Commit 1/ })
      .focus();
    await user.keyboard("{Alt>}{ArrowUp}{ArrowUp}{/Alt}");
    expect(summaries(plan)).toEqual(["Commit 1", "Commit 3", "Commit 2"]);

    await user.selectOptions(within(plan).getByLabelText("Action for Commit 2"), "reword");
    const message = within(plan).getByLabelText("New message for Commit 2");
    expect(message).toHaveValue("Commit 2\n\nBody 2");
    await user.clear(message);
    await user.type(message, "Better words");
    await user.selectOptions(within(plan).getByLabelText("Action for Commit 3"), "squash");
    expect(dialog).toHaveTextContent("1 kept · 1 reworded · 1 squashed");

    await user.click(start);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args).toEqual({
        repo: REPO.path,
        base,
        autostash: false,
        plan: [
          { oid: oid(102), action: "reword", message: "Better words" },
          { oid: oid(103), action: "squash", message: null },
          { oid: oid(101), action: "pick", message: null },
        ],
      }),
    );
    expect(await screen.findByText("Rewrote main")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains plans that cannot work before running them", async () => {
    const { user, dialog, plan } = await openPlan();
    await user.selectOptions(within(plan).getByLabelText("Action for Commit 1"), "fixup");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The oldest commit you keep cannot be squashed or fixed up",
    );
    expect(within(dialog).getByRole("button", { name: "Start rebase" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    for (const s of ["Commit 1", "Commit 2", "Commit 3"])
      await user.selectOptions(within(plan).getByLabelText(`Action for ${s}`), "drop");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Keep at least one commit.");
  });

  it("keeps the dialog open when Git refuses the plan", async () => {
    const { user, dialog, plan } = await openPlan((cmd) => {
      if (cmd === "interactive_rebase")
        return Promise.reject({
          kind: "unsupported",
          message: "The plan does not match the commits on the branch. Reload and try again.",
          detail: null,
        });
    });
    await user.selectOptions(within(plan).getByLabelText("Action for Commit 2"), "drop");
    await user.click(within(dialog).getByRole("button", { name: "Start rebase" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("does not match");
    expect(screen.getByRole("dialog", { name: "Rebase main interactively" })).toBeInTheDocument();
  });

  it("reorders by dragging rows", async () => {
    const { plan } = await openPlan();
    const rows = within(plan).getAllByRole("listitem");
    const dataTransfer = transfer();
    fireEvent.dragStart(rows[2]!, { dataTransfer });
    fireEvent.dragOver(rows[0]!, { dataTransfer });
    fireEvent.drop(rows[0]!, { dataTransfer });
    expect(summaries(plan)).toEqual(["Commit 1", "Commit 3", "Commit 2"]);
  });
});

describe("dragging branches", () => {
  async function dragBranch(from: string, to: string) {
    const opened = await open((cmd) => {
      if (cmd === "merge_into_current" || cmd === "rebase_current") return ok;
    });
    await opened.user.keyboard("{Control>}3{/Control}");
    const list = await screen.findByRole("list", { name: "Local branches" });
    const row = (name: string) => within(list).getByText(name).closest("li")!;
    const dataTransfer = transfer();
    fireEvent.dragStart(row(from), { dataTransfer });
    expect(JSON.parse(dataTransfer.getData(REF_MIME))).toEqual({ name: from, remote: false });
    fireEvent.dragOver(row(to), { dataTransfer });
    expect(row(to)).toHaveAttribute("data-drop-over");
    fireEvent.drop(row(to), { dataTransfer, clientX: 400, clientY: 300 });
    return opened;
  }

  it("merges a branch dropped onto the current branch", async () => {
    const { user, calls } = await dragBranch("feature/login", "main");
    const menu = await screen.findByRole("menu", { name: "Drop feature/login" });
    expect(
      within(menu).getByRole("menuitem", { name: "Rebase main onto feature/login…" }),
    ).toBeInTheDocument();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Merge feature/login into main…" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Merge" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "merge_into_current")?.args.request).toMatchObject({
        source: { kind: "branch", name: "feature/login" },
      }),
    );
  });

  it("rebases the current branch dropped onto another branch", async () => {
    const { user, calls } = await dragBranch("main", "feature/login");
    await user.click(
      await screen.findByRole("menuitem", { name: "Rebase main onto feature/login…" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rebase" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "rebase_current")?.args.onto).toEqual({
        kind: "branch",
        name: "feature/login",
      }),
    );
  });

  it("explains that one side must be the current branch", async () => {
    await dragBranch("feature/login", "feature/other");
    const menu = await screen.findByRole("menu", { name: "Drop feature/login" });
    expect(menu).toHaveTextContent("Merging or rebasing changes the current branch");
    expect(
      within(menu).getByRole("menuitem", { name: /Switch to feature\/other/ }),
    ).toBeInTheDocument();
  });

  it("rebases onto a commit by dropping the current branch label on it in History", async () => {
    const { user, calls, commits } = await open((cmd) => {
      if (cmd === "rebase_current") return ok;
    });
    await user.keyboard("{Control>}2{/Control}");
    const list = await screen.findByRole("listbox", { name: "Commits" });
    const badge = within(list).getByTitle("Current branch main");
    const target = within(list).getAllByRole("option")[3]!;
    const dataTransfer = transfer();
    fireEvent.dragStart(badge, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer, clientX: 400, clientY: 300 });
    const short = commits[3]!.oid.slice(0, 7);
    await user.click(
      await screen.findByRole("menuitem", { name: `Rebase main onto commit ${short}…` }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rebase" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "rebase_current")?.args.onto).toEqual({
        kind: "commit",
        oid: commits[3]!.oid,
      }),
    );
  });

  it("ignores drags that are not branches", async () => {
    await open();
    const list = await screen.findByRole("heading", { name: "Changes" });
    void list;
    await userEvent.setup().keyboard("{Control>}3{/Control}");
    const branches = await screen.findByRole("list", { name: "Local branches" });
    const row = within(branches).getByText("main").closest("li")!;
    const dataTransfer = transfer();
    dataTransfer.setData("Files", "x");
    fireEvent.dragOver(row, { dataTransfer });
    expect(row).not.toHaveAttribute("data-drop-over");
    fireEvent.drop(row, { dataTransfer });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("rewrite history", () => {
  it("starts where the branch began, shows squashes as a group and edits their message", async () => {
    const { user, calls, dialog, plan } = await openRewrite((cmd) => {
      if (cmd === "interactive_rebase") return ok;
    });
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "rebase_plan_commits")?.args.base).toBe(oid(100)),
    );
    expect(dialog).toHaveTextContent("after the commit where main started from origin/develop");
    expect(dialog).toHaveTextContent("1 of these commits are already pushed");
    // No AI while it is off.
    expect(within(dialog).queryByRole("button", { name: /Suggest with AI/ })).toBeNull();

    await user.selectOptions(within(plan).getByLabelText("Action for Commit 3"), "squash");
    const [top, middle] = within(plan).getAllByRole("listitem");
    expect(top).toHaveClass("bl-irebase__row--combined");
    expect(top).toHaveTextContent(`into ${oid(102).slice(0, 7)}`);
    expect(middle).toHaveClass("bl-irebase__row--target");
    expect(middle).toHaveTextContent("+1 combined");

    await user.click(within(middle!).getByRole("button", { name: /Edit message/ }));
    const message = within(plan).getByLabelText("Message for the combined commit of Commit 2");
    expect(message).toHaveValue("Commit 2\n\nBody 2\n\nCommit 3\n\nBody 3");
    await user.clear(message);
    await user.type(message, "feat: two and three");
    await user.click(within(dialog).getByRole("button", { name: "Start rebase" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args.plan).toEqual([
        { oid: oid(101), action: "pick", message: null },
        { oid: oid(102), action: "reword", message: "feat: two and three" },
        { oid: oid(103), action: "squash", message: null },
      ]),
    );
  });

  it("lets the AI suggest groups and messages, then starts the plan", async () => {
    const { user, calls, dialog, plan } = await openRewrite((cmd) => {
      if (cmd === "get_settings") return AI_ON;
      if (cmd === "suggest_rebase")
        return {
          groups: [
            {
              commits: [oid(101), oid(102)],
              message: "feat: one and two",
              reason: "Two fixes one.",
            },
            { commits: [oid(103)], message: "Commit 3\n\nBody 3", reason: null },
          ],
        };
      if (cmd === "interactive_rebase") return ok;
    });
    await user.click(within(dialog).getByRole("button", { name: /Suggest with AI/ }));
    expect(calls.find((c) => c.cmd === "suggest_rebase")?.args).toMatchObject({
      repo: REPO.path,
      base: oid(100),
    });
    expect(await within(dialog).findByText(/2 commits combined into 1/)).toBeInTheDocument();
    expect(within(plan).getByText("Two fixes one.")).toBeInTheDocument();
    expect(within(plan).getByLabelText("Action for Commit 2")).toHaveValue("fixup");
    expect(within(plan).getByLabelText("Message for the combined commit of Commit 1")).toHaveValue(
      "feat: one and two",
    );

    await user.click(within(dialog).getByRole("button", { name: "Start rebase" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "interactive_rebase")?.args.plan).toEqual([
        { oid: oid(101), action: "reword", message: "feat: one and two" },
        { oid: oid(102), action: "fixup", message: null },
        { oid: oid(103), action: "pick", message: null },
      ]),
    );
  });

  it("explains when the start cannot be found", async () => {
    const { user } = await open((cmd) => {
      if (cmd === "inspect_repository") return AT_HEAD;
      if (cmd === "rewrite_base")
        return Promise.reject({
          kind: "unsupported",
          message: "Branchline could not tell where main started.",
          detail: null,
        });
    });
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("Rewrite history");
    await user.click(await screen.findByRole("option", { name: /Rewrite history of main/ }));
    expect(await screen.findByText(/could not tell where main started/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Rewrite history/ })).toBeNull();
  });
});
