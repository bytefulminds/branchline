import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitMerge,
  Minus,
  Plus,
  Undo2,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Count } from "../../components/Badge";
import { StatusLetter } from "../../components/StatusLetter";
import { splitPath } from "../../lib/format";
import { useVirtualRows } from "../../lib/useVirtualRows";
import {
  AREA_LABEL,
  AREA_ORDER,
  type ChangeArea,
  type ChangeEntry,
  type GroupedChanges,
} from "./changeModel";
import "./FileList.css";

export type FileAction = "stage" | "unstage" | "discard";

export interface FileListProps {
  groups: GroupedChanges;
  selectedId: string | null;
  onSelect: (entry: ChangeEntry) => void;
  onAction: (action: FileAction, entries: ChangeEntry[]) => void;
  /** Open the merge editor for a conflicted file. */
  onOpenMerge?: (entry: ChangeEntry) => void;
  /** Disable actions while a write operation runs. */
  busy?: boolean;
}

export const ROW_HEIGHT = 28;

type Row =
  | { type: "header"; area: ChangeArea; count: number }
  | { type: "entry"; entry: ChangeEntry; index: number; area: ChangeArea };

/** The action Space/Enter performs for an entry. */
export function primaryAction(entry: ChangeEntry): FileAction {
  return entry.area === "staged" ? "unstage" : "stage";
}

const ACTION_LABEL: Record<FileAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discard: "Discard changes",
};

/**
 * Mouse shortcuts on a row. They are not buttons: interactive elements inside a list option
 * cannot be used reliably with screen readers. Keyboard and screen reader users stage with
 * Space or Enter and discard with Delete (or use the command palette).
 */
function RowAction({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`bl-row-action${danger ? " bl-row-action--danger" : ""}`}
      data-disabled={disabled || undefined}
      data-tooltip={label}
      data-tooltip-align="end"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
    >
      {children}
    </span>
  );
}

function RowActions({
  entry,
  busy,
  onAction,
  onOpenMerge,
}: {
  entry: ChangeEntry;
  busy?: boolean;
  onAction: FileListProps["onAction"];
  onOpenMerge?: FileListProps["onOpenMerge"];
}) {
  if (entry.area === "conflicted") {
    return (
      <span className="bl-file-row__actions" aria-hidden="true">
        {onOpenMerge && (
          <RowAction
            label="Resolve in merge editor"
            disabled={busy}
            onClick={() => onOpenMerge(entry)}
          >
            <GitMerge size={14} aria-hidden />
          </RowAction>
        )}
        <RowAction
          label="Mark as resolved"
          disabled={busy}
          onClick={() => onAction("stage", [entry])}
        >
          <Check size={14} aria-hidden />
        </RowAction>
      </span>
    );
  }
  return (
    <span className="bl-file-row__actions" aria-hidden="true">
      {entry.area === "unstaged" && (
        <RowAction
          label="Discard changes"
          danger
          disabled={busy}
          onClick={() => onAction("discard", [entry])}
        >
          <Undo2 size={14} aria-hidden />
        </RowAction>
      )}
      <RowAction
        label={ACTION_LABEL[primaryAction(entry)]}
        disabled={busy}
        onClick={() => onAction(primaryAction(entry), [entry])}
      >
        {entry.area === "staged" ? <Minus size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
      </RowAction>
    </span>
  );
}

/**
 * Changed files grouped by area in a single, virtualized, keyboard-navigable listbox.
 *
 * Keys: arrows, Home/End, PageUp/PageDown move; Space or Enter stages/unstages;
 * Delete or Backspace discards unstaged changes.
 */
export function FileList({
  groups,
  selectedId,
  onSelect,
  onAction,
  onOpenMerge,
  busy,
}: FileListProps) {
  const baseId = useId();
  const [collapsed, setCollapsed] = useState<Record<ChangeArea, boolean>>({
    conflicted: false,
    unstaged: false,
    staged: false,
  });
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const { rows, entries } = useMemo(() => {
    const rows: Row[] = [];
    const entries: ChangeEntry[] = [];
    for (const area of AREA_ORDER) {
      const list = groups[area];
      if (list.length === 0) continue;
      rows.push({ type: "header", area, count: list.length });
      if (collapsed[area]) continue;
      for (const entry of list) {
        rows.push({ type: "entry", entry, index: entries.length, area });
        entries.push(entry);
      }
    }
    return { rows, entries };
  }, [groups, collapsed]);

  const virtual = useVirtualRows(scrollEl, rows.length, ROW_HEIGHT);
  const activeIndex = entries.findIndex((e) => e.id === selectedId);
  const activeRow = rows.findIndex((r) => r.type === "entry" && r.entry.id === selectedId);
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const { scrollToRow } = virtual;
  useEffect(() => {
    if (activeRow >= 0) scrollToRow(activeRow);
  }, [activeRow, scrollToRow]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (entries.length === 0) return;
    const current = entries[activeIndex];
    if ((e.key === " " || e.key === "Enter") && current) {
      e.preventDefault();
      if (!busy) onAction(primaryAction(current), [current]);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && current) {
      e.preventDefault();
      if (!busy && current.area === "unstaged") onAction("discard", [current]);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(entries.length - 1, activeIndex + 1);
    else if (e.key === "ArrowUp") next = activeIndex < 0 ? 0 : Math.max(0, activeIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = entries.length - 1;
    else if (e.key === "PageDown")
      next = Math.min(entries.length - 1, Math.max(0, activeIndex) + 10);
    else if (e.key === "PageUp") next = Math.max(0, activeIndex - 10);
    else return;
    e.preventDefault();
    const entry = entries[next];
    if (entry) onSelect(entry);
  };

  const visibleRows = rows.slice(virtual.start, virtual.end);

  return (
    <div
      ref={setScrollEl}
      className="bl-file-list"
      role="listbox"
      aria-label="Changed files"
      aria-busy={busy || undefined}
      tabIndex={0}
      aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
      onKeyDown={onKeyDown}
      onScroll={virtual.onScroll}
    >
      <div className="bl-file-list__canvas" style={{ height: virtual.totalHeight }}>
        {groupByArea(visibleRows, virtual.start).map((group) => (
          // Options are grouped per area so screen readers announce "Staged changes" and so on.
          <div
            key={group.area}
            role="group"
            aria-label={`${AREA_LABEL[group.area]} (${groups[group.area].length})`}
            className="bl-file-list__group"
          >
            {group.rows.map(({ row, position }) => renderRow(row, position))}
          </div>
        ))}
      </div>
    </div>
  );

  function renderRow(row: Row, position: number) {
    const top = position * ROW_HEIGHT;
    if (row.type === "header") {
      const isCollapsed = collapsed[row.area];
      const all = groups[row.area];
      return (
        <div
          key={`h-${row.area}`}
          aria-hidden="true"
          className={`bl-file-group bl-file-group--${row.area}`}
          style={{ transform: `translateY(${top}px)` }}
        >
          <button
            type="button"
            className="bl-file-group__toggle"
            aria-expanded={!isCollapsed}
            tabIndex={-1}
            onClick={() => setCollapsed((c) => ({ ...c, [row.area]: !c[row.area] }))}
          >
            {isCollapsed ? (
              <ChevronRight size={14} aria-hidden />
            ) : (
              <ChevronDown size={14} aria-hidden />
            )}
            <span className="bl-file-group__label">{AREA_LABEL[row.area]}</span>
          </button>
          <Count value={row.count} tone={row.area === "conflicted" ? "error" : "neutral"} />
          {row.area !== "conflicted" && (
            <button
              type="button"
              tabIndex={-1}
              disabled={busy}
              className="bl-file-group__action"
              onClick={() => onAction(row.area === "staged" ? "unstage" : "stage", all)}
            >
              {row.area === "staged" ? "Unstage all" : "Stage all"}
            </button>
          )}
        </div>
      );
    }
    const { entry, index } = row;
    const { name, dir } = splitPath(entry.path);
    const selected = entry.id === selectedId;
    return (
      <div
        key={entry.id}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        aria-setsize={entries.length}
        aria-posinset={index + 1}
        className="bl-file-row"
        style={{ transform: `translateY(${top}px)` }}
        title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
        onClick={() => onSelect(entry)}
      >
        <StatusLetter status={entry.status} />
        {entry.isSubmodule && (
          <FolderGit2 size={14} aria-label="Submodule" className="bl-file-row__sub" />
        )}
        <span className="bl-file-row__name truncate">{name}</span>
        {dir && <span className="bl-file-row__dir truncate">{dir}</span>}
        <RowActions entry={entry} busy={busy} onAction={onAction} onOpenMerge={onOpenMerge} />
      </div>
    );
  }
}

/** Consecutive visible rows of the same area, with their absolute row positions. */
function groupByArea(rows: Row[], start: number) {
  const groups: { area: ChangeArea; rows: { row: Row; position: number }[] }[] = [];
  rows.forEach((row, i) => {
    const last = groups[groups.length - 1];
    if (last?.area === row.area) last.rows.push({ row, position: start + i });
    else groups.push({ area: row.area, rows: [{ row, position: start + i }] });
  });
  return groups;
}
