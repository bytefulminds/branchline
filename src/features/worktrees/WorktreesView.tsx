import {
  Copy,
  FolderGit2,
  FolderInput,
  FolderPlus,
  FolderTree,
  FolderX,
  GitBranch,
  Lock,
  LockOpen,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect } from "react";
import { Button } from "../../components/Button";
import { anchorOf, useContextMenu } from "../../components/ContextMenu";
import { EmptyState } from "../../components/EmptyState";
import type { MenuEntry } from "../../components/Menu";
import { Spinner } from "../../components/Spinner";
import { displayPath, plural } from "../../lib/format";
import type { RepositoryInfo, WorktreeInfo } from "../../types/git";
import { useWorktreeActions } from "./WorktreeActions";
import "../branches/BranchesView.css";
import "./Worktrees.css";

function describe(w: WorktreeInfo): string {
  if (w.prunable) return "Folder is missing";
  if (w.bare) return "Bare repository";
  if (w.branch) return w.branch;
  return w.head ? `Detached at ${w.head.slice(0, 7)}` : "Detached";
}

export function WorktreesView({ repo, busy }: { repo: RepositoryInfo; busy: boolean }) {
  const { worktrees, create, open, remove, setLocked, prune, refresh } = useWorktreeActions();
  const showMenu = useContextMenu();

  // Change counts can be stale; reload whenever the view opens.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const menu = (w: WorktreeInfo): MenuEntry[] => [
    {
      id: "open",
      label: "Open in Branchline",
      icon: <FolderInput size={16} />,
      disabled: w.isCurrent || !!w.prunable || w.bare,
      onSelect: () => open(w.path),
    },
    {
      id: "copy",
      label: "Copy folder path",
      icon: <Copy size={16} />,
      onSelect: () => void navigator.clipboard?.writeText(w.path).catch(() => {}),
    },
    { type: "separator", id: "sep" },
    {
      id: "lock",
      label: w.locked !== null ? "Unlock" : "Lock",
      description:
        w.locked !== null
          ? "Allow removing and cleaning it up again"
          : "Keep Git from cleaning it up, for example on a removable drive",
      icon: w.locked !== null ? <LockOpen size={16} /> : <Lock size={16} />,
      disabled: w.isMain || busy,
      onSelect: () => setLocked(w, w.locked === null),
    },
    {
      id: "remove",
      label: "Remove…",
      description: w.isMain
        ? "The main worktree stays"
        : w.isCurrent
          ? "Open another worktree first"
          : w.locked !== null
            ? "Unlock it first"
            : undefined,
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: w.isMain || w.isCurrent || w.locked !== null || busy,
      onSelect: () => remove(w),
    },
  ];

  if (!worktrees) {
    return (
      <div className="bl-history__loading" role="status">
        <Spinner size={18} /> Loading worktrees…
      </div>
    );
  }

  const missing = worktrees.filter((w) => w.prunable).length;

  return (
    <section className="bl-branches" aria-label="Worktrees">
      <div className="bl-branches__header">
        <div className="bl-branches__title">
          <h1 className="text-h2">Worktrees</h1>
          <span className="text-small text-secondary">{plural(worktrees.length, "worktree")}</span>
        </div>
        {missing > 0 && (
          <Button
            variant="ghost"
            icon={<FolderX size={16} aria-hidden />}
            disabled={busy}
            onClick={prune}
          >
            Clean up {missing} missing
          </Button>
        )}
        <Button
          variant="primary"
          icon={<FolderPlus size={16} aria-hidden />}
          disabled={busy || repo.head.kind === "unborn"}
          title={repo.head.kind === "unborn" ? "Create the first commit first" : undefined}
          onClick={() => create()}
        >
          New worktree
        </Button>
      </div>

      <div className="bl-branches__body">
        {worktrees.length <= 1 && (
          <EmptyState
            icon={<FolderTree size={22} aria-hidden />}
            title="Only the main worktree"
            description="A worktree is another folder with a different branch checked out, so you can work on a fix while a feature stays open, without stashing or switching."
          />
        )}
        <ul className="bl-branch-list" aria-label="Worktrees">
          {worktrees.map((w) => {
            const entries = menu(w);
            return (
              <li
                key={w.path}
                className={`bl-branch${w.isCurrent ? " bl-branch--current" : ""}${w.prunable ? " bl-worktree--missing" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showMenu({ x: e.clientX, y: e.clientY }, entries, `Actions for ${w.name}`);
                }}
                onDoubleClick={() => !w.isCurrent && !w.prunable && !w.bare && open(w.path)}
              >
                <span className="bl-branch__icon" aria-hidden>
                  <FolderGit2 size={15} />
                </span>
                <span className="bl-branch__main">
                  <span className="bl-branch__name">
                    <span className="truncate">{w.name}</span>
                    {w.isCurrent && <span className="bl-branch__badge">Open</span>}
                    {w.isMain && <span className="bl-tag-kind">main worktree</span>}
                    {w.locked !== null && (
                      <span
                        className="bl-tag-kind bl-worktree__locked"
                        title={w.locked ? `Locked: ${w.locked}` : "Locked"}
                      >
                        <Lock size={10} aria-hidden /> locked
                      </span>
                    )}
                  </span>
                  <span className="bl-branch__meta text-small">
                    <span
                      className={`bl-worktree__branch${w.prunable ? " bl-worktree__branch--missing" : ""}`}
                    >
                      {w.branch && <GitBranch size={12} aria-hidden />}
                      {describe(w)}
                    </span>
                    <span className="truncate text-muted mono" title={w.path}>
                      {displayPath(w.path)}
                    </span>
                  </span>
                </span>
                <span className="bl-branch__time text-small text-muted">
                  {w.changes === null
                    ? ""
                    : w.changes === 0
                      ? "Clean"
                      : plural(w.changes, "change")}
                </span>
                <span className="bl-branch__actions">
                  {!w.isCurrent && !w.prunable && !w.bare && (
                    <Button size="sm" variant="secondary" onClick={() => open(w.path)}>
                      Open
                    </Button>
                  )}
                  <button
                    type="button"
                    className="bl-row-action"
                    aria-label={`More actions for ${w.name}`}
                    aria-haspopup="menu"
                    onClick={(e) =>
                      showMenu(anchorOf(e.currentTarget), entries, `Actions for ${w.name}`)
                    }
                  >
                    <MoreHorizontal size={15} aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
