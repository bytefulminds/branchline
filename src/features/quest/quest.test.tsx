import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../App";
import { audit } from "../../test/axe";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { FileDiff } from "../../types/git";
import { DEFAULT_SETTINGS, type Settings } from "../../types/settings";
import type { QuestPlan, Round } from "../../types/quest";
import { QuestView } from "./QuestView";
import { coverage, emptyQuest, lineRefAt, pointsFor, POINTS } from "./questModel";
import type { QuestSpec } from "./QuestProvider";

installTauriTestEnvironment();
afterEach(() => window.localStorage.clear());

const AI_ON: Settings = {
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, enabled: true, model: "m" },
};

const PLAN: QuestPlan = {
  rounds: [
    {
      path: "src/api.py",
      originalPath: null,
      status: "M",
      additions: 2,
      deletions: 1,
      skipped: null,
    },
  ],
  skipped: [
    {
      path: "package-lock.json",
      originalPath: null,
      status: "M",
      additions: 40,
      deletions: 2,
      skipped: "Generated or lock file",
    },
  ],
  totalLines: 45,
};

const DIFF: FileDiff = {
  path: "src/api.py",
  originalPath: null,
  area: "commit",
  hunks: [
    {
      header: "@@ -1,2 +1,3 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      section: "",
      lines: [
        {
          kind: "context",
          content: "import json",
          oldLine: 1,
          newLine: 1,
          noNewline: false,
          crlf: false,
        },
        {
          kind: "delete",
          content: "TTL = 0",
          oldLine: 2,
          newLine: null,
          noNewline: false,
          crlf: false,
        },
        {
          kind: "add",
          content: "TTL = 600",
          oldLine: null,
          newLine: 2,
          noNewline: false,
          crlf: false,
        },
        {
          kind: "add",
          content: "CACHE = {}",
          oldLine: null,
          newLine: 3,
          noNewline: false,
          crlf: false,
        },
      ],
    },
  ],
  isBinary: false,
  tooLarge: false,
  sizeBytes: 60,
  additions: 2,
  deletions: 1,
  oldMode: null,
  newMode: null,
  change: null,
  supportsPartial: false,
  hasConflictMarkers: false,
} as FileDiff;

const ROUND: Round = {
  path: "src/api.py",
  questions: [
    {
      kind: "choice",
      prompt: "How long are forecasts cached?",
      choices: ["Ten minutes", "Forever", "Not at all"],
      answer: 0,
      lines: [{ side: "new", line: 2 }],
      explanation: "TTL is 600 seconds.",
    },
    {
      kind: "findLine",
      prompt: "Click the line where the cache is created.",
      choices: [],
      answer: null,
      lines: [{ side: "new", line: 3 }],
      explanation: "CACHE starts empty.",
    },
    {
      kind: "open",
      prompt: "Should the time be a setting?",
      choices: [],
      answer: null,
      lines: [],
      explanation: "",
    },
  ],
};

const SPEC: QuestSpec = {
  repoPath: REPO.path,
  base: "b".repeat(40),
  head: "c".repeat(40),
  title: "Cache forecasts",
  description: "Caches forecasts for ten minutes.",
  ownBranch: false,
  storageKey: "acme/lumen!42",
  discussion: { "src/api.py": "Tom: keep it simple" },
  backLabel: "Merge request",
};

describe("quest model", () => {
  it("scores thought and correctness, never speed", () => {
    const [choice, , open] = ROUND.questions;
    expect(pointsFor(choice!, { choice: 0, correct: true })).toBe(POINTS.answer + POINTS.firstTry);
    expect(pointsFor(choice!, { choice: 1, correct: false })).toBe(POINTS.answer);
    expect(pointsFor(open!, { text: "short" })).toBe(POINTS.answer);
    expect(pointsFor(open!, { text: "x".repeat(60) })).toBe(POINTS.answer + POINTS.thoughtful);
    expect(pointsFor(choice!, { skipped: true })).toBe(0);
  });

  it("maps diff lines and measures coverage of the quest's files", () => {
    expect(lineRefAt(DIFF, 0, 1)).toEqual({ side: "old", line: 2 });
    expect(lineRefAt(DIFF, 0, 3)).toEqual({ side: "new", line: 3 });
    const s = emptyQuest("c");
    expect(coverage(PLAN, s)).toBe(0);
    s.rounds["src/api.py"] = { questions: [], answers: [], done: true, skipped: false };
    // The lock file is left out of the quest, so it does not count.
    expect(coverage(PLAN, s)).toBe(100);
  });
});

function startQuest(
  extra: (cmd: string, args: Record<string, unknown>) => unknown = () => undefined,
) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "get_settings") return AI_ON;
    if (cmd === "quest_plan") return PLAN;
    if (cmd === "quest_round") return ROUND;
    if (cmd === "range_file_diff") return DIFF;
    if (cmd === "quest_reply")
      return {
        reply: "Good point: a setting would help people who check often.",
        comment: "Could the cache time be a setting?",
        line: { side: "new", line: 2 },
      };
  });
  let exited = false;
  const view = render(<QuestView spec={SPEC} onExit={() => (exited = true)} />);
  return { user, calls, view, exited: () => exited };
}

describe("review quest", () => {
  it("plays a round: quiz, find the line, an open question and a draft comment", async () => {
    const { user, calls } = startQuest();
    const card = await screen.findByRole("region", { name: "Question 1 of 3" });
    const round = calls.find((c) => c.cmd === "quest_round")?.args.context as Record<
      string,
      unknown
    >;
    expect(round).toMatchObject({
      path: "src/api.py",
      title: "Cache forecasts",
      discussion: "Tom: keep it simple",
      ownBranch: false,
    });

    await user.click(within(card).getByRole("button", { name: "Ten minutes" }));
    expect(within(card).getByRole("status")).toHaveTextContent("Right, +15 points.");
    expect(screen.getByText(/15 points/, { selector: ".bl-quest__points" })).toBeInTheDocument();

    // The next question: click the right line in the diff.
    await user.click(screen.getByRole("button", { name: "Next question" }));
    const next = await screen.findByRole("region", { name: "Question 2 of 3" });
    expect(next).toHaveTextContent("Click the line where the cache is created.");
    const diff = screen.getByRole("region", { name: "Changes in src/api.py" });
    await user.click(within(diff).getByText("CACHE = {}"));
    expect(next).toHaveTextContent("Right, +15 points.");

    await user.click(screen.getByRole("button", { name: "Next question" }));
    const open = await screen.findByRole("region", { name: "Question 3 of 3" });
    await user.type(
      within(open).getByLabelText("Your answer"),
      "Yes, people who check the weather often want fresher data.",
    );
    await user.click(within(open).getByRole("button", { name: "Send answer" }));
    expect(await within(open).findByText(/a setting would help/)).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "quest_reply")?.args.context).toMatchObject({
      question: "Should the time be a setting?",
      path: "src/api.py",
    });
    expect(
      within(open).getByDisplayValue("Could the cache time be a setting?"),
    ).toBeInTheDocument();
    await user.click(within(open).getByRole("button", { name: /Add as draft comment/ }));
    expect(within(open).getByText("Added to your draft comments.")).toBeInTheDocument();
    expect(within(open).queryByRole("button", { name: /Add as draft comment/ })).toBeNull();
    // 15 + 15 + 15 (a thoughtful answer) + 15 (a comment)
    expect(screen.getByText(/60 points/, { selector: ".bl-quest__points" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /draft comments on api.py/ })).toHaveTextContent(
      "Could the cache time be a setting?",
    );

    await user.click(screen.getByRole("button", { name: /Finish api.py/ }));
    const summary = await screen.findByRole("region", { name: "Quest summary" });
    expect(summary).toHaveTextContent("65 points");
    expect(summary).toHaveTextContent("100% of the changed lines covered");
    expect(summary).toHaveTextContent("2 of 2 quiz questions right");
    expect(summary).toHaveTextContent("package-lock.json");
    expect(within(summary).getByLabelText("Comment on src/api.py, line 2")).toHaveValue(
      "Could the cache time be a setting?",
    );

    // Progress is kept: opening the quest again shows the summary.
    const saved = JSON.parse(window.localStorage.getItem("branchline.quest.acme/lumen!42")!);
    expect(saved.points).toBe(65);
    expect(saved.comments).toHaveLength(1);
  });

  it("comments on any changed line, and explains a wrong answer", async () => {
    const { user } = startQuest();
    const card = await screen.findByRole("region", { name: "Question 1 of 3" });
    await user.click(within(card).getByRole("button", { name: "Forever" }));
    expect(within(card).getByRole("status")).toHaveTextContent(
      "Not quite, +10 points for looking. TTL is 600 seconds.",
    );
    // The next question asks for a line; skip it, then a click drafts a comment.
    await user.click(screen.getByRole("button", { name: "Next question" }));
    await screen.findByRole("region", { name: "Question 2 of 3" });
    await user.click(screen.getByRole("button", { name: "Skip question" }));
    const diff = screen.getByRole("region", { name: "Changes in src/api.py" });
    // Syntax colors split the line into parts.
    const removed = within(diff)
      .getAllByText(
        (_, el) =>
          !!el?.className.toString().includes("bl-diff-row") &&
          el.textContent?.includes("TTL = 0") === true,
      )
      .at(-1)!;
    await user.click(removed);
    const composer = screen.getByRole("group", { name: "Comment on removed line 2" });
    await user.type(within(composer).getByRole("textbox"), "Why was it zero before?");
    await user.click(within(composer).getByRole("button", { name: /Add/ }));
    expect(screen.getByRole("list", { name: /draft comments on api.py/ })).toHaveTextContent(
      "Removed line 2 Why was it zero before?",
    );
  });

  it("explains a model that fails and lets you skip the file", async () => {
    const { user } = startQuest((cmd) =>
      cmd === "quest_round"
        ? Promise.reject({
            kind: "ai",
            message: "The model's questions did not fit this file.",
            detail: null,
          })
        : undefined,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("did not fit this file");
    await user.click(screen.getByRole("button", { name: "Skip this file" }));
    const summary = await screen.findByRole("region", { name: "Quest summary" });
    expect(summary).toHaveTextContent("0 points");
    expect(summary).toHaveTextContent("src/api.py skipped");
  });
});

describe("review quest accessibility (axe)", () => {
  it("a question with its diff, an open question and the summary", async () => {
    const { user } = startQuest();
    const card = await screen.findByRole("region", { name: "Question 1 of 3" });
    await audit("quest question");
    await user.click(within(card).getByRole("button", { name: "Ten minutes" }));
    await audit("quest answered");
    await user.click(screen.getByRole("button", { name: "Next question" }));
    await user.click(screen.getByRole("button", { name: "Skip question" }));
    await screen.findByRole("region", { name: "Question 3 of 3" });
    await audit("quest open question");
    await user.click(screen.getAllByRole("button", { name: "Summary" })[0]!);
    await screen.findByRole("region", { name: "Quest summary" });
    await audit("quest summary");
  }, 30_000);
});

describe("review quest entry points", () => {
  async function openChanges(settings: Settings) {
    const user = userEvent.setup();
    const calls = setup((cmd) => {
      if (cmd === "get_settings") return settings;
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") return REPO;
      if (cmd === "rewrite_base")
        return {
          base: "b".repeat(40),
          start: "created",
          from: "develop",
          commits: 2,
          published: 0,
          afterMerge: false,
          limited: false,
        };
      if (cmd === "quest_plan") return PLAN;
      if (cmd === "quest_round") return ROUND;
      if (cmd === "range_file_diff") return DIFF;
    });
    render(<App />);
    await user.click(openButton());
    await screen.findByRole("heading", { name: "Changes" });
    return { user, calls };
  }

  it("does not exist while AI is off", async () => {
    const { user } = await openChanges(DEFAULT_SETTINGS);
    expect(screen.queryByRole("button", { name: "Review my branch with AI" })).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("Review");
    expect(screen.queryByRole("option", { name: /Review main with AI/ })).toBeNull();
  });

  it("reviews your own branch from where it started", async () => {
    const { user, calls } = await openChanges(AI_ON);
    await user.click(screen.getByRole("button", { name: "Review my branch with AI" }));
    await screen.findByRole("heading", { name: "Review your branch: main" });
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "quest_plan")?.args).toEqual({
        repo: REPO.path,
        base: "b".repeat(40),
        head: REPO.head.kind === "branch" ? REPO.head.oid : "",
      }),
    );
    await screen.findByRole("region", { name: "Question 1 of 3" });
    expect(
      (calls.find((c) => c.cmd === "quest_round")?.args.context as { ownBranch: boolean })
        .ownBranch,
    ).toBe(true);
    // Leaving through the sidebar ends the quest.
    await user.click(screen.getByRole("button", { name: /^History/ }));
    expect(screen.queryByRole("region", { name: "Review quest" })).toBeNull();
  });
});
