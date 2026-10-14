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
  /** Changes when any branch, remote branch or tag moves. */
  refsFingerprint: string;
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
  | "locked"
  | "outputTooLarge"
  | "invalidPath"
  | "stale"
  | "unsupported"
  | "applyFailed"
  | "identityMissing"
  | "commitFailed"
  | "parse"
  | "internal"
  /** Frontend-only: the app is not running inside the Tauri shell. */
  | "notDesktop";

export interface GitError {
  kind: GitErrorKind;
  message: string;
  detail: string | null;
}

export type DiffArea = "unstaged" | "staged" | "untracked" | "conflicted" | "commit";
export type LineKind = "context" | "add" | "delete";

export interface DiffLine {
  kind: LineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
  crlf: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  originalPath: string | null;
  area: DiffArea;
  hunks: DiffHunk[];
  isBinary: boolean;
  tooLarge: boolean;
  sizeBytes: number;
  additions: number;
  deletions: number;
  oldMode: string | null;
  newMode: string | null;
  change: "new" | "deleted" | "renamed" | "copied" | null;
  supportsPartial: boolean;
  hasConflictMarkers: boolean;
  fingerprint: string;
}

export type LineAction = "stage" | "unstage" | "discard";

export interface HunkSelection {
  hunk: number;
  /** Indices into the hunk's lines; null selects every change line of the hunk. */
  lines: number[] | null;
}

export interface LineRequest {
  path: string;
  action: LineAction;
  fingerprint: string;
  selections: HunkSelection[];
}

export interface LogCommit {
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Seconds since the Unix epoch. */
  authorTime: number;
  summary: string;
}

export interface LogPage {
  commits: LogCommit[];
  hasMore: boolean;
  total: number;
}

export type RefKind = "branch" | "remote" | "tag";

export interface RefInfo {
  name: string;
  kind: RefKind;
  oid: string;
}

export interface CommitFile {
  path: string;
  originalPath: string | null;
  status: "A" | "M" | "D" | "R" | "C" | "T" | string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetails {
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
  files: CommitFile[];
}

export interface Identity {
  name: string;
  email: string;
}

export interface CommitDraft {
  author: Identity | null;
  headMessage: string | null;
  preparedMessage: string | null;
  canAmend: boolean;
}
