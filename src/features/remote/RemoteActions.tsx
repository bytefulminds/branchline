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
import { useToast, type ToastAction } from "../../components/Toast";
import { plural } from "../../lib/format";
import { gitService } from "../../services/git";
import type {
  GitError,
  PullMode,
  PushRequest,
  RemoteInfo,
  RemoteProgress,
  RemoteResult,
  RepositoryInfo,
} from "../../types/git";
import type { RepositoryController } from "../repository/useRepository";
import { PublishDialog } from "./PublishDialog";

/** A fetch, pull or push that is running. */
export interface NetworkActivity {
  kind: "fetch" | "pull" | "push";
  /** "Fetching", "Pulling origin/main", ... */
  label: string;
  progress: RemoteProgress | null;
  cancelling: boolean;
}

export interface RemoteActions {
  remotes: RemoteInfo[];
  activity: NetworkActivity | null;
  fetchAll: () => void;
  /** Pull the current branch; `autostash` puts local changes aside and reapplies them. */
  pull: (mode?: PullMode, autostash?: boolean) => void;
  /** Push the current branch to its upstream, or publish it when it has none. */
  push: () => void;
  forcePush: () => void;
  /** Push any local branch (publishing it when it has no upstream). */
  pushBranch: (name: string, upstream: string | null) => void;
  cancel: () => void;
}

const noop = () => {};
const RemoteActionsContext = createContext<RemoteActions>({
  remotes: [],
  activity: null,
  fetchAll: noop,
  pull: noop,
  push: noop,
  forcePush: noop,
  pushBranch: noop,
  cancel: noop,
});

export function useRemoteActions(): RemoteActions {
  return useContext(RemoteActionsContext);
}

/** Remotes of the open repository; reloaded when refs change (for example after `git remote add` and a fetch). */
function useRemotes(repo: RepositoryInfo | null): RemoteInfo[] {
  const key = repo ? `${repo.path}|${repo.refsFingerprint}` : null;
  const [state, setState] = useState<{ path: string; remotes: RemoteInfo[] } | null>(null);
  const latest = useRef(key);
  useEffect(() => {
    latest.current = key;
    if (!key || !repo) return;
    const path = repo.path;
    gitService
      .listRemotes(path)
      .then((remotes) => latest.current === key && setState({ path, remotes: remotes ?? [] }))
      .catch(() => latest.current === key && setState({ path, remotes: [] }));
    // repo.path is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return repo && state?.path === repo.path ? state.remotes : [];
}

const MODE_LABEL: Record<PullMode, string> = {
  fastForward: "Pulling",
  merge: "Pulling (merge)",
  rebase: "Pulling (rebase)",
};

const ERROR_TITLE: Partial<Record<GitError["kind"], string>> = {
  authFailed: "Sign-in failed",
  hostKeyUnverified: "Unknown SSH host",
  networkFailed: "Remote unreachable",
  remoteNotFound: "Remote repository not found",
  pushRejected: "Push rejected",
  staleLease: "Force push refused",
  remoteRejected: "Push refused by the remote",
  noUpstream: "No upstream branch",
  diverged: "Cannot fast-forward",
  checkoutConflict: "Pull blocked by local changes",
  identityMissing: "Git does not know who you are",
  locked: "Repository is busy",
  timeout: "The remote did not respond in time",
};

let nextOpId = 1;

export function RemoteActionsProvider({
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
  const remotes = useRemotes(repo);
  const toast = useToast();
  const confirm = useConfirm();
  const { run } = controller;
  const [activity, setActivity] = useState<(NetworkActivity & { opId: string }) | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  // Actions referenced from toasts; kept fresh without re-creating every callback.
  const actionsRef = useRef<RemoteActions | null>(null);

  const branch = repo?.head.kind === "branch" ? repo.head.name : null;
  const upstream = repo?.upstream ?? null;

  /** Run one network operation through the repository controller (one operation at a time). */
  const runRemote = useCallback(
    async (
      kind: NetworkActivity["kind"],
      label: string,
      start: (
        path: string,
        opId: string,
        onProgress: (p: RemoteProgress) => void,
      ) => Promise<RemoteResult>,
    ): Promise<{ result: RemoteResult | null; error: GitError | null }> => {
      const opId = `remote-${nextOpId++}`;
      setActivity({ opId, kind, label, progress: null, cancelling: false });
      let result: RemoteResult | null = null;
      const error = await run(label, async (path) => {
        result = await start(path, opId, (progress) =>
          setActivity((a) => (a?.opId === opId ? { ...a, progress } : a)),
        );
        return result.repo;
      });
      setActivity((a) => (a?.opId === opId ? null : a));
      return { result, error };
    },
    [run],
  );

  const report = useCallback(
    (fallbackTitle: string, error: GitError, actions?: ToastAction[]) => {
      if (error.kind === "cancelled") {
        toast({ tone: "info", title: "Cancelled", description: error.message });
        return;
      }
      toast({
        tone: "error",
        title: ERROR_TITLE[error.kind] ?? fallbackTitle,
        description: error.detail ? `${error.message}\n\n${error.detail}` : error.message,
        actions,
      });
    },
    [toast],
  );

  const pullActions = useCallback(
    (): ToastAction[] => [
      { label: "Pull with merge", onClick: () => actionsRef.current?.pull("merge") },
      { label: "Pull with rebase", onClick: () => actionsRef.current?.pull("rebase") },
    ],
    [],
  );

  const fetchAll = useCallback(async () => {
    const { result, error } = await runRemote("fetch", "Fetching", (path, opId, onProgress) =>
      gitService.fetchRemote(path, null, opId, onProgress),
    );
    if (error) return report("Fetch failed", error);
    const n = result?.outcome.updatedRefs ?? 0;
    toast({
      tone: n ? "success" : "info",
      title: n ? "Fetched" : "Already up to date",
      description: n
        ? `${plural(n, "branch or tag", "branches or tags")} updated.`
        : `Nothing new on ${plural(remotes.length, "remote")}.`,
    });
  }, [runRemote, report, toast, remotes.length]);

  const pull = useCallback(
    async (mode: PullMode = "fastForward", autostash = false) => {
      const label = `${MODE_LABEL[mode]}${upstream ? ` ${upstream.name}` : ""}`;
      const { result, error } = await runRemote("pull", label, (path, opId, onProgress) =>
        gitService.pullBranch(path, mode, autostash, opId, onProgress),
      );
      if (error) {
        return report(
          "Pull failed",
          error,
          error.kind === "diverged"
            ? pullActions()
            : error.kind === "checkoutConflict" && !autostash
              ? [
                  {
                    label: "Stash, pull and reapply",
                    onClick: () => actionsRef.current?.pull(mode, true),
                  },
                ]
              : undefined,
        );
      }
      const outcome = result?.outcome;
      if (!outcome) return;
      if (outcome.stashKept) {
        toast({
          tone: "error",
          title: "Pulled, but your changes conflict",
          description: `Your stashed changes conflict with ${outcome.target ?? "the pulled commits"}. Resolve the conflicts in Changes; a copy of your changes is kept in Stashes.`,
          actions: [{ label: "Show changes", onClick: onShowChanges }],
        });
      } else if (outcome.conflicts) {
        toast({
          tone: "error",
          title: "Pulled with conflicts",
          description:
            `Resolve the conflicts with ${outcome.target ?? "the upstream"} in Changes, then commit.` +
            (result?.repo.heldChanges
              ? " Your uncommitted changes are put aside and come back when you commit the merge."
              : ""),
          actions: [{ label: "Show changes", onClick: onShowChanges }],
        });
      } else {
        toast({
          tone: outcome.upToDate ? "info" : "success",
          title: outcome.upToDate ? "Already up to date" : `Pulled ${outcome.target ?? ""}`.trim(),
        });
      }
    },
    [runRemote, report, toast, upstream, pullActions, onShowChanges],
  );

  const doPush = useCallback(
    async (request: PushRequest, label: string) => {
      const { result, error } = await runRemote("push", label, (path, opId, onProgress) =>
        gitService.pushBranch(path, request, opId, onProgress),
      );
      if (error) {
        const actions: ToastAction[] | undefined =
          error.kind === "pushRejected"
            ? request.branch === branch
              ? [
                  ...pullActions(),
                  { label: "Force push…", onClick: () => actionsRef.current?.forcePush() },
                ]
              : undefined
            : error.kind === "staleLease"
              ? [{ label: "Fetch", onClick: () => actionsRef.current?.fetchAll() }]
              : undefined;
        return report("Push failed", error, actions);
      }
      const outcome = result?.outcome;
      if (!outcome) return;
      toast({
        tone: outcome.upToDate ? "info" : "success",
        title: outcome.upToDate
          ? "Everything up to date"
          : request.setUpstream
            ? `Published ${request.branch}`
            : request.force
              ? `Force pushed ${request.branch}`
              : `Pushed ${request.branch}`,
        description: outcome.target ? `to ${outcome.target}` : undefined,
      });
    },
    [runRemote, report, toast, branch, pullActions],
  );

  /** Publish a branch without upstream: directly with one remote, else ask which one. */
  const publish = useCallback(
    (name: string) => {
      if (remotes.length === 0) {
        toast({
          tone: "error",
          title: "No remote to push to",
          description: "Add a remote to this repository first (git remote add).",
        });
      } else if (remotes.length === 1) {
        void doPush(
          { branch: name, remote: remotes[0]!.name, setUpstream: true, force: false },
          `Publishing ${name}`,
        );
      } else {
        setPublishing(name);
      }
    },
    [remotes, doPush, toast],
  );

  const pushBranch = useCallback(
    (name: string, branchUpstream: string | null) => {
      if (!branchUpstream) return publish(name);
      void doPush(
        { branch: name, remote: null, setUpstream: false, force: false },
        `Pushing ${name}`,
      );
    },
    [publish, doPush],
  );

  const push = useCallback(() => {
    if (!branch) return;
    pushBranch(branch, upstream?.name ?? null);
  }, [branch, upstream, pushBranch]);

  const forcePush = useCallback(async () => {
    if (!branch || !upstream) return;
    const ok = await confirm({
      title: `Force push ${branch}?`,
      description: `${upstream.name} is replaced by your branch. Commits on the remote that your branch does not contain are removed from it. If someone pushed since your last fetch, the push is refused (force with lease).`,
      confirmLabel: "Force push",
      destructive: true,
    });
    if (!ok) return;
    void doPush(
      { branch, remote: null, setUpstream: false, force: true },
      `Force pushing ${branch}`,
    );
  }, [branch, upstream, confirm, doPush]);

  const cancel = useCallback(() => {
    setActivity((a) => {
      if (!a || a.cancelling) return a;
      gitService.cancelRemote(a.opId).catch(() => {});
      return { ...a, cancelling: true };
    });
  }, []);

  const value = useMemo<RemoteActions>(
    () => ({
      remotes,
      activity: activity
        ? {
            kind: activity.kind,
            label: activity.label,
            progress: activity.progress,
            cancelling: activity.cancelling,
          }
        : null,
      fetchAll: () => void fetchAll(),
      pull: (mode, autostash) => void pull(mode, autostash),
      push,
      forcePush: () => void forcePush(),
      pushBranch,
      cancel,
    }),
    [remotes, activity, fetchAll, pull, push, forcePush, pushBranch, cancel],
  );

  useEffect(() => {
    actionsRef.current = value;
  }, [value]);

  return (
    <RemoteActionsContext.Provider value={value}>
      {children}
      {publishing && (
        <PublishDialog
          branch={publishing}
          remotes={remotes}
          onCancel={() => setPublishing(null)}
          onSubmit={(remote) => {
            const name = publishing;
            setPublishing(null);
            void doPush(
              { branch: name, remote, setUpstream: true, force: false },
              `Publishing ${name}`,
            );
          }}
        />
      )}
    </RemoteActionsContext.Provider>
  );
}
