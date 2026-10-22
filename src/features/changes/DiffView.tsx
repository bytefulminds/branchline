import { Check, CircleAlert, FileWarning, GitMerge, Minus, Plus, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { StatusLetter } from "../../components/StatusLetter";
import { splitPath } from "../../lib/format";
import { useElementSize, useVirtualRows } from "../../lib/useVirtualRows";
import { gitService } from "../../services/git";
import type { FileDiff, GitError, HunkSelection, LineAction } from "../../types/git";
import { STATUS_META, type ChangeEntry } from "./changeModel";
import {
  CONFLICT_MARKER,
  diffAreaFor,
  diffRows,
  isChangeLine,
  longestLine,
  selectRange,
  selectionCount,
  toSelections,
  toggleLine,
  type DiffRow,
  type LineSelection,
} from "./diffModel";
import type { FileAction } from "./FileList";
import "./DiffView.css";

export const DIFF_ROW_HEIGHT = 22;
export { formatBytes };
const EMPTY: LineSelection = new Map();

export interface DiffViewProps {
  repoPath: string;
  /** Changes whenever the repository was re-read; the diff reloads with it. */
  revision: number;
  entry: ChangeEntry;
  busy: boolean;
  onFileAction: (action: FileAction, entries: ChangeEntry[]) => void;
  onLineAction: (
    action: LineAction,
    diff: FileDiff,
    selections: HunkSelection[],
  ) => Promise<boolean>;
  /** Open the merge editor for a conflicted file. */
  onOpenMerge?: (entry: ChangeEntry) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const LINE_ACTION_LABEL: Record<LineAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discard: "Discard",
};

export function DiffView({
  repoPath,
  revision,
  entry,
  busy,
  onFileAction,
  onLineAction,
  onOpenMerge,
}: DiffViewProps) {
  const area = diffAreaFor(entry);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<GitError | null>(null);
  const [force, setForce] = useState(false);
  const [selection, setSelection] = useState<LineSelection>(EMPTY);
  const anchor = useRef<{ hunk: number; line: number } | null>(null);
  const requestId = useRef(0);
  // The view is keyed per file by its parent, so only refreshes and `force` reload here.
  const requestKey = `${repoPath}|${revision}|${force}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    const id = ++requestId.current;
    gitService
      .fileDiff(repoPath, entry.path, entry.originalPath, area, force)
      .then((d) => {
        if (id !== requestId.current) return;
        setDiff((prev) => {
          // A changed diff invalidates selected line indices.
          if (prev?.fingerprint !== d.fingerprint) setSelection(EMPTY);
          return d;
        });
        setError(null);
      })
      .catch((e: GitError) => {
        if (id !== requestId.current) return;
        setError(e);
        setDiff(null);
      })
      .finally(() => {
        if (id === requestId.current) setLoadedKey(requestKey);
      });
  }, [repoPath, entry.path, entry.originalPath, area, force, requestKey]);

  const rows = useMemo(() => (diff ? diffRows(diff, area !== "conflicted") : []), [diff, area]);
  const { name, dir } = splitPath(entry.path);
  const count = selectionCount(selection);
  const partial = !!diff?.supportsPartial && !busy;

  const lineAction = async (action: LineAction, selections: HunkSelection[]) => {
    if (!diff) return;
    const ok = await onLineAction(action, diff, selections);
    if (ok) setSelection(EMPTY);
  };

  const onLineClick = (e: React.MouseEvent, hunk: number, line: number) => {
    if (!diff?.supportsPartial || !isChangeLine(diff, hunk, line)) return;
    if (e.shiftKey && anchor.current?.hunk === hunk) {
      setSelection((s) => selectRange(diff, s, hunk, anchor.current!.line, line));
    } else {
      setSelection((s) => toggleLine(s, hunk, line));
      anchor.current = { hunk, line };
    }
  };

  // Header actions for the whole file.
  const fileActions = (() => {
    if (entry.area === "conflicted")
      return (
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={<Check size={14} aria-hidden />}
            disabled={busy}
            onClick={() => onFileAction("stage", [entry])}
          >
            Mark as resolved
          </Button>
          {onOpenMerge && (
            <Button
              size="sm"
              variant="primary"
              icon={<GitMerge size={14} aria-hidden />}
              disabled={busy}
              onClick={() => onOpenMerge(entry)}
            >
              Resolve in merge editor
            </Button>
          )}
        </>
      );
    if (entry.area === "staged")
      return (
        <Button
          size="sm"
          icon={<Minus size={14} aria-hidden />}
          disabled={busy}
          onClick={() => onFileAction("unstage", [entry])}
        >
          Unstage file
        </Button>
      );
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 size={14} aria-hidden />}
          disabled={busy}
          onClick={() => onFileAction("discard", [entry])}
        >
          {entry.status === "untracked" ? "Delete file" : "Discard file"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={14} aria-hidden />}
          disabled={busy}
          onClick={() => onFileAction("stage", [entry])}
        >
          Stage file
        </Button>
      </>
    );
  })();

  const lineActions: LineAction[] = entry.area === "staged" ? ["unstage"] : ["discard", "stage"];

  return (
    <section className="bl-diff" aria-label={`Changes in ${entry.path}`}>
      <header className="bl-diff__header">
        <div className="bl-diff__title">
          <StatusLetter status={entry.status} />
          <div className="bl-diff__name">
            <h2 className="text-h3 truncate selectable" title={entry.path}>
              {name}
            </h2>
            <span className="text-small text-muted truncate selectable">
              {entry.originalPath
                ? `${entry.originalPath} → ${entry.path}`
                : dir || "repository root"}
            </span>
          </div>
          {diff && (diff.additions > 0 || diff.deletions > 0) && (
            <span
              className="bl-diff__stats mono"
              aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}
            >
              <span className="bl-diff__add">+{diff.additions}</span>
              <span className="bl-diff__del">−{diff.deletions}</span>
            </span>
          )}
          {loading && diff && <Spinner size={14} label="Updating diff" />}
        </div>
        <div className="bl-diff__actions">
          {count > 0 ? (
            <>
              <span className="text-small text-secondary bl-diff__count" role="status">
                {count} {count === 1 ? "line" : "lines"} selected
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<X size={14} aria-hidden />}
                onClick={() => setSelection(EMPTY)}
              >
                Clear
              </Button>
              {lineActions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === "discard" ? "danger" : "primary"}
                  disabled={busy}
                  onClick={() => void lineAction(action, toSelections(selection))}
                >
                  {LINE_ACTION_LABEL[action]} {count === 1 ? "line" : "lines"}
                </Button>
              ))}
            </>
          ) : (
            fileActions
          )}
        </div>
      </header>

      {diff && (diff.change || (diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode)) && (
        <div className="bl-diff__meta text-small">
          {diff.change === "new" && <Badge tone="success">New file</Badge>}
          {diff.change === "deleted" && <Badge tone="error">Deleted file</Badge>}
          {diff.change === "renamed" && <Badge tone="info">Renamed</Badge>}
          {diff.change === "copied" && <Badge tone="info">Copied</Badge>}
          {diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode && (
            <span className="text-secondary">
              Mode <span className="mono">{diff.oldMode}</span> →{" "}
              <span className="mono">{diff.newMode}</span>
            </span>
          )}
          {!diff.supportsPartial && diff.hunks.length > 0 && area !== "conflicted" && (
            <span className="text-muted">Whole-file staging only</span>
          )}
        </div>
      )}

      {area === "conflicted" && diff && (
        <div className="bl-diff__banner" role="status">
          <CircleAlert size={16} aria-hidden />
          <span>
            {diff.hasConflictMarkers
              ? "This file has conflicts. Resolve them in the merge editor, or edit the file yourself and mark it as resolved."
              : "No conflict markers remain. Mark the file as resolved to continue."}
          </span>
        </div>
      )}

      <DiffBody
        diff={diff}
        rows={rows}
        error={error}
        loading={loading}
        conflict={entry.area === "conflicted"}
        binaryNote={`${STATUS_META[entry.status].label}. Binary files can be staged or discarded as a whole.`}
        selection={selection}
        partial={partial}
        lineActions={lineActions}
        onLineClick={onLineClick}
        onHunkAction={(action, hunk) => void lineAction(action, [{ hunk, lines: null }])}
        onShowLarge={() => setForce(true)}
        onClearSelection={() => setSelection(EMPTY)}
      />
    </section>
  );
}

/** Scrollable, virtualized diff content. Also used read-only for commit diffs. */
export function DiffBody({
  diff,
  rows,
  error,
  loading,
  conflict = false,
  binaryNote = "Binary files are not shown as text.",
  selection = EMPTY,
  partial = false,
  lineActions = [],
  onLineClick = () => {},
  onHunkAction = () => {},
  onShowLarge,
  onClearSelection = () => {},
}: {
  diff: FileDiff | null;
  rows: DiffRow[];
  error: GitError | null;
  loading: boolean;
  /** Highlight conflict markers. */
  conflict?: boolean;
  binaryNote?: string;
  selection?: LineSelection;
  partial?: boolean;
  lineActions?: LineAction[];
  onLineClick?: (e: React.MouseEvent, hunk: number, line: number) => void;
  onHunkAction?: (action: LineAction, hunk: number) => void;
  onShowLarge: () => void;
  onClearSelection?: () => void;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtual = useVirtualRows(scrollEl, rows.length, DIFF_ROW_HEIGHT, 20);
  const width = useMemo(() => (diff ? longestLine(diff) : 0), [diff]);
  const viewport = useElementSize(scrollEl).width;

  if (error)
    return (
      <EmptyState
        role="alert"
        tone="error"
        icon={<CircleAlert size={22} aria-hidden />}
        title="Could not load the diff"
        description={error.detail ?? error.message}
      />
    );
  if (!diff)
    return loading ? (
      <div className="bl-diff__loading" role="status">
        <Spinner size={18} /> Loading diff…
      </div>
    ) : null;
  if (diff.tooLarge)
    return (
      <EmptyState
        icon={<FileWarning size={22} aria-hidden />}
        title="Large diff not shown"
        description={`This diff is larger than ${formatBytes(diff.sizeBytes)}. Showing it may take a moment.`}
      >
        <Button onClick={onShowLarge}>Show diff anyway</Button>
      </EmptyState>
    );
  if (diff.isBinary)
    return (
      <EmptyState
        icon={<FileWarning size={22} aria-hidden />}
        title="Binary file"
        description={binaryNote}
      />
    );
  if (diff.hunks.length === 0)
    return (
      <EmptyState
        title="No content changes"
        description={diff.change === "new" ? "This file is empty." : "Only file metadata changed."}
      />
    );

  return (
    <div
      ref={setScrollEl}
      className="bl-diff__scroll"
      onScroll={virtual.onScroll}
      tabIndex={0}
      aria-label="Diff"
      onKeyDown={(e) => e.key === "Escape" && onClearSelection()}
    >
      <div
        className="bl-diff__canvas mono"
        style={
          {
            height: virtual.totalHeight,
            width: `max(100%, calc(var(--diff-gutter) + ${width}ch + 48px))`,
            "--diff-viewport": viewport ? `${viewport}px` : "100%",
          } as React.CSSProperties
        }
      >
        {rows.slice(virtual.start, virtual.end).map((row, i) => {
          const top = (virtual.start + i) * DIFF_ROW_HEIGHT;
          const style = { transform: `translateY(${top}px)` };
          const hunk = diff.hunks[row.hunk]!;
          if (row.type === "hunk") {
            return (
              <div key={`h${row.hunk}`} className="bl-diff-row bl-diff-row--hunk" style={style}>
                <div className="bl-diff-hunk">
                  <span className="bl-diff-hunk__range">
                    @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                  </span>
                  <span className="bl-diff-hunk__section truncate">{hunk.section}</span>
                  {partial && (
                    <span className="bl-diff-hunk__actions">
                      {lineActions.map((action) => (
                        <button
                          key={action}
                          type="button"
                          className={`bl-hunk-action${action === "discard" ? " bl-hunk-action--danger" : ""}`}
                          onClick={() => onHunkAction(action, row.hunk)}
                        >
                          {LINE_ACTION_LABEL[action]} hunk
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          }
          const line = hunk.lines[row.line]!;
          if (row.type === "noNewline") {
            return (
              <div
                key={`n${row.hunk}-${row.line}`}
                className="bl-diff-row bl-diff-row--note"
                style={style}
              >
                <span className="bl-diff-gutter" aria-hidden />
                <span className="bl-diff-content">No newline at end of file</span>
              </div>
            );
          }
          const selectable = partial && line.kind !== "context";
          const selected = selection.get(row.hunk)?.has(row.line) ?? false;
          const isMarker = conflict && CONFLICT_MARKER.test(line.content);
          return (
            <div
              key={`l${row.hunk}-${row.line}`}
              className={[
                "bl-diff-row",
                `bl-diff-row--${line.kind}`,
                selectable && "bl-diff-row--selectable",
                selected && "bl-diff-row--selected",
                isMarker && "bl-diff-row--conflict",
              ]
                .filter(Boolean)
                .join(" ")}
              style={style}
              aria-selected={selectable ? selected : undefined}
              onClick={selectable ? (e) => onLineClick(e, row.hunk, row.line) : undefined}
            >
              <span className="bl-diff-gutter" aria-hidden>
                <span className="bl-diff-no">{line.oldLine ?? ""}</span>
                <span className="bl-diff-no">{line.newLine ?? ""}</span>
                <span className="bl-diff-sign">
                  {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""}
                </span>
              </span>
              <span className="bl-diff-content">
                <span className="visually-hidden">
                  {line.kind === "add" ? "added: " : line.kind === "delete" ? "removed: " : ""}
                </span>
                {line.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
