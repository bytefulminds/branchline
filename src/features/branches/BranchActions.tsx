import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { gitService } from "../../services/git";
import type { BranchList, GitError, RepositoryInfo, StartPoint } from "../../types/git";
import type { RepositoryController } from "../repository/useRepository";
import { BranchNameDialog } from "./BranchNameDialog";
import { useBranches } from "./useBranches";

export interface BranchActions {
  branches: BranchList | null;
  switchTo: (name: string) => void;
  checkoutRemote: (remoteBranch: string) => void;
  /** Ask for a name, then create a branch at `start`. */
  create: (start: StartPoint, startLabel: string) => void;
  rename: (name: string) => void;
  remove: (name: string) => void;
  checkoutCommit: (oid: string) => void;
}

const noop = () => {};
const BranchActionsContext = createContext<BranchActions>({
  branches: null,
  switchTo: noop,
  checkoutRemote: noop,
  create: noop,
  rename: noop,
  remove: noop,
  checkoutCommit: noop,
});

export function useBranchActions(): BranchActions {
  return useContext(BranchActionsContext);
}

type DialogState =
  | { mode: "create"; start: StartPoint; startLabel: string }
  | { mode: "rename"; name: string }
  | null;

/** Suggest a local name for a branch started from a remote branch (`origin/x` -> `x`). */
function suggestedName(start: StartPoint): string {
  return start.kind === "branch" ? start.name.replace(/^[^/]+\//, "") : "";
}

export function BranchActionsProvider({
  repo,
  controller,
  children,
}: {
  repo: RepositoryInfo | null;
  controller: Pick<RepositoryController, "run">;
  children: ReactNode;
}) {
  const { branches } = useBranches(repo);
  const confirm = useConfirm();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const { run } = controller;

  const report = useCallback(
    (title: string, error: GitError) => {
      if (error.kind === "checkoutConflict") {
        toast({
          tone: "error",
          title: "Switch blocked by local changes",
          description: "Commit or stash your changes to these files first. " + (error.detail ?? ""),
        });
        return;
      }
      toast({ tone: "error", title, description: error.detail ?? error.message });
    },
    [toast],
  );

  const switchTo = useCallback(
    async (name: string) => {
      const error = await run("Switching branch", (path) => gitService.switchBranch(path, name));
      if (error) report(`Could not switch to ${name}`, error);
    },
    [run, report],
  );

  const checkoutRemote = useCallback(
    async (remoteBranch: string) => {
      const error = await run("Checking out", (path) =>
        gitService.checkoutRemoteBranch(path, remoteBranch),
      );
      if (error) report(`Could not check out ${remoteBranch}`, error);
    },
    [run, report],
  );

  const remove = useCallback(
    async (name: string) => {
      const ok = await confirm({
        title: `Delete branch ${name}?`,
        description:
          "The branch is removed. Its commits stay reachable from any other branch that contains them.",
        confirmLabel: "Delete branch",
        destructive: true,
      });
      if (!ok) return;
      let error = await run("Deleting branch", (path) =>
        gitService.deleteBranch(path, name, false),
      );
      if (error?.kind === "notMerged") {
        const force = await confirm({
          title: `${name} is not merged`,
          description:
            "It has commits that no other branch contains. Deleting it anyway makes those commits hard to find again.",
          confirmLabel: "Delete anyway",
          destructive: true,
        });
        if (!force) return;
        error = await run("Deleting branch", (path) => gitService.deleteBranch(path, name, true));
      }
      if (error) report(`Could not delete ${name}`, error);
      else toast({ tone: "success", title: `Deleted branch ${name}` });
    },
    [confirm, run, report, toast],
  );

  const checkoutCommit = useCallback(
    async (oid: string) => {
      const ok = await confirm({
        title: `Check out commit ${oid.slice(0, 7)}?`,
        description:
          "You will not be on a branch (detached HEAD). Create a branch first if you want to keep new commits.",
        confirmLabel: "Check out",
      });
      if (!ok) return;
      const error = await run("Checking out", (path) => gitService.checkoutDetached(path, oid));
      if (error) report(`Could not check out ${oid.slice(0, 7)}`, error);
    },
    [confirm, run, report],
  );

  const value = useMemo<BranchActions>(
    () => ({
      branches,
      switchTo: (n) => void switchTo(n),
      checkoutRemote: (n) => void checkoutRemote(n),
      create: (start, startLabel) => setDialog({ mode: "create", start, startLabel }),
      rename: (name) => setDialog({ mode: "rename", name }),
      remove: (n) => void remove(n),
      checkoutCommit: (oid) => void checkoutCommit(oid),
    }),
    [branches, switchTo, checkoutRemote, remove, checkoutCommit],
  );

  return (
    <BranchActionsContext.Provider value={value}>
      {children}
      {dialog && repo && (
        <BranchNameDialog
          mode={dialog.mode}
          repoPath={repo.path}
          branches={branches}
          initialName={dialog.mode === "rename" ? dialog.name : suggestedName(dialog.start)}
          startLabel={dialog.mode === "create" ? dialog.startLabel : undefined}
          onCancel={() => setDialog(null)}
          onSubmit={async (name, checkout) => {
            const error =
              dialog.mode === "create"
                ? await run("Creating branch", (path) =>
                    gitService.createBranch(path, name, dialog.start, checkout),
                  )
                : await run("Renaming branch", (path) =>
                    gitService.renameBranch(path, dialog.name, name),
                  );
            // `checkout -b` is atomic: on a conflict the branch is not created either.
            if (error) return error.message;
            setDialog(null);
            return null;
          }}
        />
      )}
    </BranchActionsContext.Provider>
  );
}
