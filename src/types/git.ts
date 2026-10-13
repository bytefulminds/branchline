/**
 * IPC contract with the Rust backend (src-tauri/src/git, src-tauri/src/error.rs).
 * Field names mirror the serde camelCase output; keep both sides in sync.
 */

export type ChangeKind =
  "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged" | "untracked";

export type ConflictKind =
  | "bothDeleted"
  | "addedByUs"
  | "deletedByThem"
  | "addedByThem"
  | "deletedByUs"
  | "bothAdded"
  | "bothModified";

export interface FileChange {
  path: string;
  originalPath: string | null;
  indexStatus: ChangeKind | null;
  worktreeStatus: ChangeKind | null;
  conflict: ConflictKind | null;
  isSubmodule: boolean;
}

export type HeadState =
  | { kind: "branch"; name: string; oid: string }
  | { kind: "detached"; oid: string }
  | { kind: "unborn"; name: string };

export interface UpstreamInfo {
  name: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface CommitSummary {
  oid: string;
  shortOid: string;
  summary: string;
  authorName: string;
  authorDate: string;
}

export type RepoOperation = "merge" | "rebase" | "cherryPick" | "revert" | "bisect";

export interface RepositoryInfo {
  path: string;
  name: string;
  gitDir: string;
  head: HeadState;
  upstream: UpstreamInfo | null;
  headCommit: CommitSummary | null;
  operation: RepoOperation | null;
  changes: FileChange[];
  totalChanges: number;
  truncated: boolean;
  inspectedAt: number;
  durationMs: number;
}

export interface GitVersion {
  version: string;
  major: number;
  minor: number;
  path: string;
}

export type GitErrorKind =
  | "emptyPath"
  | "pathNotFound"
  | "notADirectory"
  | "relativePath"
  | "notARepository"
  | "bareRepository"
  | "insideGitDir"
  | "unsafeRepository"
  | "gitNotFound"
  | "gitTooOld"
  | "timeout"
  | "gitFailed"
  | "parse"
  | "internal"
  /** Frontend-only: the app is not running inside the Tauri shell. */
  | "notDesktop";

export interface GitError {
  kind: GitErrorKind;
  message: string;
  detail: string | null;
}
