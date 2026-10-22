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
import { Button } from "../../components/Button";
import { useConfirm } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { useToast, type ToastAction } from "../../components/Toast";
import { gitService } from "../../services/git";
import type {
  GitError,
  IntegrateResult,
  OperationStep,
  PlanStep,
  RepoOperation,
  RepositoryInfo,
  StartPoint,
} from "../../types/git";
import type { RepositoryController } from "../repository/useRepository";
import { useSettings } from "../settings/SettingsProvider";
import { InteractiveRebaseDialog } from "./InteractiveRebaseDialog";

export interface IntegrateActions {
  /** Ask, then merge `source` into the current branch. `label` names it ("feature", "commit a1b2c3d"). */
  merge: (source: StartPoint, label: string) => void;
  /** Ask, then rebase the current branch onto `onto`. */
  rebase: (onto: StartPoint, label: string) => void;
  cherryPick: (oid: string) => void;
  /** Ask, then cherry-pick several commits; `oids` is oldest first. */
  cherryPickMany: (oids: string[]) => void;
  revert: (oid: string) => void;
  /** Continue, skip or abort the operation in progress (abort asks first). */
  step: (step: OperationStep) => void;
  /** Open the interactive rebase plan for the commits after `base`. */
  interactive: (base: string, label: string) => void;
}

const noop = () => {};
const IntegrateContext = createContext<IntegrateActions>({
  merge: noop,
  rebase: noop,
  cherryPick: noop,
  cherryPickMany: noop,
  revert: noop,
  step: noop,
  interactive: noop,
});

export function useIntegrateActions(): IntegrateActions {
  return useContext(IntegrateContext);
}

const NOUN: Record<RepoOperation, string> = {
  merge: "merge",
  rebase: "rebase",
  cherryPick: "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

function currentName(repo: RepositoryInfo | null): string {
  if (!repo) return "the current branch";
  return repo.head.kind === "detached" ? "the detached HEAD" : repo.head.name;
}

export function IntegrateActionsProvider({
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
  const toast = useToast();
  const confirm = useConfirm();
  const { settings } = useSettings();
  const { run } = controller;
  const [mergeDialog, setMergeDialog] = useState<{ source: StartPoint; label: string } | null>(
    null,
  );
  const [noFf, setNoFf] = useState(false);
  const [irebase, setIrebase] = useState<{ base: string; label: string } | null>(null);
  // Retries offered in toasts call the latest merge/rebase without a dependency cycle.
  const retry = useRef<{
    merge: (source: StartPoint, label: string, o: { noFf: boolean; autostash: boolean }) => void;
    rebase: (onto: StartPoint, label: string, autostash: boolean) => void;
    interactive: (base: string, label: string, plan: PlanStep[]) => void;
  }>({ merge: () => {}, rebase: () => {}, interactive: () => {} });

  const report = useCallback(
    (title: string, error: GitError, retry?: { label: string; run: () => void }) => {
      const actions: ToastAction[] | undefined =
        error.kind === "checkoutConflict" && retry
          ? [{ label: retry.label, onClick: retry.run }]
          : undefined;
      toast({
        tone: error.kind === "stale" ? "info" : "error",
        title:
          error.kind === "checkoutConflict"
            ? "Blocked by local changes"
            : error.kind === "stale"
              ? "Nothing in progress any more"
              : title,
        description:
          error.kind === "checkoutConflict"
            ? "Your uncommitted changes are in the way. Commit or stash them first." +
              (error.detail ? `\n\n${error.detail}` : "")
            : error.detail && error.kind !== "unsupported"
              ? `${error.message}\n\n${error.detail}`
              : error.message,
        actions,
      });
    },
    [toast],
  );

  /** Run an operation; report conflicts, success or a specific error. */
  const perform = useCallback(
    async (
      label: string,
      op: (path: string) => Promise<IntegrateResult>,
      messages: {
        done: string | ((outcome: IntegrateResult["outcome"]) => string);
        /** Extra line under the success message. */
        doneDetail?: (outcome: IntegrateResult["outcome"]) => string | undefined;
        upToDate?: string;
        fastForward?: string;
        failed: string;
        /** Retry with autostash, offered when local changes are in the way. */
        retryWithStash?: { label: string; run: () => void };
        /** Errors of these kinds are returned to the caller instead of shown. */
        returnErrors?: GitError["kind"][];
      },
    ): Promise<GitError | null> => {
      let result: IntegrateResult | null = null;
      const error = await run(label, async (path) => {
        result = await op(path);
        return result.repo;
      });
      if (error) {
        if (messages.returnErrors?.includes(error.kind)) return error;
        report(messages.failed, error, messages.retryWithStash);
        return null;
      }
      const r = result as IntegrateResult | null;
      if (!r) return null;
      if (r.outcome.conflicts) {
        const op = r.repo.operation;
        toast({
          tone: "error",
          title: `${op ? NOUN[op][0]!.toUpperCase() + NOUN[op].slice(1) : "Operation"} stopped with conflicts`,
          description:
            "Resolve the conflicted files in Changes, then Continue. Abort goes back to where you started.",
          actions: [{ label: "Show changes", onClick: onShowChanges }],
        });
      } else if (r.outcome.upToDate) {
        toast({ tone: "info", title: messages.upToDate ?? "Already up to date" });
      } else {
        toast({
          tone: "success",
          title:
            r.outcome.fastForward && messages.fastForward
              ? messages.fastForward
              : typeof messages.done === "function"
                ? messages.done(r.outcome)
                : messages.done,
          description: messages.doneDetail?.(r.outcome),
        });
      }
      return null;
    },
    [run, toast, onShowChanges, report],
  );

  const doMerge = useCallback(
    (source: StartPoint, label: string, options: { noFf: boolean; autostash: boolean }) => {
      const target = currentName(repo);
      void perform("Merging", (path) => gitService.mergeIntoCurrent(path, source, options), {
        done: `Merged ${label} into ${target}`,
        fastForward: `Fast-forwarded ${target} to ${label}`,
        upToDate: `${target} already contains ${label}`,
        failed: `Could not merge ${label}`,
        retryWithStash: options.autostash
          ? undefined
          : {
              label: "Stash and merge",
              run: () => retry.current.merge(source, label, { ...options, autostash: true }),
            },
      });
    },
    [perform, repo],
  );

  const doRebase = useCallback(
    (onto: StartPoint, label: string, autostash: boolean) => {
      const branch = currentName(repo);
      void perform("Rebasing", (path) => gitService.rebaseCurrent(path, onto, autostash), {
        done: `Rebased ${branch} onto ${label}`,
        upToDate: `${branch} is already based on ${label}`,
        failed: `Could not rebase onto ${label}`,
        retryWithStash: autostash
          ? undefined
          : { label: "Stash and rebase", run: () => retry.current.rebase(onto, label, true) },
      });
    },
    [perform, repo],
  );

  /** Run an interactive rebase plan; plan problems are returned so the dialog can show them. */
  const doInteractive = useCallback(
    (base: string, label: string, plan: PlanStep[], autostash: boolean) => {
      const branch = currentName(repo);
      return perform(
        "Rebasing",
        (path) => gitService.interactiveRebase(path, base, plan, autostash),
        {
          done: `Rewrote ${branch}`,
          failed: `Could not rebase ${branch}`,
          returnErrors: ["unsupported"],
          retryWithStash: autostash
            ? undefined
            : {
                label: "Stash and rebase",
                run: () => retry.current.interactive(base, label, plan),
              },
        },
      );
    },
    [perform, repo],
  );

  useEffect(() => {
    retry.current = {
      merge: doMerge,
      rebase: doRebase,
      interactive: (base, label, plan) => void doInteractive(base, label, plan, true),
    };
  }, [doMerge, doRebase, doInteractive]);

  const rebase = useCallback(
    async (onto: StartPoint, label: string) => {
      const branch = currentName(repo);
      const published = repo?.upstream && !repo.upstream.gone;
      // A local-only rebase can be undone with Abort; a published one means a force push.
      const ask = published ? settings.safety.confirmRebasePublished : true;
      const ok =
        !ask ||
        (await confirm({
          title: `Rebase ${branch} onto ${label}?`,
          description:
            `The commits of ${branch} are replayed on top of ${label} as new commits, so its history is rewritten.` +
            (published
              ? ` ${branch} is published to ${repo!.upstream!.name}: after rebasing you will need to force push, which affects anyone else using it.`
              : ""),
          confirmLabel: "Rebase",
        }));
      if (ok) doRebase(onto, label, false);
    },
    [confirm, repo, doRebase, settings.safety.confirmRebasePublished],
  );

  const cherryPick = useCallback(
    (oid: string) => {
      const short = oid.slice(0, 7);
      void perform("Cherry-picking", (path) => gitService.cherryPick(path, oid), {
        done: `Cherry-picked ${short} onto ${currentName(repo)}`,
        upToDate: `The changes of ${short} are already on ${currentName(repo)}`,
        failed: `Could not cherry-pick ${short}`,
      });
    },
    [perform, repo],
  );

  const cherryPickMany = useCallback(
    async (oids: string[]) => {
      if (oids.length === 0) return;
      if (oids.length === 1) return cherryPick(oids[0]!);
      const target = currentName(repo);
      const n = oids.length;
      const ok = await confirm({
        title: `Cherry-pick ${n} commits onto ${target}?`,
        description: `They are applied oldest first, each as a new commit on ${target}. Commits whose changes are already on ${target} are skipped. If one conflicts, the cherry-pick stops so you can resolve it; Continue then picks the rest.`,
        confirmLabel: `Cherry-pick ${n} commits`,
      });
      if (!ok) return;
      const plural = (k: number) => `${k} ${k === 1 ? "commit" : "commits"}`;
      void perform("Cherry-picking", (path) => gitService.cherryPickMany(path, oids), {
        done: (o) => `Cherry-picked ${plural(n - (o.skipped ?? 0))} onto ${target}`,
        doneDetail: (o) =>
          o.skipped
            ? `${plural(o.skipped)} ${o.skipped === 1 ? "was" : "were"} already on ${target} and skipped.`
            : undefined,
        upToDate: `The changes of these ${n} commits are already on ${target}`,
        failed: `Could not cherry-pick ${n} commits`,
      });
    },
    [perform, repo, confirm, cherryPick],
  );

  const revert = useCallback(
    (oid: string) => {
      const short = oid.slice(0, 7);
      void perform("Reverting", (path) => gitService.revertCommit(path, oid), {
        done: `Reverted ${short}`,
        upToDate: `The changes of ${short} are already undone`,
        failed: `Could not revert ${short}`,
      });
    },
    [perform],
  );

  const step = useCallback(
    async (which: OperationStep) => {
      const op = repo?.operation;
      if (!op) return;
      const noun = NOUN[op];
      if (which === "abort") {
        const ok = await confirm({
          title: op === "bisect" ? "Stop bisecting?" : `Abort the ${noun}?`,
          description:
            op === "bisect"
              ? "HEAD goes back to where you started bisecting."
              : `Everything goes back to how it was before the ${noun} started. Conflict resolutions you made so far are lost.`,
          confirmLabel: op === "bisect" ? "Stop bisect" : `Abort ${noun}`,
          destructive: true,
        });
        if (!ok) return;
      }
      void perform(
        which === "continue" ? "Continuing" : which === "skip" ? "Skipping" : "Aborting",
        (path) => gitService.operationStep(path, which),
        {
          done:
            which === "abort"
              ? `Aborted the ${noun}`
              : which === "skip"
                ? "Skipped this commit"
                : `Finished the ${noun}`,
          failed:
            which === "abort" ? `Could not abort the ${noun}` : `Could not continue the ${noun}`,
        },
      );
    },
    [repo, confirm, perform],
  );

  const value = useMemo<IntegrateActions>(
    () => ({
      merge: (source, label) => {
        setNoFf(false);
        setMergeDialog({ source, label });
      },
      rebase: (onto, label) => void rebase(onto, label),
      cherryPick,
      cherryPickMany: (oids) => void cherryPickMany(oids),
      revert,
      step: (s) => void step(s),
      interactive: (base, label) => setIrebase({ base, label }),
    }),
    [rebase, cherryPick, cherryPickMany, revert, step],
  );

  return (
    <IntegrateContext.Provider value={value}>
      {children}
      {irebase && repo && (
        <InteractiveRebaseDialog
          repoPath={repo.path}
          base={irebase.base}
          baseLabel={irebase.label}
          branch={currentName(repo)}
          onCancel={() => setIrebase(null)}
          onSubmit={async (plan) => {
            const error = await doInteractive(irebase.base, irebase.label, plan, false);
            if (error) return error.message;
            setIrebase(null);
            return null;
          }}
        />
      )}
      {mergeDialog && (
        <Dialog
          title={`Merge ${mergeDialog.label} into ${currentName(repo)}?`}
          description={`The changes of ${mergeDialog.label} are combined into ${currentName(repo)}. If ${currentName(repo)} has no commits of its own since they split, Git simply moves it forward (fast-forward).`}
          onCancel={() => setMergeDialog(null)}
          onSubmit={() => {
            const { source, label } = mergeDialog;
            setMergeDialog(null);
            doMerge(source, label, { noFf, autostash: false });
          }}
          actions={
            <>
              <Button variant="secondary" onClick={() => setMergeDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Merge
              </Button>
            </>
          }
        >
          <label className="bl-checkbox">
            <input type="checkbox" checked={noFf} onChange={(e) => setNoFf(e.target.checked)} />
            <span>Always create a merge commit</span>
          </label>
        </Dialog>
      )}
    </IntegrateContext.Provider>
  );
}
