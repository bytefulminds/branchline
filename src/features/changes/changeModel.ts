import type { ChangeKind, ConflictKind, FileChange } from "../../types/git";

export type ChangeArea = "conflicted" | "unstaged" | "staged";
export type StatusCode = ChangeKind | "conflicted";

export interface ChangeEntry {
  /** Stable key, unique across areas (a file can be both staged and unstaged). */
  id: string;
  area: ChangeArea;
  path: string;
  originalPath: string | null;
  status: StatusCode;
  conflict: ConflictKind | null;
  isSubmodule: boolean;
}

export interface GroupedChanges {
  conflicted: ChangeEntry[];
  unstaged: ChangeEntry[];
  staged: ChangeEntry[];
}

// Staged first, under conflicts: what goes into the next commit is on top.
export const AREA_ORDER: ChangeArea[] = ["conflicted", "staged", "unstaged"];

export const AREA_LABEL: Record<ChangeArea, string> = {
  conflicted: "Conflicts",
  unstaged: "Unstaged changes",
  staged: "Staged changes",
};

export interface StatusMeta {
  label: string;
  /** Short code shown next to the file, so status is never conveyed by color alone. */
  letter: string;
  /** CSS custom property holding the status color. */
  colorVar: string;
}

export const STATUS_META: Record<StatusCode, StatusMeta> = {
  added: { label: "Added", letter: "A", colorVar: "--git-added" },
  modified: { label: "Modified", letter: "M", colorVar: "--git-modified" },
  deleted: { label: "Deleted", letter: "D", colorVar: "--git-deleted" },
  renamed: { label: "Renamed", letter: "R", colorVar: "--git-renamed" },
  copied: { label: "Copied", letter: "C", colorVar: "--git-renamed" },
  typeChanged: { label: "Type changed", letter: "T", colorVar: "--git-modified" },
  untracked: { label: "Untracked", letter: "U", colorVar: "--git-untracked" },
  conflicted: { label: "Conflicted", letter: "!", colorVar: "--git-conflict" },
};

export const CONFLICT_LABEL: Record<ConflictKind, string> = {
  bothDeleted: "Deleted on both sides",
  addedByUs: "Added by us",
  deletedByThem: "Deleted by them",
  addedByThem: "Added by them",
  deletedByUs: "Deleted by us",
  bothAdded: "Added on both sides",
  bothModified: "Modified on both sides",
};

function entry(change: FileChange, area: ChangeArea, status: StatusCode): ChangeEntry {
  return {
    id: `${area}:${change.path}`,
    area,
    path: change.path,
    originalPath: change.originalPath,
    status,
    conflict: change.conflict,
    isSubmodule: change.isSubmodule,
  };
}

/** Split Git's per-path status into the lists the UI shows. Order from Git is preserved. */
export function groupChanges(changes: FileChange[]): GroupedChanges {
  const groups: GroupedChanges = { conflicted: [], unstaged: [], staged: [] };
  for (const c of changes) {
    if (c.conflict) {
      groups.conflicted.push(entry(c, "conflicted", "conflicted"));
      continue;
    }
    if (c.worktreeStatus) groups.unstaged.push(entry(c, "unstaged", c.worktreeStatus));
    if (c.indexStatus) groups.staged.push(entry(c, "staged", c.indexStatus));
  }
  return groups;
}

export function filterGroups(groups: GroupedChanges, query: string): GroupedChanges {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const match = (e: ChangeEntry) =>
    e.path.toLowerCase().includes(q) || (e.originalPath?.toLowerCase().includes(q) ?? false);
  return {
    conflicted: groups.conflicted.filter(match),
    unstaged: groups.unstaged.filter(match),
    staged: groups.staged.filter(match),
  };
}
