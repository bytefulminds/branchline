import { useEffect, useRef, useState } from "react";
import { gitService } from "../../services/git";
import type { BranchList, GitError, RepositoryInfo } from "../../types/git";

/**
 * Branch list for the open repository. Reloads only when a ref or HEAD moves
 * (and the working tree state, which changes ahead/behind after a commit).
 */
export function useBranches(repo: RepositoryInfo | null): {
  branches: BranchList | null;
  error: GitError | null;
} {
  const key = repo
    ? `${repo.path}|${repo.refsFingerprint}|${repo.head.kind === "unborn" ? "" : repo.head.oid}|${repo.head.kind}`
    : null;
  const [state, setState] = useState<{
    key: string;
    branches: BranchList | null;
    error: GitError | null;
  } | null>(null);
  const latest = useRef(key);

  useEffect(() => {
    latest.current = key;
    if (!key || !repo) return;
    gitService
      .listBranches(repo.path)
      .then((branches) => latest.current === key && setState({ key, branches, error: null }))
      .catch(
        (error: GitError) => latest.current === key && setState({ key, branches: null, error }),
      );
    // repo.path is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return { branches: null, error: null };
  // Keep showing the previous list while the next one loads.
  return { branches: state?.branches ?? null, error: state?.key === key ? state.error : null };
}
