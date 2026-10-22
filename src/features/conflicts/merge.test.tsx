import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { audit } from "../../test/axe";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { ConflictFile, MergeSegment, RepositoryInfo } from "../../types/git";
import {
  hasMarkers,
  initialState,
  linesFromText,
  reduce,
  remaining,
  resultText,
  type MergeState,
} from "./mergeModel";

installTauriTestEnvironment();

const SEGMENTS: MergeSegment[] = [
  { kind: "same", lines: ["import json\n", "\n"] },
  {
    kind: "change",
    change: "ours",
    base: ["A = 1\n"],
    ours: ["A = 2\n"],
    theirs: ["A = 1\n"],
  },
  { kind: "same", lines: ["\n"] },
  {
    kind: "change",
    change: "conflict",
    base: ["PORT = 8080\n"],
    ours: ["PORT = 8000\n"],
    theirs: ["PORT = 9090\n", "WORKERS = 8\n"],
  },
  {
    kind: "change",
    change: "theirs",
    base: ["end"],
    ours: ["end"],
    theirs: ["the end"],
  },
];

const chunkIds = (s: MergeState) =>
  s.blocks.flatMap((b) => (b.kind === "change" ? [b.chunk.id] : []));

describe("merge model", () => {
  it("takes changes that do not conflict and leaves conflicts open", () => {
    const start = initialState(SEGMENTS);
    expect(resultText(start)).toBe("import json\n\nA = 1\n\nPORT = 8080\nend");
    const s = reduce(start, { type: "applyNonConflicting" });
    expect(resultText(s)).toBe("import json\n\nA = 2\n\nPORT = 8080\nthe end");
    expect(remaining(s)).toEqual({ conflicts: 1, changes: 0 });
  });

  it("applies one side, then appends the other; leaving both out keeps the base", () => {
    const s0 = initialState(SEGMENTS);
    const id = chunkIds(s0)[1]!;
    let s = reduce(s0, { type: "apply", id, side: "theirs" });
    expect(resultText(s)).toContain("PORT = 9090\nWORKERS = 8\n");
    expect(remaining(s).conflicts).toBe(1);
    s = reduce(s, { type: "apply", id, side: "ours" });
    expect(resultText(s)).toContain("PORT = 9090\nWORKERS = 8\nPORT = 8000\n");
    expect(remaining(s).conflicts).toBe(0);
    // Applying again changes nothing.
    expect(reduce(s, { type: "apply", id, side: "ours" })).toEqual(s);

    s = reduce(s, { type: "reset", id });
    expect(remaining(s).conflicts).toBe(1);
    s = reduce(reduce(s, { type: "ignore", id, side: "ours" }), {
      type: "ignore",
      id,
      side: "theirs",
    });
    expect(resultText(s)).toContain("PORT = 8080\n");
    expect(remaining(s).conflicts).toBe(0);
  });

  it("takes everything from one side", () => {
    const s = reduce(initialState(SEGMENTS), { type: "applyAll", side: "ours" });
    expect(resultText(s)).toBe("import json\n\nA = 2\n\nPORT = 8000\nend");
    expect(remaining(s)).toEqual({ conflicts: 0, changes: 0 });
  });

  it("applies a change made the same way on both sides once", () => {
    const s0 = initialState([
      { kind: "change", change: "both", base: [], ours: ["x\n"], theirs: ["x\n"] },
    ]);
    const s = reduce(s0, { type: "apply", id: 0, side: "theirs" });
    expect(resultText(s)).toBe("x\n");
    expect(remaining(s)).toEqual({ conflicts: 0, changes: 0 });
  });

  it("keeps line endings and a missing final newline when typing", () => {
    const crlf: MergeSegment[] = [
      { kind: "same", lines: ["a\r\n"] },
      { kind: "change", change: "conflict", base: ["b"], ours: ["B1"], theirs: ["B2"] },
    ];
    const s0 = initialState(crlf);
    expect(s0.eol).toBe("\r\n");
    const s = reduce(s0, { type: "edit", id: 0, text: "B1\nB2" });
    expect(resultText(s)).toBe("a\r\nB1\r\nB2");
    expect(remaining(s).conflicts).toBe(0);
    expect(linesFromText("", "\n", true)).toEqual([]);
    expect(linesFromText("x\ny", "\n", true)).toEqual(["x\n", "y\n"]);
  });

  it("detects conflict markers", () => {
    expect(hasMarkers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n")).toBe(true);
    expect(hasMarkers("a <<<<<<< b\n== not a marker\n")).toBe(false);
  });
});

const CONFLICTED: RepositoryInfo = {
  ...REPO,
  operation: "merge",
  changes: [
    {
      path: "src/config.py",
      originalPath: null,
      indexStatus: null,
      worktreeStatus: null,
      conflict: "bothModified",
      isSubmodule: false,
    },
  ],
  totalChanges: 1,
};

const FILE: ConflictFile = {
  path: "src/config.py",
  conflict: "bothModified",
  ours: {
    label: "main",
    role: "Current branch",
    commit: { oid: "a".repeat(40), summary: "Use port 8000" },
    exists: true,
  },
  theirs: {
    label: "feature/tuning",
    role: "Being merged",
    commit: { oid: "b".repeat(40), summary: "Tune port" },
    exists: true,
  },
  baseExists: true,
  segments: SEGMENTS,
  unmergeable: null,
  fingerprint: "fp-1",
};

async function openEditor(file: ConflictFile = FILE) {
  const user = userEvent.setup();
  const calls = setup((cmd) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return CONFLICTED;
    if (cmd === "list_branches") return { local: [], remote: [] };
    if (cmd === "conflict_file") return file;
    if (cmd === "resolve_conflict_text" || cmd === "resolve_conflict_side")
      return { ...CONFLICTED, changes: [], totalChanges: 0 };
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.click(await screen.findByText("config.py"));
  await user.click(await screen.findByRole("button", { name: "Resolve in merge editor" }));
  const editor = await screen.findByRole("dialog", { name: "Merge config.py" });
  return { user, calls, editor };
}

describe("merge editor", () => {
  it("passes the accessibility audit", async () => {
    await openEditor();
    await audit("merge editor");
  });

  it("takes changes per side and saves the result", async () => {
    const { user, calls, editor } = await openEditor();
    expect(within(editor).getByRole("status")).toHaveTextContent("1 conflict left");
    // Non-conflicting changes are taken already.
    const result = within(editor).getByLabelText(/Result for conflict at line 5, not resolved/);
    expect(result).toHaveValue("PORT = 8080");

    await user.click(
      within(editor).getByRole("button", { name: /^Take feature\/tuning's change/ }),
    );
    await user.click(within(editor).getByRole("button", { name: /^Take main's change/ }));
    expect(within(editor).getByRole("status")).toHaveTextContent("All changes handled");
    expect(within(editor).getByLabelText(/Result for conflict at line 5$/)).toHaveValue(
      "PORT = 9090\nWORKERS = 8\nPORT = 8000",
    );

    // Undo the last choice, then type the result instead.
    await user.click(within(editor).getByRole("button", { name: "Undo" }));
    const box = within(editor).getByLabelText(/Result for conflict at line 5/);
    await user.clear(box);
    await user.type(box, "PORT = 8000{Enter}WORKERS = 8");

    await user.click(within(editor).getByRole("button", { name: "Save and mark resolved" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "resolve_conflict_text")?.args).toEqual({
        repo: REPO.path,
        path: "src/config.py",
        content: "import json\n\nA = 2\n\nPORT = 8000\nWORKERS = 8\nthe end",
        fingerprint: "fp-1",
      }),
    );
    expect(await screen.findByText("Resolved config.py")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Merge config.py" })).not.toBeInTheDocument();
  });

  it("asks before saving with an open conflict", async () => {
    const { user, calls, editor } = await openEditor();
    await user.click(within(editor).getByRole("button", { name: "Save and mark resolved" }));
    const ask = await screen.findByRole("alertdialog", { name: "Save with open changes?" });
    expect(ask).toHaveTextContent("1 conflict is not resolved");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.cmd === "resolve_conflict_text")).toBe(false);
  });

  it("keeps a whole side, and asks before discarding choices", async () => {
    const { user, calls, editor } = await openEditor();
    await user.click(within(editor).getByRole("button", { name: /^Take main's change/ }));
    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("alertdialog", { name: "Discard this merge?" });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));

    const useAll = within(editor).getAllByRole("button", { name: "Use all" });
    await user.click(useAll[1]!);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Use feature/tuning's version",
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "resolve_conflict_side")?.args).toMatchObject({
        side: "theirs",
        fingerprint: "fp-1",
      }),
    );
  });

  it("offers whole-file choices when the file cannot be merged line by line", async () => {
    const { user, calls, editor } = await openEditor({
      ...FILE,
      conflict: "deletedByThem",
      theirs: { ...FILE.theirs, exists: false },
      segments: null,
      unmergeable: "feature/tuning deleted this file.",
    });
    expect(editor).toHaveTextContent("feature/tuning deleted this file.");
    await user.click(
      within(editor).getByRole("button", { name: "Delete it, like feature/tuning" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "resolve_conflict_side")?.args).toMatchObject({
        side: "delete",
      }),
    );
  });

  it("shows why the file could not be loaded", async () => {
    const user = userEvent.setup();
    setup((cmd) => {
      if (cmd === "plugin:dialog|open") return REPO.path;
      if (cmd === "inspect_repository") return CONFLICTED;
      if (cmd === "list_branches") return { local: [], remote: [] };
      if (cmd === "conflict_file")
        return Promise.reject({
          kind: "unsupported",
          message: "src/config.py is no longer conflicted.",
          detail: null,
        });
    });
    render(<App />);
    await user.click(openButton());
    await user.click(await screen.findByText("config.py"));
    await user.click(await screen.findByRole("button", { name: "Resolve in merge editor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer conflicted");
  });
});
