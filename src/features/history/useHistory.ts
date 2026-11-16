import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitService } from "../../services/git";
import type { GitError, LogCommit, LogFilter, RefInfo, RepositoryInfo } from "../../types/git";
import { historyGraph, TRUNK_SEGMENT, type GraphRow } from "./graph";

export const PAGE_SIZE = 300;
/** Most commits the backend returns in one page. */
const MAX_PAGE = 2000;

export const EMPTY_FILTER: LogFilter = {
  text: "",
  author: "",
  path: "",
  since: "",
  until: "",
  currentBranch: false,
};

/** True when the filter narrows the history at all. */
export function isFiltering(filter: LogFilter): boolean {
  return (
    filter.text.trim() !== "" ||
    filter.author.trim() !== "" ||
    filter.path.trim() !== "" ||
    filter.since !== "" ||
    filter.until !== "" ||
    filter.currentBranch
  );
}

/**
 * Search results skip commits, so lines between them would connect commits that are not
 * parent and child. They are shown as plain dots instead; merge and root markers stay.
 */
function layoutResults(commits: LogCommit[]): GraphRow[] {
  return commits.map((c) => ({
    lane: 0,
    color: 0,
    lines: [],
    width: 1,
    isMerge: c.parents.length > 1,
    isRoot: c.parents.length === 0,
    segment: TRUNK_SEGMENT,
    trunk: false,
    mergedBy: null,
  }));
}

export interface HistoryData {
  key: string;
  /** The list holds search results, not the whole history. */
  filtered: boolean;
  /** The commits shown: without those of collapsed side branches. */
  commits: LogCommit[];
  rows: GraphRow[];
  /** Merges with merged side branches: how many commits those hold, and if they are shown. */
  folds: Map<string, { count: number; expanded: boolean }>;
  /** Commits hidden in collapsed side branches: the merges to expand to show them. */
  hiddenBy: Map<string, string[]>;
  refsByOid: Map<string, RefInfo[]>;
  total: number;
  hasMore: boolean;
}

/** How the graph shows merged side branches. */
export interface GraphView {
  /** Leave out the commits of merged side branches that no branch points to. */
  collapse: boolean;
  /** Merges whose side branches are shown anyway. */
  expanded: ReadonlySet<string>;
}

const NO_FOLDS: GraphView = { collapse: false, expanded: new Set() };

/** Loaded pages, before the graph is laid out. */
interface Loaded {
  key: string;
  filtered: boolean;
  commits: LogCommit[];
  refs: RefInfo[];
  total: number;
  hasMore: boolean;
}

export interface HistoryController {
  data: HistoryData | null;
  loading: boolean;
  loadingMore: boolean;
  error: GitError | null;
  loadMore: () => void;
  /**
   * Loads the full history up to a commit (and a few beyond it). Resolves false when the
   * commit is not part of the history.
   */
  loadThrough: (oid: string) => Promise<boolean>;
}

function headOid(repo: RepositoryInfo): string {
  return repo.head.kind === "unborn" ? "" : repo.head.oid;
}

function groupRefs(refs: RefInfo[]): Map<string, RefInfo[]> {
  const map = new Map<string, RefInfo[]>();
  for (const r of refs) {
    const list = map.get(r.oid);
    if (list) list.push(r);
    else map.set(r.oid, [r]);
  }
  return map;
}

/**
 * Loads history page by page and lays out the graph incrementally. Reloads
 * only when a ref or HEAD moves, not on every working-tree refresh.
 */
export function useHistory(
  repo: RepositoryInfo,
  filter: LogFilter = EMPTY_FILTER,
  view: GraphView = NO_FOLDS,
): HistoryController {
  const filtered = isFiltering(filter);
  const filterKey = filtered ? JSON.stringify(filter) : "";
  const key = `${repo.path}|${repo.refsFingerprint}|${headOid(repo)}|${filterKey}`;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ key: string; error: GitError } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestKey = useRef(key);
  const moreInFlight = useRef(false);

  useEffect(() => {
    requestKey.current = key;
    moreInFlight.current = false;
    const path = repo.path;
    const applied = filterKey ? (JSON.parse(filterKey) as LogFilter) : null;
    Promise.all([gitService.logPage(path, 0, PAGE_SIZE, applied), gitService.listRefs(path)])
      .then(([page, refs]) => {
        if (requestKey.current !== key) return;
        setData({
          key,
          filtered: !!applied,
          commits: page.commits,
          refs,
          total: page.total,
          hasMore: page.hasMore,
        });
        setError(null);
      })
      .catch((e: GitError) => {
        if (requestKey.current === key) setError({ key, error: e });
      });
  }, [key, repo.path, filterKey]);

  const loadMore = useCallback(() => {
    if (!data || data.key !== key || !data.hasMore || moreInFlight.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    gitService
      .logPage(
        repo.path,
        data.commits.length,
        PAGE_SIZE,
        filterKey ? (JSON.parse(filterKey) as LogFilter) : null,
      )
      .then((page) => {
        if (requestKey.current !== key) return;
        setData((prev) => {
          if (!prev || prev.key !== key) return prev;
          return {
            ...prev,
            commits: [...prev.commits, ...page.commits],
            total: page.total,
            hasMore: page.hasMore,
          };
        });
      })
      .catch((e: GitError) => {
        if (requestKey.current === key) setError({ key, error: e });
      })
      .finally(() => {
        moreInFlight.current = false;
        setLoadingMore(false);
      });
  }, [data, key, repo.path, filterKey]);

  const loadThrough = useCallback(
    async (oid: string) => {
      if (!data || data.key !== key || data.filtered) return true;
      if (data.commits.some((c) => c.oid === oid)) return true;
      // A page is loading: the caller tries again when it is there.
      if (moreInFlight.current) return true;
      moreInFlight.current = true;
      setLoadingMore(true);
      try {
        const at = await gitService.historyPosition(repo.path, oid);
        if (at === null) return false;
        const from = data.commits.length;
        const added: LogCommit[] = [];
        let page = null;
        while (from + added.length <= at) {
          page = await gitService.logPage(
            repo.path,
            from + added.length,
            Math.min(MAX_PAGE, at + PAGE_SIZE - from - added.length),
            null,
          );
          if (requestKey.current !== key) return true;
          added.push(...page.commits);
          if (!page.hasMore || page.commits.length === 0) break;
        }
        const last = page;
        if (last)
          setData((prev) =>
            prev && prev.key === key && prev.commits.length === from
              ? {
                  ...prev,
                  commits: [...prev.commits, ...added],
                  total: last.total,
                  hasMore: last.hasMore,
                }
              : prev,
          );
        return true;
      } catch (e) {
        if (requestKey.current === key) setError({ key, error: e as GitError });
        return false;
      } finally {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    },
    [data, key, repo.path],
  );

  const { collapse, expanded } = view;
  const shown = useMemo<HistoryData | null>(() => {
    if (!data) return null;
    const graph = data.filtered
      ? {
          commits: data.commits,
          rows: layoutResults(data.commits),
          folds: new Map(),
          hiddenBy: new Map(),
        }
      : historyGraph(data.commits, data.refs, collapse, expanded);
    return {
      key: data.key,
      filtered: data.filtered,
      commits: graph.commits,
      rows: graph.rows,
      folds: graph.folds,
      hiddenBy: graph.hiddenBy,
      refsByOid: groupRefs(data.refs),
      total: data.total,
      hasMore: data.hasMore,
    };
  }, [data, collapse, expanded]);

  const current = shown?.key === key ? shown : null;
  const currentError = error?.key === key ? error.error : null;
  return {
    // Keep showing the previous history while the new one loads.
    data: current ?? shown,
    loading: !current && !currentError,
    loadingMore,
    error: currentError,
    loadMore,
    loadThrough,
  };
}
