import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { gitService } from "../../services/git";
import type { GitError, RepositoryInfo, WorktreeInfo } from "../../types/git";
import { useBranchActions } from "../branches/BranchActions";
import type { RepositoryController } from "../repository/useRepository";
import { WorktreeDialog, type WorktreePreset } from "./WorktreeDialog";

export interface WorktreeActions {
  worktrees: WorktreeInfo[] | null;
  /** Open the "New worktree" dialog, optionally preset to a branch or start point. */
  create: (preset?: WorktreePreset) => void;
  /** Open a worktree's folder in Branchline. */
  open: (path: string) => void;
  remove: (worktree: WorktreeInfo) => void;
  setLocked: (worktree: WorktreeInfo, locked: boolean) => void;
  prune: () => void;
  /** Reload the list (for example when the Worktrees view opens). */
  refresh: () => void;
}

const noop = () => {};
const WorktreeContext = createContext<WorktreeActions>({
  worktrees: null,
  create: noop,
  open: noop,
  remove: noop,
  setLocked: noop,
  prune: noop,
  refresh: noop,
});

export function useWorktreeActions(): WorktreeActions {
  return useContext(WorktreeContext);
}

/** Worktrees of the open repository, reloaded when refs move or on request. */
function useWorktrees(repo: RepositoryInfo | null) {
  const [token, setToken] = useState(0);
  const key = repo ? `${repo.path}|${repo.refsFingerprint}|${token}` : null;
  const [state, setState] = useState<{ path: string; list: WorktreeInfo[] } | null>(null);
  const latest = useRef(key);
  useEffect(() => {
    latest.current = key;
    if (!key || !repo) return;
    const path = repo.path;
    gitService
      .listWorktrees(path)
      .then((list) => latest.current === key && setState({ path, list: list ?? [] }))
      .catch(() => latest.current === key && setState({ path, list: [] }));
    // repo.path is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const refresh = useCallback(() => setToken((t) => t + 1), []);
  return { worktrees: repo && state?.path === repo.path ? state.list : null, refresh };
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function WorktreeActionsProvider({
  repo,
  controller,
  children,
}: {
  repo: RepositoryInfo | null;
  controller: Pick<RepositoryController, "run" | "open"> &
    Partial<Pick<RepositoryController, "forgetRecent">>;
  children: ReactNode;
}) {
  const { worktrees, refresh } = useWorktrees(repo);
  const { branches } = useBranchActions();
  const toast = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<{ preset?: WorktreePreset } | null>(null);
  const { run, open: openRepo, forgetRecent } = controller;

  const report = useCallback(
    (title: string, error: GitError) =>
      toast({
        tone: error.kind === "stale" ? "info" : "error",
        title: error.kind === "stale" ? "That worktree no longer exists" : title,
        description: error.kind === "stale" ? undefined : error.message,
      }),
    [toast],
  );

  /**
   * Run a worktree command that does not change the open repository's state,
   * through the controller so it is serialized with other Git work.
   */
  const act = useCallback(
    async (label: string, op: (path: string) => Promise<unknown>): Promise<GitError | null> => {
      const error = await run(label, async (path) => {
        await op(path);
        return gitService.inspectRepository(path);
      });
      refresh();
      return error;
    },
    [run, refresh],
  );

  const open = useCallback((path: string) => void openRepo(path), [openRepo]);

  const remove = useCallback(
    async (w: WorktreeInfo) => {
      const gone = !!w.prunable;
      const ok = await confirm({
        title: `Remove worktree ${w.name}?`,
        description: gone
          ? "Its folder is already gone; this removes what Git still remembers about it."
          : `The folder ${w.path} is deleted.${
              w.changes ? ` It has ${plural(w.changes, "uncommitted change")}.` : ""
            }${w.branch ? ` The branch ${w.branch} stays.` : ""}`,
        confirmLabel: "Remove worktree",
        destructive: !gone,
      });
      if (!ok) return;
      let error = await act("Removing worktree", (p) =>
        gitService.removeWorktree(p, w.path, false),
      );
      if (error?.kind === "worktreeDirty") {
        const force = await confirm({
          title: `${w.name} has uncommitted changes`,
          description:
            "Changed and untracked files in that folder are deleted with it. This cannot be undone.",
          confirmLabel: "Delete with changes",
          destructive: true,
        });
        if (!force) return;
        error = await act("Removing worktree", (p) => gitService.removeWorktree(p, w.path, true));
      }
      if (error) report(`Could not remove ${w.name}`, error);
      else {
        // It can no longer be opened from the recent list.
        forgetRecent?.(w.path);
        toast({
          tone: "success",
          title: `Removed worktree ${w.name}`,
          description: w.branch ? `The branch ${w.branch} is still there.` : undefined,
        });
      }
    },
    [confirm, act, report, toast, forgetRecent],
  );

  const setLocked = useCallback(
    async (w: WorktreeInfo, locked: boolean) => {
      const error = await act(locked ? "Locking worktree" : "Unlocking worktree", (p) =>
        gitService.lockWorktree(p, w.path, locked, ""),
      );
      if (error) report(`Could not ${locked ? "lock" : "unlock"} ${w.name}`, error);
    },
    [act, report],
  );

  const prune = useCallback(async () => {
    let count = 0;
    const error = await act("Cleaning up worktrees", async (p) => {
      count = await gitService.pruneWorktrees(p);
    });
    if (error) report("Could not clean up worktrees", error);
    else
      toast({
        tone: count ? "success" : "info",
        title: count
          ? `Removed ${count} missing ${count === 1 ? "worktree" : "worktrees"}`
          : "Nothing to clean up",
      });
  }, [act, report, toast]);

  const value = useMemo<WorktreeActions>(
    () => ({
      worktrees,
      create: (preset) => setDialog({ preset }),
      open,
      remove: (w) => void remove(w),
      setLocked: (w, l) => void setLocked(w, l),
      prune: () => void prune(),
      refresh,
    }),
    [worktrees, open, remove, setLocked, prune, refresh],
  );

  return (
    <WorktreeContext.Provider value={value}>
      {children}
      {dialog && repo && (
        <WorktreeDialog
          repo={repo}
          branches={branches}
          preset={dialog.preset}
          onCancel={() => setDialog(null)}
          onSubmit={async (path, target, openIt) => {
            let created = path;
            const error = await act("Creating worktree", async (p) => {
              created = await gitService.addWorktree(p, path, target);
            });
            if (error) return error.message;
            setDialog(null);
            toast({
              tone: "success",
              title: `Created worktree ${basename(created)}`,
              actions: openIt ? undefined : [{ label: "Open", onClick: () => open(created) }],
            });
            if (openIt) open(created);
            return null;
          }}
        />
      )}
    </WorktreeContext.Provider>
  );
}
