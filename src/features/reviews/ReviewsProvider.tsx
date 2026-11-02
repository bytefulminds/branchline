import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { forgeService } from "../../services/forge";
import { readJson, writeJson } from "../../services/storage";
import type { GitError } from "../../types/git";
import type { Account, ReviewList, ReviewSource } from "../../types/forge";

const ALL_PROJECTS_KEY = "branchline.reviews.allProjects";

export type ReviewListState =
  | { status: "idle" }
  | { status: "loading"; previous: ReviewList | null }
  | { status: "ready"; list: ReviewList }
  | { status: "error"; error: GitError; previous: ReviewList | null };

export interface ReviewsState {
  /** Connected accounts (without tokens). */
  accounts: Account[];
  /** The GitLab project of the open repository, when it has one. */
  source: ReviewSource | null;
  /** The Reviews view is offered: the repository's host has a connected account. */
  available: boolean;
  allProjects: boolean;
  setAllProjects: (all: boolean) => void;
  list: ReviewListState;
  /** Load the list again (the Refresh button). */
  refresh: () => void;
  connectGitlab: (url: string, token: string) => Promise<Account>;
  disconnect: (url: string) => Promise<void>;
}

const noop = () => {};
const ReviewsContext = createContext<ReviewsState>({
  accounts: [],
  source: null,
  available: false,
  allProjects: false,
  setAllProjects: noop,
  list: { status: "idle" },
  refresh: noop,
  connectGitlab: () => Promise.reject(new Error("not available")),
  disconnect: () => Promise.resolve(),
});

export const useReviews = () => useContext(ReviewsContext);
export const ReviewsProvider = ReviewsContext.Provider;

/** Accounts, the open repository's GitLab project and the merge requests waiting for you.
 * The list loads when a repository with a connected account opens (for the count in the
 * sidebar) and when asked; it is not polled. */
export function useReviewsState(repoPath: string | null): ReviewsState {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [source, setSource] = useState<{ path: string; source: ReviewSource | null } | null>(null);
  const [allProjects, setAllProjectsState] = useState(
    () => readJson<unknown>(ALL_PROJECTS_KEY, false) === true,
  );
  // The latest answer, for the repository and scope it was asked for. Refresh asks again
  // with a new `round`; the shown state is derived from what was asked and what came back.
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    round: number;
    list?: ReviewList;
    error?: GitError;
  } | null>(null);

  const reloadAccounts = useCallback(() => {
    forgeService
      .accounts()
      .then((a) => setAccounts(a ?? []))
      .catch(() => setAccounts([]));
  }, []);
  useEffect(reloadAccounts, [reloadAccounts]);

  // The project depends on the repository's remotes and on which accounts are connected.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    forgeService
      .reviewSource(repoPath)
      .then((s) => !cancelled && setSource({ path: repoPath, source: s ?? null }))
      .catch(() => !cancelled && setSource({ path: repoPath, source: null }));
    return () => {
      cancelled = true;
    };
  }, [repoPath, accounts]);

  const current = repoPath && source?.path === repoPath ? source.source : null;
  const available = !!current?.account;

  const key = repoPath && available ? `${repoPath}\n${allProjects}` : null;
  useEffect(() => {
    if (!key || !repoPath) return;
    let cancelled = false;
    forgeService
      .reviewRequests(repoPath, allProjects)
      .then((list) => !cancelled && setResult({ key, round, list }))
      .catch(
        (error: GitError) =>
          !cancelled &&
          setResult((r) => ({ key, round, error, list: r?.key === key ? r.list : undefined })),
      );
    return () => {
      cancelled = true;
    };
  }, [key, round, repoPath, allProjects]);

  const same = !!key && result?.key === key;
  const previous = same ? (result.list ?? null) : null;
  const list: ReviewListState = !key
    ? { status: "idle" }
    : !same || result.round !== round
      ? { status: "loading", previous }
      : result.error
        ? { status: "error", error: result.error, previous }
        : { status: "ready", list: result.list! };

  const setAllProjects = useCallback((all: boolean) => {
    setAllProjectsState(all);
    writeJson(ALL_PROJECTS_KEY, all);
  }, []);

  const refresh = useCallback(() => setRound((n) => n + 1), []);

  const connectGitlab = useCallback(
    async (url: string, token: string) => {
      const account = await forgeService.connectGitlab(url, token);
      reloadAccounts();
      return account;
    },
    [reloadAccounts],
  );
  const disconnect = useCallback(
    async (url: string) => {
      await forgeService.disconnect(url);
      reloadAccounts();
    },
    [reloadAccounts],
  );

  return {
    accounts,
    source: current,
    available,
    allProjects,
    setAllProjects,
    list,
    refresh,
    connectGitlab,
    disconnect,
  };
}
