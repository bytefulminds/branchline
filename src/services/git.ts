import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BranchList,
  CommitDetails,
  CommitDraft,
  DiffArea,
  FileDiff,
  IntegrateResult,
  OperationStep,
  PlanCommit,
  PlanStep,
  GitError,
  GitVersion,
  LineRequest,
  LogPage,
  PullMode,
  PushRequest,
  RefInfo,
  RemoteInfo,
  RemoteProgress,
  RemoteResult,
  StashInfo,
  StashResult,
  TagInfo,
  RepositoryInfo,
  StartPoint,
} from "../types/git";

/** Normalize anything thrown by `invoke` into the backend's error shape. */
export function toGitError(err: unknown): GitError {
  if (err && typeof err === "object" && "kind" in err && "message" in err) {
    const e = err as Partial<GitError>;
    return {
      kind: (e.kind ?? "internal") as GitError["kind"],
      message: String(e.message),
      detail: e.detail ?? null,
    };
  }
  return {
    kind: "internal",
    message: err instanceof Error ? err.message : String(err),
    detail: null,
  };
}

function ensureDesktop() {
  if (!isTauri()) {
    const error: GitError = {
      kind: "notDesktop",
      message: "Branchline needs its desktop shell to access Git. Start it with `npm run app:dev`.",
      detail: null,
    };
    throw error;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toGitError(err);
  }
}

function progressChannel(onProgress: (p: RemoteProgress) => void): Channel<RemoteProgress> {
  const channel = new Channel<RemoteProgress>();
  channel.onmessage = onProgress;
  return channel;
}

export const gitService = {
  version: () => call<GitVersion>("git_version"),
  inspectRepository: (path: string) => call<RepositoryInfo>("inspect_repository", { path }),
  fileDiff: (
    repo: string,
    path: string,
    originalPath: string | null,
    area: DiffArea,
    force = false,
  ) => call<FileDiff>("file_diff", { repo, path, originalPath, area, force }),
  stageFiles: (repo: string, paths: string[]) =>
    call<RepositoryInfo>("stage_files", { repo, paths }),
  unstageFiles: (repo: string, paths: string[]) =>
    call<RepositoryInfo>("unstage_files", { repo, paths }),
  discardFiles: (repo: string, paths: string[]) =>
    call<RepositoryInfo>("discard_files", { repo, paths }),
  applyLines: (repo: string, request: LineRequest) =>
    call<RepositoryInfo>("apply_lines", { repo, request }),
  logPage: (repo: string, skip: number, limit: number) =>
    call<LogPage>("log_page", { repo, skip, limit }),
  listRefs: (repo: string) => call<RefInfo[]>("list_refs", { repo }),
  commitDetails: (repo: string, oid: string) =>
    call<CommitDetails>("commit_details", { repo, oid }),
  commitFileDiff: (
    repo: string,
    oid: string,
    path: string,
    originalPath: string | null,
    force = false,
  ) => call<FileDiff>("commit_file_diff", { repo, oid, path, originalPath, force }),
  commitDraft: (repo: string) => call<CommitDraft>("commit_draft", { repo }),
  createCommit: (repo: string, message: string, amend: boolean) =>
    call<RepositoryInfo>("create_commit", { repo, request: { message, amend } }),
  listBranches: (repo: string) => call<BranchList>("list_branches", { repo }),
  /** Resolves to a reason the name is invalid, or null when it is fine. */
  checkBranchName: (repo: string, name: string) =>
    call<string | null>("check_branch_name", { repo, name }),
  createBranch: (repo: string, name: string, start: StartPoint, checkout: boolean) =>
    call<RepositoryInfo>("create_branch", { repo, name, start, checkout }),
  switchBranch: (repo: string, name: string) =>
    call<RepositoryInfo>("switch_branch", { repo, name }),
  checkoutRemoteBranch: (repo: string, remoteBranch: string) =>
    call<RepositoryInfo>("checkout_remote_branch", { repo, remoteBranch }),
  checkoutDetached: (repo: string, oid: string) =>
    call<RepositoryInfo>("checkout_detached", { repo, oid }),
  renameBranch: (repo: string, old: string, newName: string) =>
    call<RepositoryInfo>("rename_branch", { repo, old, new: newName }),
  deleteBranch: (repo: string, name: string, force: boolean) =>
    call<RepositoryInfo>("delete_branch", { repo, name, force }),
  listRemotes: (repo: string) => call<RemoteInfo[]>("list_remotes", { repo }),
  /** Fetch `remote`, or every remote when null. `opId` identifies it for `cancelRemote`. */
  fetchRemote: (
    repo: string,
    remote: string | null,
    opId: string,
    onProgress: (p: RemoteProgress) => void,
  ) => {
    ensureDesktop();
    return call<RemoteResult>("fetch_remote", {
      repo,
      remote,
      opId,
      onProgress: progressChannel(onProgress),
    });
  },
  /** `autostash` stashes local changes first and reapplies them after the pull. */
  pullBranch: (
    repo: string,
    mode: PullMode,
    autostash: boolean,
    opId: string,
    onProgress: (p: RemoteProgress) => void,
  ) => {
    ensureDesktop();
    return call<RemoteResult>("pull_branch", {
      repo,
      mode,
      autostash,
      opId,
      onProgress: progressChannel(onProgress),
    });
  },
  pushBranch: (
    repo: string,
    request: PushRequest,
    opId: string,
    onProgress: (p: RemoteProgress) => void,
  ) => {
    ensureDesktop();
    return call<RemoteResult>("push_branch", {
      repo,
      request,
      opId,
      onProgress: progressChannel(onProgress),
    });
  },
  listStashes: (repo: string) => call<StashInfo[]>("list_stashes", { repo }),
  saveStash: (repo: string, message: string, includeUntracked: boolean) =>
    call<RepositoryInfo>("save_stash", { repo, message, includeUntracked }),
  /** `oid` must still be at `index`, otherwise the call fails with `stale`. */
  applyStash: (repo: string, stash: { index: number; oid: string }, pop: boolean) =>
    call<StashResult>("apply_stash", { repo, index: stash.index, oid: stash.oid, pop }),
  dropStash: (repo: string, stash: { index: number; oid: string }) =>
    call<RepositoryInfo>("drop_stash", { repo, index: stash.index, oid: stash.oid }),
  listTags: (repo: string) => call<TagInfo[]>("list_tags", { repo }),
  /** Resolves to why the name cannot be used, or null. */
  checkTagName: (repo: string, name: string) =>
    call<string | null>("check_tag_name", { repo, name }),
  /** A non-empty message creates an annotated tag. */
  createTag: (repo: string, name: string, target: string, message: string) =>
    call<RepositoryInfo>("create_tag", { repo, name, target, message }),
  deleteTag: (repo: string, name: string) => call<RepositoryInfo>("delete_tag", { repo, name }),
  /** Push `name` to `remote`, or delete it there. */
  pushTag: (
    repo: string,
    name: string,
    remote: string,
    remove: boolean,
    opId: string,
    onProgress: (p: RemoteProgress) => void,
  ) => {
    ensureDesktop();
    return call<RemoteResult>("push_tag", {
      repo,
      name,
      remote,
      delete: remove,
      opId,
      onProgress: progressChannel(onProgress),
    });
  },
  /** Merge a branch or commit into the current branch. */
  mergeIntoCurrent: (
    repo: string,
    source: StartPoint,
    options: { noFf: boolean; autostash: boolean },
  ) => call<IntegrateResult>("merge_into_current", { repo, request: { source, ...options } }),
  rebaseCurrent: (repo: string, onto: StartPoint, autostash: boolean) =>
    call<IntegrateResult>("rebase_current", { repo, onto, autostash }),
  cherryPick: (repo: string, oid: string) => call<IntegrateResult>("cherry_pick", { repo, oid }),
  /** Cherry-pick several commits in the order given (oldest first). */
  cherryPickMany: (repo: string, oids: string[]) =>
    call<IntegrateResult>("cherry_pick_many", { repo, oids }),
  revertCommit: (repo: string, oid: string) =>
    call<IntegrateResult>("revert_commit", { repo, oid }),
  /** Commits after `base` on the current branch, oldest first. */
  rebasePlanCommits: (repo: string, base: string) =>
    call<PlanCommit[]>("rebase_plan_commits", { repo, base }),
  /** Rewrite the commits after `base`; `plan` is oldest first and names every commit once. */
  interactiveRebase: (repo: string, base: string, plan: PlanStep[], autostash: boolean) =>
    call<IntegrateResult>("interactive_rebase", { repo, base, plan, autostash }),
  /** Continue, skip or abort the merge, rebase, cherry-pick or revert in progress. */
  operationStep: (repo: string, step: OperationStep) =>
    call<IntegrateResult>("operation_step", { repo, step }),
  cancelRemote: (opId: string) => call<void>("cancel_remote_operation", { opId }),
  watchRepository: (repo: string) => call<void>("watch_repository", { repo }),
  unwatchRepository: () => call<void>("unwatch_repository"),
  /** Subscribe to file-system changes of the watched repository. */
  onRepositoryChanged: async (handler: (repo: string) => void): Promise<UnlistenFn> => {
    if (!isTauri()) return () => {};
    return listen<{ repo: string }>("repository-changed", (e) => handler(e.payload.repo));
  },
  /** Path given on the command line (`branchline <path>`), or null. */
  launchRepositoryPath: () => call<string | null>("launch_repository_path"),
};
