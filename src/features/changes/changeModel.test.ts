import { describe, expect, it } from "vitest";
import type { FileChange } from "../../types/git";
import { filterGroups, groupChanges, trackedChangeCount } from "./changeModel";

const change = (over: Partial<FileChange>): FileChange => ({
  path: "file.txt",
  originalPath: null,
  indexStatus: null,
  worktreeStatus: null,
  conflict: null,
  isSubmodule: false,
  ...over,
});

describe("groupChanges", () => {
  it("puts a partially staged file in both lists with distinct ids", () => {
    const g = groupChanges([
      change({ path: "a.ts", indexStatus: "added", worktreeStatus: "modified" }),
    ]);
    expect(g.staged).toHaveLength(1);
    expect(g.unstaged).toHaveLength(1);
    expect(g.staged[0]!.status).toBe("added");
    expect(g.unstaged[0]!.status).toBe("modified");
    expect(g.staged[0]!.id).not.toBe(g.unstaged[0]!.id);
  });

  it("separates conflicts from other changes", () => {
    const g = groupChanges([
      change({ path: "c.txt", conflict: "bothModified" }),
      change({ path: "u.txt", worktreeStatus: "untracked" }),
    ]);
    expect(g.conflicted.map((e) => e.path)).toEqual(["c.txt"]);
    expect(g.conflicted[0]!.status).toBe("conflicted");
    expect(g.untracked.map((e) => e.path)).toEqual(["u.txt"]);
    expect(g.untracked[0]!.area).toBe("untracked");
    expect(g.unstaged).toEqual([]);
    expect(g.staged).toEqual([]);
  });

  it("counts what the conflict, staged and unstaged lists show, not untracked files", () => {
    const changes = [
      change({ path: "a", worktreeStatus: "modified", indexStatus: "modified" }),
      change({ path: "b", indexStatus: "added" }),
      change({ path: "c", worktreeStatus: "untracked" }),
      change({ path: "d", conflict: "bothModified" }),
    ];
    const g = groupChanges(changes);
    // "a" is in both lists, like in the Changes view: 1 conflict + 2 staged + 1 unstaged.
    expect(trackedChangeCount(changes)).toBe(4);
    expect(trackedChangeCount(changes)).toBe(
      g.conflicted.length + g.staged.length + g.unstaged.length,
    );
  });

  it("keeps rename sources", () => {
    const g = groupChanges([
      change({ path: "new.txt", originalPath: "old.txt", indexStatus: "renamed" }),
    ]);
    expect(g.staged[0]!.originalPath).toBe("old.txt");
  });
});

describe("filterGroups", () => {
  const g = groupChanges([
    change({ path: "src/App.tsx", worktreeStatus: "modified" }),
    change({ path: "docs/readme.md", indexStatus: "renamed", originalPath: "README.md" }),
  ]);

  it("matches case-insensitively on path and original path", () => {
    expect(filterGroups(g, "app").unstaged).toHaveLength(1);
    expect(filterGroups(g, "README").staged).toHaveLength(1);
    expect(filterGroups(g, "nothing").unstaged).toHaveLength(0);
  });

  it("returns everything for a blank query", () => {
    expect(filterGroups(g, "  ")).toBe(g);
  });
});
