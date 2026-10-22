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
  stashCount: number;
  /** Git holds uncommitted changes (autostash) until the operation in progress ends. */
  heldChanges: boolean;
  /** Rebase progress while a rebase is in progress. */
  operationProgress: OperationProgress | null;
  /** Changes whenever a stash is added or removed. */
  stashFingerprint: string;
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
  | "invalidBranchName"
  | "checkoutConflict"
  | "notMerged"
  | "invalidTagName"
  | "tagConflict"
  | "cancelled"
  | "authFailed"
  | "hostKeyUnverified"
  | "networkFailed"
  | "remoteNotFound"
  | "pushRejected"
  | "staleLease"
  | "remoteRejected"
  | "noUpstream"
  | "diverged"
  /** `detail` is the folder of the worktree that has the branch checked out. */
  | "branchInWorktree"
  /** `detail` is the worktree folder. */
  | "worktreeDirty"
  /** A remote name or address that cannot be used; `message` says why. */
  | "invalidRemote"
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

/** Narrows the history; empty fields do not filter and all set fields must match. */
export interface LogFilter {
  /** Message, author name or email, or the start of a commit id (not a pattern). */
  text: string;
  author: string;
  /** A file or folder, relative to the repository. */
  path: string;
  /** `YYYY-MM-DD`, inclusive. */
  since: string;
  until: string;
  /** Only commits reachable from HEAD. */
  currentBranch: boolean;
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

export interface BranchInfo {
  /** `main`, or `origin/main` for remote branches. */
  name: string;
  remote: string | null;
  oid: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  tipTime: number;
  tipSummary: string;
  /** Folder of another worktree where this local branch is checked out. */
  worktreePath?: string | null;
}

export interface WorktreeInfo {
  path: string;
  /** Folder name. */
  name: string;
  head: string | null;
  /** Checked-out branch; null when detached. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Set when locked; the reason may be empty. */
  locked: string | null;
  /** Set when the folder is gone. */
  prunable: string | null;
  isMain: boolean;
  /** Open in Branchline right now. */
  isCurrent: boolean;
  changes: number | null;
}

export type WorktreeTarget =
  | { kind: "newBranch"; name: string; start: StartPoint }
  | { kind: "branch"; name: string }
  | { kind: "detached"; start: StartPoint };

export interface BranchList {
  local: BranchInfo[];
  remote: BranchInfo[];
}

export type StartPoint =
  { kind: "head" } | { kind: "commit"; oid: string } | { kind: "branch"; name: string };

/** A configured remote. URLs never contain credentials. */
export interface RemoteInfo {
  name: string;
  url: string;
  /** Push URL when it differs from `url`. */
  pushUrl: string | null;
}

/** One progress update of a fetch, pull or push. */
export interface RemoteProgress {
  /** For example "Receiving objects". */
  phase: string;
  percent: number | null;
  /** For example "450/1000, 1.20 MiB | 2.00 MiB/s". */
  detail: string | null;
}

export type PullMode = "fastForward" | "merge" | "rebase";

export interface PushRequest {
  branch: string;
  /** Null pushes to the branch's upstream. */
  remote: string | null;
  setUpstream: boolean;
  /** Force with lease. */
  force: boolean;
}

export interface RemoteOutcome {
  updatedRefs: number;
  conflicts: boolean;
  upToDate: boolean;
  /** "origin" for a fetch, "origin/main" for a pull or push. */
  target: string | null;
  /** Pull with autostash: local changes conflicted and are kept in the stash list. */
  stashKept: boolean;
}

export interface RemoteResult {
  outcome: RemoteOutcome;
  repo: RepositoryInfo;
}

export interface StashInfo {
  /** Position in the list (`stash@{index}`); 0 is the newest. */
  index: number;
  oid: string;
  message: string;
  /** Branch it was made on; null for a detached HEAD. */
  branch: string | null;
  /** Git generated the message; the user gave none. */
  autoMessage: boolean;
  /** Seconds since the Unix epoch. */
  time: number;
  /** Commit with the untracked files, when included. */
  untrackedOid: string | null;
}

export interface StashOutcome {
  conflicts: boolean;
  /** Pop with conflicts keeps the stash. */
  kept: boolean;
}

export interface StashResult {
  outcome: StashOutcome;
  repo: RepositoryInfo;
}

export interface TagInfo {
  name: string;
  /** Commit the tag points at (annotated tags are peeled). */
  target: string;
  /** False for the rare tags that point at a tree or blob. */
  isCommit: boolean;
  annotated: boolean;
  /** Annotated: first line of the tag message. Lightweight: subject of the commit. */
  subject: string;
  tagger: string | null;
  /** Seconds since the Unix epoch. */
  time: number;
}

export interface OperationProgress {
  step: number;
  total: number;
  /** Branch being rebased. */
  branch: string | null;
}

export interface IntegrateOutcome {
  /** Stopped with conflicts; continue or abort from the banner. */
  conflicts: boolean;
  upToDate: boolean;
  fastForward: boolean;
  /** Commits left out of a cherry-pick because their changes were already on the branch. */
  skipped?: number;
}

export type ChangeSide = "ours" | "theirs" | "both" | "conflict";

/** A run of lines in the three-way view; lines keep their line endings. */
export type MergeSegment =
  | { kind: "same"; lines: string[] }
  | { kind: "change"; change: ChangeSide; base: string[]; ours: string[]; theirs: string[] };

export interface ConflictSide {
  /** Short name: a branch, "commit abc1234" or "Stashed changes". */
  label: string;
  /** What this side is, for example "Current branch". */
  role: string;
  commit: { oid: string; summary: string } | null;
  /** False when this side deleted the file. */
  exists: boolean;
}

export interface ConflictFile {
  path: string;
  conflict: ConflictKind;
  ours: ConflictSide;
  theirs: ConflictSide;
  baseExists: boolean;
  /** Null when only whole-file choices are possible (see `unmergeable`). */
  segments: MergeSegment[] | null;
  unmergeable: string | null;
  fingerprint: string;
}

export type ResolveSide = "ours" | "theirs" | "delete";

export interface IntegrateResult {
  outcome: IntegrateOutcome;
  repo: RepositoryInfo;
}

export type OperationStep = "continue" | "skip" | "abort";

/** A commit in an interactive rebase plan. */
export interface PlanCommit {
  oid: string;
  summary: string;
  message: string;
  authorName: string;
  /** Seconds since the Unix epoch. */
  authorTime: number;
}

export type PlanAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface PlanStep {
  oid: string;
  action: PlanAction;
  /** New message for `reword`. */
  message?: string | null;
}
