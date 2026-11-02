/** Mirrors src-tauri/src/forge: accounts on hosting services and merge requests. */

export type ForgeKind = "gitlab";

/** What the token may do: read merge requests, also comment and approve, or unknown. */
export type Access = "read" | "write" | "unknown";

export interface Account {
  kind: ForgeKind;
  /** Server address, for example `https://gitlab.com`. */
  url: string;
  host: string;
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
