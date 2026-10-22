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
import { RemoteDialog } from "./RemoteDialog";

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
  /** Fetch one remote. */
  fetchRemote: (name: string) => void;
  /** Ask for a name and address, then add a remote. */
  addRemote: () => void;
  /** Rename a remote or change its addresses. */
  editRemote: (remote: RemoteInfo) => void;
  /** Remove a remote after confirmation. */
  removeRemote: (remote: RemoteInfo) => void;
  /** Pull the current branch; `autostash` puts local changes aside and reapplies them. */
  pull: (mode?: PullMode, autostash?: boolean) => void;
  /** Push the current branch to its upstream, or publish it when it has none. */
  push: () => void;
  forcePush: () => void;
  /** Push any local branch (publishing it when it has no upstream). */
  pushBranch: (name: string, upstream: string | null) => void;
  /** Push a tag; asks which remote when there are several. */
  pushTag: (name: string) => void;
  /** Delete a tag on a remote, after confirmation. */
  deleteRemoteTag: (name: string) => void;
  cancel: () => void;
}

const noop = () => {};
const RemoteActionsContext = createContext<RemoteActions>({
  remotes: [],
  activity: null,
  fetchAll: noop,
  fetchRemote: noop,
  addRemote: noop,
  editRemote: noop,
  removeRemote: noop,
  pull: noop,
  push: noop,
  forcePush: noop,
  pushBranch: noop,
  pushTag: noop,
  deleteRemoteTag: noop,
  cancel: noop,
});

export function useRemoteActions(): RemoteActions {
  return useContext(RemoteActionsContext);
}

/** Remotes of the open repository; reloaded when refs change (for example after `git remote add` and a fetch). */
function useRemotes(repo: RepositoryInfo | null) {
  const [token, setToken] = useState(0);
  const key = repo ? `${repo.path}|${repo.refsFingerprint}|${token}` : null;
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
  const reload = useCallback(() => setToken((t) => t + 1), []);
  return { remotes: repo && state?.path === repo.path ? state.remotes : [], reload };
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
  tagConflict: "Tag exists on the remote",
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
  const { remotes, reload: reloadRemotes } = useRemotes(repo);
  const [remoteDialog, setRemoteDialog] = useState<{ edit: RemoteInfo | null } | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const { run } = controller;
  const [activity, setActivity] = useState<(NetworkActivity & { opId: string }) | null>(null);
  /** Open remote chooser: what to do with the remote the user picks. */
  const [picker, setPicker] = useState<{
    title: string;
    description: string;
    submitLabel: string;
    onPick: (remote: string) => void;
  } | null>(null);
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

  const fetchRemote = useCallback(
    async (name: string) => {
      const { result, error } = await runRemote(
        "fetch",
        `Fetching ${name}`,
        (path, opId, onProgress) => gitService.fetchRemote(path, name, opId, onProgress),
      );
      if (error) return report(`Could not fetch ${name}`, error);
      const n = result?.outcome.updatedRefs ?? 0;
      toast({
        tone: n ? "success" : "info",
        title: n ? `Fetched ${name}` : `${name} is up to date`,
        description: n ? `${plural(n, "branch or tag", "branches or tags")} updated.` : undefined,
      });
    },
    [runRemote, report, toast],
  );

  /** Change the remote configuration, then refresh the repository and the remote list. */
  const configure = useCallback(
    async (label: string, op: (path: string) => Promise<unknown>) => {
      const error = await run(label, async (path) => {
        await op(path);
        return gitService.inspectRepository(path);
      });
      reloadRemotes();
      return error;
    },
    [run, reloadRemotes],
  );

  const removeRemote = useCallback(
    async (r: RemoteInfo) => {
      const ok = await confirm({
        title: `Remove remote ${r.name}?`,
        description: `Branchline forgets ${r.url} and its remote branches (${r.name}/…). Nothing changes on the server, and your local branches stay; they no longer track ${r.name}.`,
        confirmLabel: "Remove remote",
        destructive: true,
      });
      if (!ok) return;
      const error = await configure("Removing remote", (p) => gitService.removeRemote(p, r.name));
      if (error) report(`Could not remove ${r.name}`, error);
      else toast({ tone: "success", title: `Removed remote ${r.name}` });
    },
    [confirm, configure, report, toast],
  );

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
        setPicker({
          title: `Publish ${name}`,
          description:
            "The branch is pushed and the remote branch becomes its upstream, so later pulls and pushes go there.",
          submitLabel: "Publish",
          onPick: (remote) =>
            void doPush(
              { branch: name, remote, setUpstream: true, force: false },
              `Publishing ${name}`,
            ),
        });
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

  const runTag = useCallback(
    async (name: string, remote: string, remove: boolean) => {
      const { result, error } = await runRemote(
        "push",
        remove ? `Deleting ${name} from ${remote}` : `Pushing ${name}`,
        (path, opId, onProgress) =>
          gitService.pushTag(path, name, remote, remove, opId, onProgress),
      );
      if (error) return report(remove ? "Could not delete the remote tag" : "Push failed", error);
      const upToDate = result?.outcome.upToDate ?? false;
      toast({
        tone: upToDate ? "info" : "success",
        title: remove
          ? upToDate
            ? `${name} was not on ${remote}`
            : `Deleted ${name} from ${remote}`
          : upToDate
            ? `${name} is already on ${remote}`
            : `Pushed ${name} to ${remote}`,
      });
    },
    [runRemote, report, toast],
  );

  /** Run `action` with the only remote, or ask which one when there are several. */
  const withRemote = useCallback(
    (title: string, description: string, submitLabel: string, action: (remote: string) => void) => {
      if (remotes.length === 0) {
        toast({
          tone: "error",
          title: "No remote configured",
          description: "Add a remote to this repository first (git remote add).",
        });
      } else if (remotes.length === 1) {
        action(remotes[0]!.name);
      } else {
        setPicker({ title, description, submitLabel, onPick: action });
      }
    },
    [remotes, toast],
  );

  const pushTag = useCallback(
    (name: string) =>
      withRemote(
        `Push tag ${name}`,
        "Choose the remote to push the tag to.",
        "Push tag",
        (remote) => void runTag(name, remote, false),
      ),
    [withRemote, runTag],
  );

  const deleteRemoteTag = useCallback(
    (name: string) =>
      withRemote(
        `Delete tag ${name} from a remote`,
        "Choose the remote to delete the tag from.",
        "Continue",
        async (remote) => {
          const ok = await confirm({
            title: `Delete tag ${name} from ${remote}?`,
            description:
              "The tag is removed from the remote. Copies that others already fetched stay on their machines, and your local tag is kept.",
            confirmLabel: "Delete from remote",
            destructive: true,
          });
          if (ok) void runTag(name, remote, true);
        },
      ),
    [withRemote, confirm, runTag],
  );

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
      fetchRemote: (n) => void fetchRemote(n),
      addRemote: () => setRemoteDialog({ edit: null }),
      editRemote: (r) => setRemoteDialog({ edit: r }),
      removeRemote: (r) => void removeRemote(r),
      pull: (mode, autostash) => void pull(mode, autostash),
      push,
      forcePush: () => void forcePush(),
      pushBranch,
      pushTag,
      deleteRemoteTag,
      cancel,
    }),
    [
      remotes,
      activity,
      fetchAll,
      fetchRemote,
      removeRemote,
      pull,
      push,
      forcePush,
      pushBranch,
      pushTag,
      deleteRemoteTag,
      cancel,
    ],
  );

  useEffect(() => {
    actionsRef.current = value;
  }, [value]);

  return (
    <RemoteActionsContext.Provider value={value}>
      {children}
      {remoteDialog && repo && (
        <RemoteDialog
          remote={remoteDialog.edit}
          existing={remotes.map((r) => r.name)}
          onCancel={() => setRemoteDialog(null)}
          onSubmit={async ({ name, url, pushUrl, fetch }) => {
            const editing = remoteDialog.edit;
            const error = editing
              ? await configure("Saving remote", (p) =>
                  gitService.editRemote(p, editing.name, name, url, pushUrl),
                )
              : await configure("Adding remote", (p) => gitService.addRemote(p, name, url));
            if (error) return error.message;
            setRemoteDialog(null);
            toast({
              tone: "success",
              title: editing ? `Saved remote ${name}` : `Added remote ${name}`,
            });
            if (fetch) void fetchRemote(name);
            return null;
          }}
        />
      )}
      {picker && (
        <PublishDialog
          title={picker.title}
          description={picker.description}
          submitLabel={picker.submitLabel}
          remotes={remotes}
          onCancel={() => setPicker(null)}
          onSubmit={(remote) => {
            setPicker(null);
            picker.onPick(remote);
          }}
        />
      )}
    </RemoteActionsContext.Provider>
  );
}
