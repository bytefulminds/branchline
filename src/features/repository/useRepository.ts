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
  /** Label of the write operation in progress (for example "Staging"), or null. */
  operation: string | null;
  open: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Run a write operation that returns the refreshed repository. Resolves to the
   * error on failure (already reflected in state where relevant), or null.
   */
  run: (
    label: string,
    op: (repoPath: string) => Promise<RepositoryInfo>,
  ) => Promise<GitError | null>;
  close: () => void;
  forgetRecent: (path: string) => void;
}

const BUSY: GitError = {
  kind: "locked",
  message: "Another operation is still running.",
  detail: null,
};

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
  const [operation, setOperation] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);
  // A refresh was requested while another refresh or an operation was running.
  const pendingRefresh = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
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
    if (current.status !== "ready") return;
    if (current.refreshing || operationRef.current) {
      pendingRefresh.current = true;
      return;
    }
    pendingRefresh.current = false;
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
    if (pendingRefresh.current) void refreshRef.current();
  }, [open, setState]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const run = useCallback(
    async (label: string, op: (repoPath: string) => Promise<RepositoryInfo>) => {
      const current = stateRef.current;
      if (current.status !== "ready") return BUSY;
      if (operationRef.current) return BUSY;
      const path = current.repo.path;
      operationRef.current = label;
      setOperation(label);
      // Responses of refreshes started before this operation are now outdated.
      const id = ++requestId.current;
      if (current.refreshing) setState({ ...current, refreshing: false });
      let failure: GitError | null = null;
      try {
        const repo = await op(path);
        if (id === requestId.current) {
          lastRefresh.current = Date.now();
          setState({ status: "ready", repo, refreshing: false });
        }
      } catch (err) {
        failure = err as GitError;
        if (id === requestId.current && FATAL_ON_REFRESH.has(failure.kind)) {
          setState({ status: "error", path, error: failure });
        } else {
          // Whatever happened, show the repository as it is now.
          pendingRefresh.current = true;
        }
      } finally {
        operationRef.current = null;
        setOperation(null);
      }
      if (pendingRefresh.current) void refreshRef.current();
      return failure;
    },
    [setState],
  );

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

  // Watch the open repository so external edits refresh the view without polling.
  const watchedPath = state.status === "ready" ? state.repo.path : null;
  useEffect(() => {
    if (!watchedPath) return;
    gitService.watchRepository(watchedPath).catch(() => {
      // Watching is best effort (for example inotify limits); focus refresh still works.
    });
    return () => {
      gitService.unwatchRepository().catch(() => {});
    };
  }, [watchedPath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    gitService
      .onRepositoryChanged((repo) => {
        const s = stateRef.current;
        if (s.status === "ready" && s.repo.path === repo) void refreshRef.current();
      })
      .then((u) => (cancelled ? u() : (unlisten = u)))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { state, recent, operation, open, refresh, run, close, forgetRecent };
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
