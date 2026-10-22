import { useCallback, useEffect, useRef, useState } from "react";
import { gitService } from "../../services/git";
import type { GitError, LogCommit, LogFilter, RefInfo, RepositoryInfo } from "../../types/git";
import { emptyGraphState, layoutGraph, type GraphRow, type GraphState } from "./graph";

export const PAGE_SIZE = 300;

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
  }));
}

export interface HistoryData {
  key: string;
  /** The list holds search results, not the whole history. */
  filtered: boolean;
  commits: LogCommit[];
  rows: GraphRow[];
  graph: GraphState;
  refsByOid: Map<string, RefInfo[]>;
  total: number;
  hasMore: boolean;
}

export interface HistoryController {
  data: HistoryData | null;
  loading: boolean;
  loadingMore: boolean;
  error: GitError | null;
  loadMore: () => void;
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
): HistoryController {
  const filtered = isFiltering(filter);
  const filterKey = filtered ? JSON.stringify(filter) : "";
  const key = `${repo.path}|${repo.refsFingerprint}|${headOid(repo)}|${filterKey}`;
  const [data, setData] = useState<HistoryData | null>(null);
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
        const { rows, state } = applied
          ? { rows: layoutResults(page.commits), state: emptyGraphState() }
          : layoutGraph(page.commits, emptyGraphState());
        setData({
          key,
          filtered: !!applied,
          commits: page.commits,
          rows,
          graph: state,
          refsByOid: groupRefs(refs),
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
          const { rows, state } = prev.filtered
            ? { rows: layoutResults(page.commits), state: prev.graph }
            : layoutGraph(page.commits, prev.graph);
          return {
            ...prev,
            commits: [...prev.commits, ...page.commits],
            rows: [...prev.rows, ...rows],
            graph: state,
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

  const current = data?.key === key ? data : null;
  const currentError = error?.key === key ? error.error : null;
  return {
    // Keep showing the previous history while the new one loads.
    data: current ?? data,
    loading: !current && !currentError,
    loadingMore,
    error: currentError,
    loadMore,
  };
}
