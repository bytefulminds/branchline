import { useCallback, useEffect, useRef, useState } from "react";
import { gitService } from "../../services/git";
import type { GitError, LogCommit, RefInfo, RepositoryInfo } from "../../types/git";
import { emptyGraphState, layoutGraph, type GraphRow, type GraphState } from "./graph";

export const PAGE_SIZE = 300;

export interface HistoryData {
  key: string;
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
export function useHistory(repo: RepositoryInfo): HistoryController {
  const key = `${repo.path}|${repo.refsFingerprint}|${headOid(repo)}`;
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<{ key: string; error: GitError } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestKey = useRef(key);
  const moreInFlight = useRef(false);

  useEffect(() => {
    requestKey.current = key;
    moreInFlight.current = false;
    const path = repo.path;
    Promise.all([gitService.logPage(path, 0, PAGE_SIZE), gitService.listRefs(path)])
      .then(([page, refs]) => {
        if (requestKey.current !== key) return;
        const { rows, state } = layoutGraph(page.commits, emptyGraphState());
        setData({
          key,
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
  }, [key, repo.path]);

  const loadMore = useCallback(() => {
    if (!data || data.key !== key || !data.hasMore || moreInFlight.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    gitService
      .logPage(repo.path, data.commits.length, PAGE_SIZE)
      .then((page) => {
        if (requestKey.current !== key) return;
        setData((prev) => {
          if (!prev || prev.key !== key) return prev;
          const { rows, state } = layoutGraph(page.commits, prev.graph);
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
  }, [data, key, repo.path]);

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
