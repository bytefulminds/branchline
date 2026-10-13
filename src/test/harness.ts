import { cleanup } from "@testing-library/react";
import { screen, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach } from "vitest";
import type { DiffArea, FileDiff, RepositoryInfo } from "../types/git";

export const REPO: RepositoryInfo = {
  path: "/Users/dev/projects/demo",
  name: "demo",
  gitDir: "/Users/dev/projects/demo/.git",
  head: { kind: "branch", name: "main", oid: "a".repeat(40) },
  upstream: { name: "origin/main", ahead: 2, behind: 1, gone: false },
  headCommit: {
    oid: "a".repeat(40),
    shortOid: "aaaaaaa",
    summary: "Initial commit",
    authorName: "Dev",
    authorDate: new Date().toISOString(),
  },
  operation: null,
  changes: [
    {
      path: "src/app.ts",
      originalPath: null,
      indexStatus: null,
      worktreeStatus: "modified",
      conflict: null,
      isSubmodule: false,
    },
    {
      path: "notes/new file.md",
      originalPath: null,
      indexStatus: null,
      worktreeStatus: "untracked",
      conflict: null,
      isSubmodule: false,
    },
    {
      path: "lib/b.rs",
      originalPath: "lib/a.rs",
      indexStatus: "renamed",
      worktreeStatus: null,
      conflict: null,
      isSubmodule: false,
    },
  ],
  totalChanges: 3,
  truncated: false,
  inspectedAt: Date.now(),
  durationMs: 12,
};

export function diffFor({ path, area }: { path: string; area: DiffArea }): FileDiff {
  return {
    path,
    originalPath: null,
    area,
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        section: "",
        lines: [
          {
            kind: "context",
            content: "keep",
            oldLine: 1,
            newLine: 1,
            noNewline: false,
            crlf: false,
          },
          {
            kind: "delete",
            content: "old",
            oldLine: 2,
            newLine: null,
            noNewline: false,
            crlf: false,
          },
          { kind: "add", content: "new", oldLine: null, newLine: 2, noNewline: false, crlf: false },
          {
            kind: "context",
            content: "end",
            oldLine: 3,
            newLine: 3,
            noNewline: false,
            crlf: false,
          },
        ],
      },
    ],
    isBinary: false,
    tooLarge: false,
    sizeBytes: 100,
    additions: 1,
    deletions: 1,
    oldMode: null,
    newMode: null,
    change: null,
    supportsPartial: area === "unstaged" || area === "staged",
    hasConflictMarkers: false,
    fingerprint: `fp-${path}`,
  };
}

/** The primary "Open repository" button in the workspace (title bar and sidebar have their own). */
export const openButton = () =>
  within(screen.getByRole("main")).getAllByRole("button", { name: /open repository/i })[0]!;

export type Handler = (cmd: string, args: Record<string, unknown>) => unknown;

export function setup(handler: Handler) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd.startsWith("plugin:window|")) return cmd.endsWith("is_maximized") ? false : null;
      if (cmd === "git_version")
        return { version: "2.45.0", major: 2, minor: 45, path: "/usr/bin/git" };
      if (cmd === "watch_repository" || cmd === "unwatch_repository") return null;
      if (cmd === "file_diff") return diffFor(args as { path: string; area: DiffArea });
      return handler(cmd, (args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

/** Pretend to run inside Tauri and tear the IPC mocks down after each test. */
export function installTauriTestEnvironment() {
  beforeEach(() => {
    (globalThis as unknown as { isTauri: boolean }).isTauri = true;
  });
  afterEach(() => {
    // Unmount while the IPC mocks still exist so listeners unregister cleanly.
    cleanup();
    clearMocks();
    delete (globalThis as unknown as { isTauri?: boolean }).isTauri;
  });
}
