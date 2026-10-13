import { useCallback, useEffect, useRef, useState } from "react";
import { gitService } from "../../services/git";
import {
  loadRecent,
  saveRecent,
  withRecent,
  withoutRecent,
  type RecentRepository,
} from "../../services/recentRepositories";
import type { GitError, RepositoryInfo } from "../../types/git";

export type RepositoryState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "ready"; repo: RepositoryInfo; refreshing: boolean }
  | { status: "error"; path: string; error: GitError };

/** Errors that mean the repository itself is gone, not just a failed refresh. */
const FATAL_ON_REFRESH = new Set<GitError["kind"]>([
  "pathNotFound",
  "notADirectory",
  "notARepository",
  "bareRepository",
  "unsafeRepository",
]);

/** Minimum gap between automatic refreshes triggered by window focus. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 2000;

export interface RepositoryController {
  state: RepositoryState;
  recent: RecentRepository[];
  open: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  close: () => void;
  forgetRecent: (path: string) => void;
}

export function useRepository(onRefreshError?: (e: GitError) => void): RepositoryController {
  const [state, setStateRaw] = useState<RepositoryState>({ status: "idle" });
  const [recent, setRecent] = useState<RecentRepository[]>(loadRecent);
  // Monotonic token: responses for superseded requests are dropped.
  const requestId = useRef(0);
  // Mirror of `state` for callbacks, updated synchronously with every transition.
  const stateRef = useRef<RepositoryState>(state);
  const setState = useCallback((next: RepositoryState) => {
    stateRef.current = next;
    setStateRaw(next);
  }, []);
  const lastRefresh = useRef(0);
  const onErrorRef = useRef(onRefreshError);
  useEffect(() => {
    onErrorRef.current = onRefreshError;
  }, [onRefreshError]);

  const remember = useCallback((repo: RepositoryInfo) => {
    setRecent((list) => {
      const next = withRecent(list, { path: repo.path, name: repo.name, lastOpened: Date.now() });
      saveRecent(next);
      return next;
    });
  }, []);

  const open = useCallback(
    async (path: string) => {
      const id = ++requestId.current;
      setState({ status: "loading", path });
      try {
        const repo = await gitService.inspectRepository(path);
        if (id !== requestId.current) return;
        lastRefresh.current = Date.now();
        setState({ status: "ready", repo, refreshing: false });
        remember(repo);
      } catch (err) {
        if (id !== requestId.current) return;
        setState({ status: "error", path, error: err as GitError });
      }
    },
    [remember, setState],
  );

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    if (current.status === "error" || current.status === "loading") {
      return open(current.path);
    }
    if (current.status !== "ready" || current.refreshing) return;
    const id = ++requestId.current;
    lastRefresh.current = Date.now();
    setState({ ...current, refreshing: true });
    try {
      const repo = await gitService.inspectRepository(current.repo.path);
      if (id !== requestId.current) return;
      setState({ status: "ready", repo, refreshing: false });
    } catch (err) {
      if (id !== requestId.current) return;
      const error = err as GitError;
      if (FATAL_ON_REFRESH.has(error.kind)) {
        setState({ status: "error", path: current.repo.path, error });
      } else {
        setState({ ...current, refreshing: false });
        onErrorRef.current?.(error);
      }
    }
  }, [open, setState]);

  const close = useCallback(() => {
    requestId.current++;
    setState({ status: "idle" });
  }, [setState]);

  const forgetRecent = useCallback((path: string) => {
    setRecent((list) => {
      const next = withoutRecent(list, path);
      saveRecent(next);
      return next;
    });
  }, []);

  // Refresh when the user returns to the window (files may have changed elsewhere).
  // Event driven instead of polling; throttled so rapid focus changes do not spawn Git repeatedly.
  useEffect(() => {
    const onFocus = () => {
      const s = stateRef.current;
      if (s.status !== "ready" || s.refreshing) return;
      if (Date.now() - lastRefresh.current < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { state, recent, open, refresh, close, forgetRecent };
}

/** Path of the repository the user is looking at (or trying to open), if any. */
export function currentRepositoryPath(state: RepositoryState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "ready":
      return state.repo.path;
    default:
      return state.path;
  }
}
