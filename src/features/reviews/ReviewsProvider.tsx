import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { forgeService } from "../../services/forge";
import { readJson, writeJson } from "../../services/storage";
import type { GitError } from "../../types/git";
import type {
  Account,
  ForgeKind,
  RequestFilter,
  ReviewList,
  ReviewSource,
} from "../../types/forge";
import { useSettings } from "../settings/SettingsProvider";

const ALL_PROJECTS_KEY = "branchline.reviews.allProjects";
const FILTER_KEY = "branchline.reviews.filter";
const FILTERS: RequestFilter[] = ["reviewRequested", "createdByYou", "allOpen"];
/** Refreshing when the window gets focus happens at most this often. */
const FOCUS_REFRESH_MS = 30_000;

export type ReviewListState =
  | { status: "idle" }
  | { status: "loading"; previous: ReviewList | null }
  | { status: "ready"; list: ReviewList }
  | { status: "error"; error: GitError; previous: ReviewList | null };

export interface ReviewsState {
  /** Connected accounts (without tokens). */
  accounts: Account[];
  /** The hosting service project of the open repository, when it has one. */
  source: ReviewSource | null;
  /** The Reviews view is offered: an account is connected. */
  available: boolean;
  /** The repository has a remote on a connected account's server, so its own project can be
   * listed and its merge requests opened in Branchline. Otherwise all projects are listed. */
  matched: boolean;
  allProjects: boolean;
  setAllProjects: (all: boolean) => void;
  filter: RequestFilter;
  setFilter: (filter: RequestFilter) => void;
  /** The list shown in the Reviews view. */
  list: ReviewListState;
  /** How many wait for your review (the sidebar count), when known. */
  toReview: number | null;
  /** Load the lists again (the Refresh button). */
  refresh: () => void;
  connect: (kind: ForgeKind, url: string, token: string) => Promise<Account>;
  disconnect: (kind: ForgeKind, url: string) => Promise<void>;
}

const noop = () => {};
const ReviewsContext = createContext<ReviewsState>({
  accounts: [],
  source: null,
  available: false,
  matched: false,
  allProjects: false,
  setAllProjects: noop,
  filter: "reviewRequested",
  setFilter: noop,
  list: { status: "idle" },
  toReview: null,
  refresh: noop,
  connect: () => Promise.reject(new Error("not available")),
  disconnect: () => Promise.resolve(),
});

export const useReviews = () => useContext(ReviewsContext);
export const ReviewsProvider = ReviewsContext.Provider;

/** One list from the server, asked again when its key or `round` changes. The shown state
 * is derived from what was asked and what came back, so no state is set during render or
 * directly in the effect. */
function useRequestList(
  repoPath: string | null,
  enabled: boolean,
  allProjects: boolean,
  filter: RequestFilter,
  round: number,
): ReviewListState {
  const [result, setResult] = useState<{
    key: string;
    round: number;
    list?: ReviewList;
    error?: GitError;
  } | null>(null);
  const key = repoPath && enabled ? `${repoPath}\n${allProjects}\n${filter}` : null;

  useEffect(() => {
    if (!key || !repoPath) return;
    let cancelled = false;
    forgeService
      .reviewRequests(repoPath, allProjects, filter)
      .then((list) => !cancelled && setResult({ key, round, list }))
      .catch(
        (error: GitError) =>
          !cancelled &&
          setResult((r) => ({ key, round, error, list: r?.key === key ? r.list : undefined })),
      );
    return () => {
      cancelled = true;
    };
  }, [key, round, repoPath, allProjects, filter]);

  const same = !!key && result?.key === key;
  const previous = same ? (result.list ?? null) : null;
  return !key
    ? { status: "idle" }
    : !same || result.round !== round
      ? { status: "loading", previous }
      : result.error
        ? { status: "error", error: result.error, previous }
        : { status: "ready", list: result.list! };
}

/** Accounts, the open repository's project on its hosting service and its open merge
 * requests. The lists load when a repository with a connected account opens, with Refresh,
 * and (like the rest of Branchline, if that setting is on) when the window gets focus. */
export function useReviewsState(repoPath: string | null): ReviewsState {
  const { settings } = useSettings();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [source, setSource] = useState<{ path: string; source: ReviewSource | null } | null>(null);
  const [allProjects, setAllProjectsState] = useState(
    () => readJson<unknown>(ALL_PROJECTS_KEY, false) === true,
  );
  const [filter, setFilterState] = useState<RequestFilter>(() => {
    const saved = readJson<unknown>(FILTER_KEY, "reviewRequested");
    return FILTERS.includes(saved as RequestFilter) ? (saved as RequestFilter) : "reviewRequested";
  });
  const [round, setRound] = useState(0);
  const lastRound = useRef(0);

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
  const matched = !!current?.account;
  // Shown once the repository's remotes are known, so the first list is the right one.
  const available = accounts.length > 0 && source?.path === repoPath;
  // Without the repository's own project, "All open" (one project only) is not offered.
  const shownFilter: RequestFilter = !matched && filter === "allOpen" ? "reviewRequested" : filter;
  const scopeAll = !matched || (allProjects && shownFilter !== "allOpen");

  const list = useRequestList(repoPath, available, scopeAll, shownFilter, round);
  // The sidebar counts what waits for your review; reuse the list when it is that one.
  const badge = useRequestList(
    repoPath,
    available && shownFilter !== "reviewRequested",
    !matched || allProjects,
    "reviewRequested",
    round,
  );
  const counted = shownFilter === "reviewRequested" ? list : badge;
  const toReview = counted.status === "ready" ? counted.list.items.length : null;

  const refresh = useCallback(() => {
    lastRound.current = Date.now();
    setRound((n) => n + 1);
  }, []);

  const onFocusRefresh = settings.general.refreshOnFocus;
  useEffect(() => {
    if (!available || !onFocusRefresh) return;
    lastRound.current = Date.now();
    const onFocus = () => {
      if (Date.now() - lastRound.current >= FOCUS_REFRESH_MS) refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [available, onFocusRefresh, refresh]);

  const setAllProjects = useCallback((all: boolean) => {
    setAllProjectsState(all);
    writeJson(ALL_PROJECTS_KEY, all);
  }, []);
  const setFilter = useCallback((f: RequestFilter) => {
    setFilterState(f);
    writeJson(FILTER_KEY, f);
  }, []);

  const connect = useCallback(
    async (kind: ForgeKind, url: string, token: string) => {
      const account = await forgeService.connect(kind, url, token);
      reloadAccounts();
      return account;
    },
    [reloadAccounts],
  );
  const disconnect = useCallback(
    async (kind: ForgeKind, url: string) => {
      await forgeService.disconnect(kind, url);
      reloadAccounts();
    },
    [reloadAccounts],
  );

  return {
    accounts,
    source: current,
    available,
    matched,
    allProjects: scopeAll,
    setAllProjects,
    filter: shownFilter,
    setFilter,
    list,
    toReview,
    refresh,
    connect,
    disconnect,
  };
}
