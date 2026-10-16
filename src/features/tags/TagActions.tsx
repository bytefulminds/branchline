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
import { gitService } from "../../services/git";
import type { GitError, RepositoryInfo, TagInfo } from "../../types/git";
import { useRemoteActions } from "../remote/RemoteActions";
import type { RepositoryController } from "../repository/useRepository";
import { TagDialog } from "./TagDialog";

export interface TagActions {
  tags: TagInfo[] | null;
  /** Ask for a name and message, then tag `target` (a commit id). */
  create: (target: string, targetLabel: string) => void;
  remove: (tag: TagInfo) => void;
}

const noop = () => {};
const TagActionsContext = createContext<TagActions>({ tags: null, create: noop, remove: noop });

export function useTagActions(): TagActions {
  return useContext(TagActionsContext);
}

/** Tags of the open repository, reloaded whenever a ref moves. */
function useTags(repo: RepositoryInfo | null): TagInfo[] | null {
  const key = repo ? `${repo.path}|${repo.refsFingerprint}` : null;
  const [state, setState] = useState<{ path: string; tags: TagInfo[] } | null>(null);
  const latest = useRef(key);
  useEffect(() => {
    latest.current = key;
    if (!key || !repo) return;
    const path = repo.path;
    gitService
      .listTags(path)
      .then((tags) => latest.current === key && setState({ path, tags: tags ?? [] }))
      .catch(() => latest.current === key && setState({ path, tags: [] }));
    // repo.path is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return repo && state?.path === repo.path ? state.tags : null;
}

export function TagActionsProvider({
  repo,
  controller,
  children,
}: {
  repo: RepositoryInfo | null;
  controller: Pick<RepositoryController, "run">;
  children: ReactNode;
}) {
  const tags = useTags(repo);
  const toast = useToast();
  const confirm = useConfirm();
  const remote = useRemoteActions();
  const { run } = controller;
  const [dialog, setDialog] = useState<{ target: string; targetLabel: string } | null>(null);

  const report = useCallback(
    (title: string, error: GitError) => {
      toast({
        tone: error.kind === "stale" ? "info" : "error",
        title: error.kind === "stale" ? "The tag no longer exists" : title,
        description: error.detail ?? error.message,
      });
    },
    [toast],
  );

  const remove = useCallback(
    async (tag: TagInfo) => {
      const ok = await confirm({
        title: `Delete tag ${tag.name}?`,
        description:
          "The tag is removed from this repository; the commit stays. Remotes that already have the tag keep it until you delete it there too.",
        confirmLabel: "Delete tag",
        destructive: true,
      });
      if (!ok) return;
      const error = await run("Deleting tag", (path) => gitService.deleteTag(path, tag.name));
      if (error) report(`Could not delete ${tag.name}`, error);
      else toast({ tone: "success", title: `Deleted tag ${tag.name}` });
    },
    [confirm, run, report, toast],
  );

  const value = useMemo<TagActions>(
    () => ({
      tags,
      create: (target, targetLabel) => setDialog({ target, targetLabel }),
      remove: (t) => void remove(t),
    }),
    [tags, remove],
  );

  return (
    <TagActionsContext.Provider value={value}>
      {children}
      {dialog && repo && (
        <TagDialog
          repoPath={repo.path}
          targetLabel={dialog.targetLabel}
          pushRemote={
            remote.remotes.length === 1
              ? remote.remotes[0]!.name
              : remote.remotes.length > 1
                ? "a remote"
                : null
          }
          onCancel={() => setDialog(null)}
          onSubmit={async (name, message, push) => {
            const error = await run("Creating tag", (path) =>
              gitService.createTag(path, name, dialog.target, message),
            );
            if (error) return error.message;
            setDialog(null);
            if (push) remote.pushTag(name);
            else toast({ tone: "success", title: `Created tag ${name}` });
            return null;
          }}
        />
      )}
    </TagActionsContext.Provider>
  );
}
