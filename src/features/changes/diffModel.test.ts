import { describe, expect, it } from "vitest";
import { diffFor } from "../../test/harness";
import type { ChangeEntry } from "./changeModel";
import { nextSelection } from "./ChangesView";
import {
  diffAreaFor,
  diffRows,
  selectRange,
  selectionCount,
  toSelections,
  toggleLine,
  type LineSelection,
} from "./diffModel";

const entry = (over: Partial<ChangeEntry>): ChangeEntry => ({
  id: "x",
  area: "unstaged",
  path: "a",
  originalPath: null,
  status: "modified",
  conflict: null,
  isSubmodule: false,
  ...over,
});

describe("diffModel", () => {
  const diff = diffFor({ path: "f", area: "unstaged" });

  it("maps entries to diff areas", () => {
    expect(diffAreaFor(entry({ status: "untracked" }))).toBe("untracked");
    expect(diffAreaFor(entry({}))).toBe("unstaged");
    expect(diffAreaFor(entry({ area: "staged" }))).toBe("staged");
    expect(diffAreaFor(entry({ area: "conflicted", status: "conflicted" }))).toBe("conflicted");
  });

  it("flattens hunks and no-newline markers into rows", () => {
    expect(diffRows(diff)).toHaveLength(5);
    const withMarker = {
      ...diff,
      hunks: [
        {
          ...diff.hunks[0]!,
          lines: diff.hunks[0]!.lines.map((l, i) => ({ ...l, noNewline: i === 3 })),
        },
      ],
    };
    expect(diffRows(withMarker).at(-1)).toEqual({ type: "noNewline", hunk: 0, line: 3 });
    expect(diffRows(diff, false)[0]).toEqual({ type: "line", hunk: 0, line: 0 });
  });

  it("toggles lines and selects ranges of change lines only", () => {
    let sel: LineSelection = new Map();
    sel = toggleLine(sel, 0, 1);
    expect(selectionCount(sel)).toBe(1);
    sel = toggleLine(sel, 0, 1);
    expect(selectionCount(sel)).toBe(0);
    sel = selectRange(diff, new Map(), 0, 3, 0);
    // Context lines 0 and 3 are skipped.
    expect(toSelections(sel)).toEqual([{ hunk: 0, lines: [1, 2] }]);
  });
});

describe("nextSelection", () => {
  const a = entry({ id: "unstaged:a", path: "a" });
  const b = entry({ id: "unstaged:b", path: "b" });
  const c = entry({ id: "unstaged:c", path: "c" });
  const aStaged = entry({ id: "staged:a", path: "a", area: "staged" });

  it("moves to the next file in the same area", () => {
    expect(nextSelection([a, b, c], [b, c, aStaged], a.id)).toBe(b.id);
  });
  it("falls back to the previous file, then the same file elsewhere", () => {
    expect(nextSelection([a, b], [a, entry({ ...b, id: "staged:b", area: "staged" })], b.id)).toBe(
      a.id,
    );
    expect(nextSelection([a], [aStaged], a.id)).toBe(aStaged.id);
    expect(nextSelection([a], [], a.id)).toBeNull();
  });
});
