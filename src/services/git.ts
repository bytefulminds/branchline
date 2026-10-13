import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GitError, GitVersion, RepositoryInfo } from "../types/git";

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
  /** Path given on the command line (`branchline <path>`), or null. */
  launchRepositoryPath: () => call<string | null>("launch_repository_path"),
};
