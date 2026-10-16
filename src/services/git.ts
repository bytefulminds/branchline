import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BranchList,
  CommitDetails,
  CommitDraft,
  DiffArea,
  FileDiff,
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
  pullBranch: (
    repo: string,
    mode: PullMode,
    opId: string,
    onProgress: (p: RemoteProgress) => void,
  ) => {
    ensureDesktop();
    return call<RemoteResult>("pull_branch", {
      repo,
      mode,
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
