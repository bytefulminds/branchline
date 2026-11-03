/** Mirrors src-tauri/src/forge: accounts on hosting services and merge requests. */

import type { CommitFile } from "./git";

/** Supported services; GitHub and Bitbucket are planned. */
export type ForgeKind = "gitlab";

/** Which open requests to list. "allOpen" works for one project only. */
export type RequestFilter = "reviewRequested" | "createdByYou" | "allOpen";

/** What the token may do: read merge requests, also comment and approve, or unknown. */
export type Access = "read" | "write" | "unknown";

export interface Account {
  kind: ForgeKind;
  /** Server address, for example `https://gitlab.com`. */
  url: string;
  host: string;
  /** The user's id on the server (0 for accounts saved by an earlier version). */
  id: number;
  username: string;
  name: string;
  access: Access;
}

/** The project on a hosting service that the open repository belongs to. */
export interface ReviewSource {
  remote: string;
  host: string;
  /** `group/project`. */
  project: string;
  account: Account | null;
}

export interface Person {
  name: string;
  username: string;
}

export interface MergeRequest {
  projectId: number;
  projectPath: string;
  iid: number;
  title: string;
  webUrl: string;
  author: Person;
  reviewers: Person[];
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  comments: number;
  /** `success`, `failed`, `running`, `pending`, `canceled`, ... */
  pipeline: string | null;
  approvedByYou: boolean | null;
  hasConflicts: boolean;
}

export interface ReviewList {
  account: Account;
  /** The project searched, or null for all projects. */
  project: string | null;
  items: MergeRequest[];
  truncated: boolean;
}

export interface RequestCommit {
  oid: string;
  title: string;
  authorName: string;
  /** ISO 8601. */
  createdAt: string;
}

/** Where a thread sits in the diff: a line on the new side, or for a removed line only on
 * the old side. */
export interface NotePosition {
  path: string;
  oldPath: string | null;
  oldLine: number | null;
  newLine: number | null;
  /** Made on an older version, so its line may not match the diff shown. */
  outdated: boolean;
}

export interface Note {
  author: Person;
  /** Markdown as written. */
  body: string;
  createdAt: string;
}

/** A comment thread on a line of the diff (position) or on the merge request as a whole. */
export interface Thread {
  id: string;
  position: NotePosition | null;
  /** null when the thread cannot be resolved (a plain comment). */
  resolved: boolean | null;
  notes: Note[];
}

/** A merge request opened for reading: the diff is `base` to `head`, computed locally. */
export interface RequestDetail {
  request: MergeRequest;
  description: string;
  base: string;
  head: string;
  commits: RequestCommit[];
  threads: Thread[];
  files: CommitFile[];
}
