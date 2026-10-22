import { FilePen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Spinner } from "../../components/Spinner";
import { relativeTime } from "../../lib/format";
import { useVirtualRows } from "../../lib/useVirtualRows";
import type { HeadState } from "../../types/git";
import { Avatar } from "./Avatar";
import { GraphCell } from "./GraphCell";
import { RefBadges } from "./RefBadges";
import type { SelectMode } from "./selection";
import type { HistoryData } from "./useHistory";

export const HISTORY_ROW_HEIGHT = 30;
/** Columns beyond this many lanes are clipped to keep the list readable. */
const MAX_LANES = 12;

/** Lanes shown in the graph column (shared by header and rows so they align). */
export function graphLanes(data: HistoryData): number {
  return Math.min(
    MAX_LANES,
    data.rows.reduce((m, r) => Math.max(m, r.width), 1),
  );
}

export function graphColumnWidth(data: HistoryData | null): string {
  const lanes = data ? graphLanes(data) : 1;
  // Never narrower than the "Graph" column label.
  return `${Math.max(48, 20 + (lanes - 1) * 14)}px`;
}

export function CommitList({
  data,
  head,
  selectedOid,
  selectedOids,
  onSelect,
  onClearSelection,
  onNearEnd,
  loadingMore,
  onContextMenu,
  rowProps,
}: {
  data: HistoryData;
  head: HeadState;
  /** The focused commit (shown in the details panel). */
  selectedOid: string | null;
  /** All selected commits; contains `selectedOid` unless several are selected. */
  selectedOids: ReadonlySet<string>;
  /** Select a commit: replace the selection, add/remove it, or extend a range to it. */
  onSelect: (oid: string, mode?: SelectMode) => void;
  /** Go back from several selected commits to just the focused one. */
  onClearSelection?: () => void;
  onNearEnd: () => void;
  loadingMore: boolean;
  /** Open the commit's context menu at a screen position. */
  onContextMenu?: (oid: string, at: { x: number; y: number }) => void;
  /** Extra props per row, for example to accept dropped branches. */
  rowProps?: (oid: string) => Record<string, unknown>;
}) {
  const baseId = useId();
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const count = data.commits.length;
  const virtual = useVirtualRows(scrollEl, count, HISTORY_ROW_HEIGHT, 15);
  const headOid = head.kind === "unborn" ? null : head.oid;
  const lanes = graphLanes(data);
  const activeIndex = selectedOid ? data.commits.findIndex((c) => c.oid === selectedOid) : -1;

  // Fetch the next page before the user reaches the end.
  useEffect(() => {
    if (virtual.end >= count - 40) onNearEnd();
  }, [virtual.end, count, onNearEnd]);

  const { scrollToRow } = virtual;
  useEffect(() => {
    if (activeIndex >= 0) scrollToRow(activeIndex);
  }, [activeIndex, scrollToRow]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (count === 0) return;
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const el = document.getElementById(`${baseId}-${activeIndex}`);
      if (el && activeIndex >= 0) {
        const r = el.getBoundingClientRect();
        onContextMenu?.(data.commits[activeIndex]!.oid, { x: r.left + 120, y: r.bottom });
      }
      return;
    }
    if (e.key === "Escape" && selectedOids.size > 1) {
      e.preventDefault();
      onClearSelection?.();
      return;
    }
    if (e.key === " " && (e.metaKey || e.ctrlKey) && activeIndex >= 0) {
      e.preventDefault();
      onSelect(data.commits[activeIndex]!.oid, "toggle");
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(count - 1, activeIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, activeIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else if (e.key === "PageDown") next = Math.min(count - 1, Math.max(0, activeIndex) + 20);
    else if (e.key === "PageUp") next = Math.max(0, activeIndex - 20);
    else return;
    e.preventDefault();
    onSelect(data.commits[next]!.oid, e.shiftKey ? "range" : "replace");
  };
  const multi = selectedOids.size > 1;

  return (
    <div
      ref={setScrollEl}
      className="bl-commits"
      role="listbox"
      aria-label="Commits"
      aria-multiselectable
      tabIndex={0}
      aria-activedescendant={activeIndex >= 0 ? `${baseId}-${activeIndex}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={virtual.onScroll}
    >
      <div
        className="bl-commits__canvas"
        style={{ height: virtual.totalHeight + (loadingMore ? HISTORY_ROW_HEIGHT : 0) }}
      >
        {data.commits.slice(virtual.start, virtual.end).map((commit, i) => {
          const index = virtual.start + i;
          const row = data.rows[index]!;
          const isHead = commit.oid === headOid;
          return (
            <div
              key={commit.oid}
              id={`${baseId}-${index}`}
              role="option"
              aria-selected={multi ? selectedOids.has(commit.oid) : commit.oid === selectedOid}
              aria-setsize={data.total}
              aria-posinset={index + 1}
              className={`bl-commit-row${isHead ? " bl-commit-row--head" : ""}${
                multi && commit.oid === selectedOid ? " bl-commit-row--focus" : ""
              }`}
              style={{ transform: `translateY(${index * HISTORY_ROW_HEIGHT}px)` }}
              {...rowProps?.(commit.oid)}
              onClick={(e) =>
                onSelect(
                  commit.oid,
                  e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace",
                )
              }
              onContextMenu={(e) => {
                e.preventDefault();
                // Right-clicking one of several selected commits keeps the selection.
                if (!(multi && selectedOids.has(commit.oid))) onSelect(commit.oid);
                onContextMenu?.(commit.oid, { x: e.clientX, y: e.clientY });
              }}
            >
              <span className="bl-commit-row__graph">
                <GraphCell row={row} height={HISTORY_ROW_HEIGHT} lanes={lanes} isHead={isHead} />
              </span>
              <span className="bl-commit-row__message">
                <RefBadges
                  refs={data.refsByOid.get(commit.oid)}
                  head={head}
                  isHeadCommit={isHead}
                />
                <span className={`truncate${row.isMerge ? " bl-commit-row__merge" : ""}`}>
                  {commit.summary}
                </span>
              </span>
              <span className="bl-commit-row__author">
                <Avatar name={commit.authorName} email={commit.authorEmail} />
                <span className="truncate">{commit.authorName}</span>
              </span>
              <time
                className="bl-commit-row__date"
                dateTime={new Date(commit.authorTime * 1000).toISOString()}
                title={new Date(commit.authorTime * 1000).toLocaleString()}
              >
                {relativeTime(commit.authorTime * 1000)}
              </time>
              <span className="bl-commit-row__sha mono">{commit.oid.slice(0, 7)}</span>
            </div>
          );
        })}
        {loadingMore && (
          <div
            className="bl-commits__more"
            role="status"
            style={{ transform: `translateY(${count * HISTORY_ROW_HEIGHT}px)` }}
          >
            <Spinner size={12} /> Loading more commits…
          </div>
        )}
      </div>
    </div>
  );
}

/** Banner row linking back to uncommitted work. */
export function WorkInProgressRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button type="button" className="bl-wip-row" onClick={onOpen}>
      <span className="bl-wip-row__dot" aria-hidden />
      <FilePen size={14} aria-hidden />
      <span>
        Uncommitted changes{" "}
        <span className="text-muted">
          · {count.toLocaleString()} {count === 1 ? "file" : "files"}
        </span>
      </span>
      <span className="bl-wip-row__action">Review changes</span>
    </button>
  );
}
