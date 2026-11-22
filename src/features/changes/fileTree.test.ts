import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "./changeModel";
import { fileTree, folderOf } from "./fileTree";

const file = (path: string): ChangeEntry => ({
  id: `unstaged:${path}`,
  area: "unstaged",
  path,
  originalPath: null,
  status: "modified",
  conflict: null,
  isSubmodule: false,
});

const show = (lines: ReturnType<typeof fileTree>) =>
  lines.map((l) =>
    l.type === "folder"
      ? `${"  ".repeat(l.depth)}${l.name}/ (${l.entries.length})`
      : `${"  ".repeat(l.depth)}${l.entry.path.split("/").pop()}`,
  );

describe("fileTree", () => {
  const files = [
    file("README.md"),
    file("src/app.py"),
    file("src/utils/colors.py"),
    file("src/utils/format.py"),
    file("docs/guide/en/intro.md"),
    file("a.txt"),
  ];

  it("puts folders first, joins single-folder chains and counts every file below", () => {
    expect(show(fileTree(files, new Set()))).toEqual([
      "docs/guide/en/ (1)",
      "  intro.md",
      "src/ (3)",
      "  utils/ (2)",
      "    colors.py",
      "    format.py",
      "  app.py",
      "a.txt",
      "README.md",
    ]);
  });

  it("hides what is below a collapsed folder", () => {
    expect(show(fileTree(files, new Set(["src/utils"])))).toEqual([
      "docs/guide/en/ (1)",
      "  intro.md",
      "src/ (3)",
      "  utils/ (2)",
      "  app.py",
      "a.txt",
      "README.md",
    ]);
    expect(show(fileTree(files, new Set(["src"])))).toContain("src/ (3)");
    expect(show(fileTree(files, new Set(["src"])))).not.toContain("  app.py");
  });

  it("finds the files of the folder a file is in", () => {
    expect(folderOf(files[2]!, files).map((e) => e.path)).toEqual([
      "src/utils/colors.py",
      "src/utils/format.py",
    ]);
    expect(folderOf(files[0]!, files)).toEqual([]);
  });
});
