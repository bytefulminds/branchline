import { ChevronDown, ChevronRight, FolderGit2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Count } from "../../components/Badge";
import { StatusLetter } from "../../components/StatusLetter";
import { splitPath } from "../../lib/format";
import {
  AREA_LABEL,
  AREA_ORDER,
  type ChangeArea,
  type ChangeEntry,
  type GroupedChanges,
} from "./changeModel";
import "./FileList.css";

export interface FileListProps {
  groups: GroupedChanges;
  selectedId: string | null;
  onSelect: (entry: ChangeEntry) => void;
}

/**
 * Changed files grouped by area, as a single keyboard-navigable listbox.
 * Rows use `content-visibility` so off-screen rows are cheap; full virtualization
 * is planned together with the commit list (Milestone 3).
 */
export function FileList({ groups, selectedId, onSelect }: FileListProps) {
  const baseId = useId();
  const [collapsed, setCollapsed] = useState<Record<ChangeArea, boolean>>({
    conflicted: false,
    unstaged: false,
    staged: false,
  });
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => AREA_ORDER.flatMap((area) => (collapsed[area] ? [] : groups[area])),
    [groups, collapsed],
  );
  const optionId = (e: ChangeEntry) => `${baseId}-${visible.indexOf(e)}`;
  const activeIndex = visible.findIndex((e) => e.id === selectedId);

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (visible.length === 0) return;
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(visible.length - 1, activeIndex + 1);
    else if (e.key === "ArrowUp") next = activeIndex < 0 ? 0 : Math.max(0, activeIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visible.length - 1;
    else if (e.key === "PageDown")
      next = Math.min(visible.length - 1, Math.max(0, activeIndex) + 10);
    else if (e.key === "PageUp") next = Math.max(0, activeIndex - 10);
    else return;
    e.preventDefault();
    const entry = visible[next];
    if (entry) onSelect(entry);
  };

  return (
    <div
      ref={listRef}
      className="bl-file-list"
      role="listbox"
      aria-label="Changed files"
      tabIndex={0}
      aria-activedescendant={
        activeIndex >= 0 && visible[activeIndex] ? optionId(visible[activeIndex]) : undefined
      }
      onKeyDown={onKeyDown}
    >
      {AREA_ORDER.map((area) => {
        const entries = groups[area];
        if (entries.length === 0) return null;
        const headingId = `${baseId}-${area}`;
        const isCollapsed = collapsed[area];
        return (
          <div
            key={area}
            role="group"
            aria-labelledby={headingId}
            className={`bl-file-group bl-file-group--${area}`}
          >
            <button
              type="button"
              id={headingId}
              className="bl-file-group__header"
              aria-expanded={!isCollapsed}
              tabIndex={-1}
              onClick={() => setCollapsed((c) => ({ ...c, [area]: !c[area] }))}
            >
              {isCollapsed ? (
                <ChevronRight size={14} aria-hidden />
              ) : (
                <ChevronDown size={14} aria-hidden />
              )}
              <span className="bl-file-group__label">{AREA_LABEL[area]}</span>
              <Count value={entries.length} tone={area === "conflicted" ? "error" : "neutral"} />
            </button>
            {!isCollapsed &&
              entries.map((entry) => {
                const { name, dir } = splitPath(entry.path);
                const index = visible.indexOf(entry);
                const selected = entry.id === selectedId;
                return (
                  <div
                    key={entry.id}
                    id={optionId(entry)}
                    data-index={index}
                    role="option"
                    aria-selected={selected}
                    className="bl-file-row"
                    title={
                      entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path
                    }
                    onClick={() => onSelect(entry)}
                  >
                    <StatusLetter status={entry.status} />
                    {entry.isSubmodule && (
                      <FolderGit2 size={14} aria-label="Submodule" className="bl-file-row__sub" />
                    )}
                    <span className="bl-file-row__name truncate">{name}</span>
                    {dir && <span className="bl-file-row__dir truncate">{dir}</span>}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
