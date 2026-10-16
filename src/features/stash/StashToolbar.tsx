import { Archive, ArchiveRestore } from "lucide-react";
import { ToolButton } from "../remote/RemoteToolbar";
import { useRemoteActions } from "../remote/RemoteActions";
import type { RepositoryInfo } from "../../types/git";
import { stashLabel, useStashActions } from "./StashActions";

/** Stash and Pop for the title bar. */
export function StashToolbar({ repo, busy }: { repo: RepositoryInfo; busy: boolean }) {
  const stash = useStashActions();
  const remote = useRemoteActions();
  const locked = busy || remote.activity !== null;
  const conflicts = repo.changes.some((c) => c.conflict);
  const latest = stash.stashes[0] ?? null;

  return (
    <div className="bl-remote-toolbar" role="group" aria-label="Stash">
      <ToolButton
        icon={<Archive size={15} aria-hidden />}
        label="Stash"
        title={
          repo.totalChanges === 0
            ? "No changes to stash"
            : conflicts
              ? "Resolve conflicts before stashing"
              : "Put uncommitted changes aside"
        }
        running={false}
        disabled={locked || repo.totalChanges === 0 || conflicts}
        onClick={stash.save}
      />
      <ToolButton
        icon={<ArchiveRestore size={15} aria-hidden />}
        label="Pop"
        title={latest ? `Pop “${stashLabel(latest)}”` : "No stashes"}
        running={false}
        disabled={locked || !latest}
        onClick={() => latest && stash.pop(latest)}
      />
    </div>
  );
}
