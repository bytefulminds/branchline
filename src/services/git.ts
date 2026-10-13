import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DiffArea,
  FileDiff,
  GitError,
  GitVersion,
  LineRequest,
  RepositoryInfo,
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
