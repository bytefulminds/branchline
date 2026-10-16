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
import type { GitError, RepositoryInfo, StashInfo, StashResult } from "../../types/git";
import type { RepositoryController } from "../repository/useRepository";
import { StashDialog } from "./StashDialog";

export interface StashActions {
  stashes: StashInfo[];
  /** Ask for a message, then stash the uncommitted changes. */
  save: () => void;
  apply: (stash: StashInfo) => void;
  pop: (stash: StashInfo) => void;
  drop: (stash: StashInfo) => void;
}

const noop = () => {};
const StashActionsContext = createContext<StashActions>({
  stashes: [],
  save: noop,
  apply: noop,
  pop: noop,
  drop: noop,
});

export function useStashActions(): StashActions {
  return useContext(StashActionsContext);
}

/** Short label for a stash in titles and toasts. */
export function stashLabel(stash: StashInfo): string {
  return stash.autoMessage
    ? `Changes on ${stash.branch ?? "detached HEAD"}`
    : stash.message || `stash@{${stash.index}}`;
}

/** The stash list, reloaded only when it changes (stash fingerprint) or the repository changes. */
function useStashes(repo: RepositoryInfo | null): StashInfo[] {
  const key = repo ? `${repo.path}|${repo.stashFingerprint}` : null;
  const [state, setState] = useState<{ key: string; path: string; stashes: StashInfo[] } | null>(
    null,
  );
  const latest = useRef(key);
  useEffect(() => {
    latest.current = key;
    if (!key || !repo) return;
    const path = repo.path;
    gitService
      .listStashes(path)
      .then((stashes) => latest.current === key && setState({ key, path, stashes: stashes ?? [] }))
      .catch(() => latest.current === key && setState({ key, path, stashes: [] }));
    // repo.path is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!repo || repo.stashCount === 0) return [];
  return state?.path === repo.path ? state.stashes : [];
}

export function StashActionsProvider({
  repo,
  controller,
  onShowChanges,
  children,
}: {
  repo: RepositoryInfo | null;
  controller: Pick<RepositoryController, "run">;
  onShowChanges: () => void;
  children: ReactNode;
}) {
  const stashes = useStashes(repo);
  const toast = useToast();
  const confirm = useConfirm();
  const { run } = controller;
  const [dialogOpen, setDialogOpen] = useState(false);

  const report = useCallback(
    (title: string, error: GitError) => {
      if (error.kind === "stale") {
        toast({
          tone: "info",
          title: "The stash list changed",
          description: "A stash was added or removed elsewhere. Check the list and try again.",
        });
        return;
      }
      if (error.kind === "checkoutConflict") {
        toast({
          tone: "error",
          title: "Local changes are in the way",
          description:
            "Commit, stash or discard your changes to these files first, then apply the stash again.\n\n" +
            (error.detail ?? ""),
        });
        return;
      }
      toast({ tone: "error", title, description: error.detail ?? error.message });
    },
    [toast],
  );

  const applyStash = useCallback(
    async (stash: StashInfo, pop: boolean) => {
      let result: StashResult | null = null;
      const error = await run(pop ? "Popping stash" : "Applying stash", async (path) => {
        result = await gitService.applyStash(path, stash, pop);
        return result.repo;
      });
      if (error)
        return report(pop ? "Could not pop the stash" : "Could not apply the stash", error);
      const outcome = (result as StashResult | null)?.outcome;
      if (outcome?.conflicts) {
        toast({
          tone: "error",
          title: "Applied with conflicts",
          description: outcome.kept
            ? "Resolve the conflicts in Changes. The stash is kept, so nothing is lost."
            : "Resolve the conflicts in Changes.",
          actions: [{ label: "Show changes", onClick: onShowChanges }],
        });
      } else {
        toast({ tone: "success", title: pop ? "Stash popped" : "Stash applied" });
      }
    },
    [run, report, toast, onShowChanges],
  );

  const drop = useCallback(
    async (stash: StashInfo) => {
      const ok = await confirm({
        title: `Delete stash “${stashLabel(stash)}”?`,
        description:
          "The changes in this stash are deleted. This cannot be undone from Branchline.",
        confirmLabel: "Delete stash",
        destructive: true,
      });
      if (!ok) return;
      const error = await run("Deleting stash", (path) => gitService.dropStash(path, stash));
      if (error) report("Could not delete the stash", error);
      else toast({ tone: "success", title: "Stash deleted" });
    },
    [confirm, run, report, toast],
  );

  const value = useMemo<StashActions>(
    () => ({
      stashes,
      save: () => setDialogOpen(true),
      apply: (s) => void applyStash(s, false),
      pop: (s) => void applyStash(s, true),
      drop: (s) => void drop(s),
    }),
    [stashes, applyStash, drop],
  );

  const untracked = repo?.changes.filter((c) => c.worktreeStatus === "untracked").length ?? 0;

  return (
    <StashActionsContext.Provider value={value}>
      {children}
      {dialogOpen && repo && (
        <StashDialog
          changedFiles={repo.totalChanges}
          untrackedFiles={untracked}
          onCancel={() => setDialogOpen(false)}
          onSubmit={async (message, includeUntracked) => {
            const error = await run("Stashing", (path) =>
              gitService.saveStash(path, message, includeUntracked),
            );
            if (error) return error.message;
            setDialogOpen(false);
            toast({
              tone: "success",
              title: "Changes stashed",
              description: `${plural(repo.totalChanges - (includeUntracked ? 0 : untracked), "file")} put aside. Apply or pop the stash to bring them back.`,
            });
            return null;
          }}
        />
      )}
    </StashActionsContext.Provider>
  );
}
