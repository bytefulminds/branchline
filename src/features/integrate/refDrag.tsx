import { Check, GitMerge, GitPullRequestArrow } from "lucide-react";
import { useCallback, useState, type DragEvent } from "react";
import { useContextMenu } from "../../components/ContextMenu";
import type { MenuEntry } from "../../components/Menu";
import type { RepositoryInfo } from "../../types/git";
import "./refDrag.css";
import { useBranchActions } from "../branches/BranchActions";
import { useIntegrateActions } from "./IntegrateActions";

/** Drag data type for branches; other drags (files, text) are ignored. */
export const REF_MIME = "application/x-branchline-ref";

export interface DraggedRef {
  /** `main`, or `origin/main` for a remote branch. */
  name: string;
  remote: boolean;
}

export type DropTarget =
  { kind: "branch"; name: string } | { kind: "commit"; oid: string; branches: string[] };

/**
 * Show a small labelled pill under the pointer instead of the browser's snapshot
 * of the dragged element (which some webviews render as a blank white box).
 */
export function setDragGhost(e: DragEvent, label: string) {
  if (typeof e.dataTransfer?.setDragImage !== "function") return;
  const ghost = document.createElement("div");
  ghost.className = "bl-drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  // The image is captured synchronously; the element is no longer needed.
  window.setTimeout(() => ghost.remove(), 0);
}

/** Props that make an element a draggable branch. */
export function refDragProps(ref: DraggedRef) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData(REF_MIME, JSON.stringify(ref));
      e.dataTransfer.setData("text/plain", ref.name);
      e.dataTransfer.effectAllowed = "move";
      setDragGhost(e, ref.name);
    },
  };
}

function isRefDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(REF_MIME);
}

function readRef(e: DragEvent): DraggedRef | null {
  try {
    const value = JSON.parse(e.dataTransfer.getData(REF_MIME)) as DraggedRef;
    return typeof value?.name === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * What can be done when `source` is dropped on `target`. Merge and rebase always
 * change the checked-out branch, so one side must be the current branch.
 */
export function dropEntries(
  repo: RepositoryInfo,
  source: DraggedRef,
  target: DropTarget,
  actions: {
    merge: (name: string, label: string, kind: "branch" | "commit") => void;
    rebase: (name: string, label: string, kind: "branch" | "commit") => void;
    switchTo: (name: string) => void;
  },
): MenuEntry[] {
  const current = repo.head.kind === "branch" ? repo.head.name : null;
  if (repo.operation) {
    return [{ type: "header", id: "busy", label: "Finish the operation in progress first" }];
  }
  const isCurrent = !source.remote && source.name === current;

  const forBranch = (t: string): MenuEntry[] => {
    if (t === source.name && !source.remote) return [];
    if (t === current) {
      return [
        {
          id: `merge:${t}`,
          label: `Merge ${source.name} into ${t}…`,
          icon: <GitMerge size={16} />,
          onSelect: () => actions.merge(source.name, source.name, "branch"),
        },
        {
          id: `rebase:${t}`,
          label: `Rebase ${t} onto ${source.name}…`,
          icon: <GitPullRequestArrow size={16} />,
          onSelect: () => actions.rebase(source.name, source.name, "branch"),
        },
      ];
    }
    if (isCurrent) {
      return [
        {
          id: `rebase:${t}`,
          label: `Rebase ${source.name} onto ${t}…`,
          icon: <GitPullRequestArrow size={16} />,
          onSelect: () => actions.rebase(t, t, "branch"),
        },
        {
          id: `merge:${t}`,
          label: `Merge ${t} into ${source.name}…`,
          icon: <GitMerge size={16} />,
          onSelect: () => actions.merge(t, t, "branch"),
        },
      ];
    }
    return [
      {
        type: "header",
        id: `hint:${t}`,
        label: `Merging or rebasing changes the current branch`,
      },
      {
        id: `switch:${t}`,
        label: `Switch to ${t}`,
        description: `Then drop ${source.name} on it again`,
        icon: <Check size={16} />,
        onSelect: () => actions.switchTo(t),
      },
    ];
  };

  if (target.kind === "branch") return forBranch(target.name);

  const entries: MenuEntry[] = [];
  for (const t of target.branches) {
    const e = forBranch(t);
    if (e.length && entries.length) entries.push({ type: "separator", id: `sep:${t}` });
    entries.push(...e);
  }
  const headOid = repo.head.kind === "unborn" ? null : repo.head.oid;
  if (isCurrent && target.oid !== headOid) {
    const short = target.oid.slice(0, 7);
    if (entries.length) entries.push({ type: "separator", id: "sep:commit" });
    entries.push({
      id: "rebase:commit",
      label: `Rebase ${source.name} onto commit ${short}…`,
      icon: <GitPullRequestArrow size={16} />,
      onSelect: () => actions.rebase(target.oid, `commit ${short}`, "commit"),
    });
  }
  return entries;
}

/**
 * Drop handling for branch drags: returns a factory of props for drop targets.
 * Dropping opens a menu at the pointer with the possible actions.
 */
export function useRefDrop(repo: RepositoryInfo) {
  const integrate = useIntegrateActions();
  const branches = useBranchActions();
  const showMenu = useContextMenu();
  const [over, setOver] = useState<string | null>(null);

  return useCallback(
    (key: string, target: DropTarget) => ({
      "data-drop-over": over === key || undefined,
      onDragOver: (e: DragEvent) => {
        if (!isRefDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (over !== key) setOver(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) {
          setOver((o) => (o === key ? null : o));
        }
      },
      onDrop: (e: DragEvent) => {
        setOver(null);
        if (!isRefDrag(e)) return;
        e.preventDefault();
        const source = readRef(e);
        if (!source) return;
        const entries = dropEntries(repo, source, target, {
          merge: (name, label, kind) =>
            integrate.merge(
              kind === "branch" ? { kind: "branch", name } : { kind: "commit", oid: name },
              label,
            ),
          rebase: (name, label, kind) =>
            integrate.rebase(
              kind === "branch" ? { kind: "branch", name } : { kind: "commit", oid: name },
              label,
            ),
          switchTo: branches.switchTo,
        });
        if (entries.length === 0) return;
        showMenu({ x: e.clientX, y: e.clientY }, entries, `Drop ${source.name}`);
      },
    }),
    [over, repo, integrate, branches, showMenu],
  );
}
