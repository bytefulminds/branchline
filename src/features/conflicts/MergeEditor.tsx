import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  FileText,
  Redo2,
  RotateCcw,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../../components/Button";
import { useConfirm } from "../../components/ConfirmDialog";
import { Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { splitPath } from "../../lib/format";
import { gitService } from "../../services/git";
import { modKeyLabel } from "../../services/platform";
import type {
  ConflictFile,
  ConflictSide,
  GitError,
  RepositoryInfo,
  ResolveSide,
} from "../../types/git";
import {
  hasMarkers,
  initialState,
  isResolved,
  reduce,
  remaining,
  resultText,
  stripEol,
  textOf,
  type Chunk,
  type MergeAction,
  type MergeState,
  type Side,
} from "./mergeModel";
import "./MergeEditor.css";

/** Unchanged runs longer than this are folded to their first and last lines. */
const FOLD_OVER = 8;
const FOLD_CONTEXT = 3;
const HISTORY_LIMIT = 200;

interface History {
  /** State right after loading (non-conflicting changes taken). */
  initial: MergeState | null;
  past: MergeState[];
  present: MergeState;
  future: MergeState[];
  /** Typing into the same result box is one undo step. */
  typingIn: number | null;
}

type HistoryAction =
  MergeAction | { type: "undo" } | { type: "redo" } | { type: "load"; state: MergeState };

function historyReducer(h: History, action: HistoryAction): History {
  if (action.type === "load") {
    // Take the changes that do not conflict right away, like JetBrains does;
    // Undo brings back the untouched state.
    const present = reduce(action.state, { type: "applyNonConflicting" });
    const tookSome = remaining(present).changes < remaining(action.state).changes;
    return {
      initial: present,
      past: tookSome ? [action.state] : [],
      present,
      future: [],
      typingIn: null,
    };
  }
  if (action.type === "undo") {
    const prev = h.past[h.past.length - 1];
    if (!prev) return h;
    return {
      ...h,
      past: h.past.slice(0, -1),
      present: prev,
      future: [h.present, ...h.future],
      typingIn: null,
    };
  }
  if (action.type === "redo") {
    const [next, ...rest] = h.future;
    if (!next) return h;
    return { ...h, past: [...h.past, h.present], present: next, future: rest, typingIn: null };
  }
  const present = reduce(h.present, action);
  if (present === h.present) return h;
  const typing = action.type === "edit" ? action.id : null;
  if (typing !== null && typing === h.typingIn) return { ...h, present, future: [] };
  return {
    ...h,
    past: [...h.past, h.present].slice(-HISTORY_LIMIT),
    present,
    future: [],
    typingIn: typing,
  };
}

function sideTitle(side: ConflictSide): string {
  return side.commit
    ? `${side.role}: ${side.commit.oid.slice(0, 7)} ${side.commit.summary}`
    : side.role;
}

/** Lines of one pane in a row, with line numbers. */
function Lines({
  lines,
  start,
  tone,
  label,
}: {
  lines: string[];
  start: number;
  tone?: string;
  label?: string;
}) {
  return (
    <div className={`bl-merge__lines${tone ? ` bl-merge__lines--${tone}` : ""}`} aria-label={label}>
      {lines.length === 0 ? (
        <div className="bl-merge__empty" aria-hidden />
      ) : (
        lines.map((l, i) => (
          <div key={i} className="bl-merge__line">
            <span className="bl-merge__ln" aria-hidden>
              {start + i}
            </span>
            <span className="bl-merge__code">{stripEol(l) || " "}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** The buttons disappear once used; keep keyboard focus in the change. */
function focusResult(id: number) {
  window.setTimeout(() =>
    document.querySelector<HTMLTextAreaElement>(`textarea[data-chunk="${id}"]`)?.focus(),
  );
}

function SideButtons({
  chunk,
  side,
  label,
  dispatch,
}: {
  chunk: Chunk;
  side: Side;
  label: string;
  dispatch: (a: MergeAction) => void;
}) {
  const state = side === "ours" ? chunk.oursState : chunk.theirsState;
  if (!state) return <div className="bl-merge__gutter" />;
  const summary = stripEol((side === "ours" ? chunk.ours : chunk.theirs)[0] ?? "").trim();
  const what = `${label}'s change${summary ? ` (${summary.slice(0, 40)})` : ""}`;
  return (
    <div className={`bl-merge__gutter bl-merge__gutter--${side}`}>
      {state === "pending" && !chunk.edited ? (
        <>
          <button
            type="button"
            className="bl-merge__take"
            aria-label={`Take ${what}`}
            data-tooltip={`Take ${label}'s change`}
            data-tooltip-align={side === "ours" ? "start" : "end"}
            onClick={() => {
              dispatch({ type: "apply", id: chunk.id, side });
              focusResult(chunk.id);
            }}
          >
            {side === "ours" ? (
              <ChevronsRight size={14} aria-hidden />
            ) : (
              <ChevronsLeft size={14} aria-hidden />
            )}
          </button>
          <button
            type="button"
            className="bl-merge__skip"
            aria-label={`Leave out ${what}`}
            data-tooltip="Leave this change out"
            data-tooltip-align={side === "ours" ? "start" : "end"}
            onClick={() => {
              dispatch({ type: "ignore", id: chunk.id, side });
              focusResult(chunk.id);
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </>
      ) : (
        <span
          className={`bl-merge__state bl-merge__state--${chunk.edited ? "edited" : state}`}
          title={chunk.edited ? "Edited by hand" : state === "applied" ? "Taken" : "Left out"}
        >
          {state === "applied" && !chunk.edited ? <Check size={12} aria-hidden /> : null}
        </span>
      )}
    </div>
  );
}

function ResultBox({
  chunk,
  start,
  label,
  dispatch,
}: {
  chunk: Chunk;
  start: number;
  label: string;
  dispatch: (a: MergeAction) => void;
}) {
  const text = textOf(chunk.result);
  const box = useRef<HTMLTextAreaElement>(null);
  // Grow with the content, including wrapped lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const rows = Math.max(1, chunk.result.length);
  const resolved = isResolved(chunk);
  const changed = chunk.edited || chunk.oursState !== "pending" || chunk.theirsState !== "pending";
  return (
    <div className="bl-merge__result">
      <span className="bl-merge__ln bl-merge__ln--result" aria-hidden>
        {chunk.result.length ? start : ""}
      </span>
      <textarea
        ref={box}
        className="bl-merge__textarea"
        aria-label={label}
        data-chunk={chunk.id}
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={resolved ? "(no lines)" : undefined}
        onChange={(e) => dispatch({ type: "edit", id: chunk.id, text: e.target.value })}
      />
      {changed && (
        <button
          type="button"
          className="bl-merge__reset"
          aria-label="Undo the choices for this change"
          data-tooltip="Start over for this change"
          data-tooltip-align="end"
          onClick={() => dispatch({ type: "reset", id: chunk.id })}
        >
          <RotateCcw size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * Three-pane merge editor, modelled on JetBrains' merge tool: ours on the left,
 * the result in the middle, theirs on the right. Take or leave out each side's
 * change with the arrows, or type in the result.
 */
export function MergeEditor({
  repoPath,
  path,
  run,
  onClose,
}: {
  repoPath: string;
  path: string;
  run: (
    label: string,
    op: (repoPath: string) => Promise<RepositoryInfo>,
  ) => Promise<GitError | null>;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<ConflictFile | null>(null);
  const [loadError, setLoadError] = useState<GitError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  /** Whole-result text editing; the per-change view is left behind. */
  const [plainText, setPlainText] = useState<string | null>(null);
  const [history, dispatchHistory] = useReducer(historyReducer, {
    initial: null,
    past: [],
    present: { blocks: [], eol: "\n" },
    future: [],
    typingIn: null,
  });
  const dispatch = useCallback((a: MergeAction) => dispatchHistory(a), []);
  const state = history.present;

  useEffect(() => {
    let cancelled = false;
    gitService
      .conflictFile(repoPath, path)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        if (f.segments) dispatchHistory({ type: "load", state: initialState(f.segments) });
      })
      .catch((e: GitError) => !cancelled && setLoadError(e));
    return () => {
      cancelled = true;
    };
  }, [repoPath, path]);

  // Focus the dialog; give focus back when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const counts = useMemo(() => remaining(state), [state]);
  const chunks = useMemo(
    () => state.blocks.flatMap((b) => (b.kind === "change" ? [b.chunk] : [])),
    [state],
  );
  const dirty = (history.initial !== null && state !== history.initial) || plainText !== null;
  const { name } = splitPath(path);

  const close = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Discard this merge?",
        description: `Your choices for ${name} are not saved. The file stays conflicted.`,
        confirmLabel: "Discard",
        destructive: true,
      }))
    )
      return;
    onClose();
  };

  const go = (dir: 1 | -1) => {
    const targets = chunks.filter((c) => !isResolved(c));
    const list = targets.length ? targets : chunks;
    if (list.length === 0 || !bodyRef.current) return;
    const boxes = list
      .map((c) =>
        bodyRef.current!.querySelector<HTMLTextAreaElement>(`textarea[data-chunk="${c.id}"]`),
      )
      .filter((el): el is HTMLTextAreaElement => !!el);
    const current = document.activeElement as HTMLElement | null;
    const index = boxes.findIndex((b) => b === current);
    const top = bodyRef.current.getBoundingClientRect().top;
    let next: HTMLTextAreaElement | undefined;
    if (index >= 0) next = boxes[(index + dir + boxes.length) % boxes.length];
    else
      next =
        dir === 1
          ? (boxes.find((b) => b.getBoundingClientRect().top > top + 40) ?? boxes[0])
          : ([...boxes].reverse().find((b) => b.getBoundingClientRect().top < top) ??
            boxes[boxes.length - 1]);
    next?.scrollIntoView?.({ block: "center" });
    next?.focus();
  };

  const save = async () => {
    if (!file) return;
    const text = plainText ?? resultText(state);
    if (plainText === null && (counts.conflicts > 0 || counts.changes > 0)) {
      const parts = [
        counts.conflicts &&
          `${counts.conflicts} ${counts.conflicts === 1 ? "conflict is" : "conflicts are"} not resolved: the result keeps the original text there`,
        counts.changes &&
          `${counts.changes} ${counts.changes === 1 ? "change was" : "changes were"} neither taken nor left out and ${counts.changes === 1 ? "is" : "are"} left out`,
      ].filter(Boolean);
      const ok = await confirm({
        title: "Save with open changes?",
        description: `${parts.join("; ")}.`,
        confirmLabel: "Save anyway",
      });
      if (!ok) return;
    }
    if (hasMarkers(text)) {
      const ok = await confirm({
        title: "The result contains conflict markers",
        description:
          "Lines like <<<<<<<, ======= or >>>>>>> will be saved into the file as they are.",
        confirmLabel: "Save anyway",
      });
      if (!ok) return;
    }
    setSaving(true);
    setSaveError(null);
    const error = await run("Resolving", (p) =>
      gitService.resolveConflictText(p, path, text, file.fingerprint),
    );
    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    toast({ tone: "success", title: `Resolved ${name}` });
    onClose();
  };

  const keepSide = async (side: ResolveSide) => {
    if (!file) return;
    const label =
      side === "delete"
        ? "Delete the file"
        : `Use ${side === "ours" ? file.ours.label : file.theirs.label}'s version`;
    if (
      dirty &&
      !(await confirm({
        title: `${label}?`,
        description: "Your choices in the editor are not saved.",
        confirmLabel: label,
      }))
    )
      return;
    setSaving(true);
    setSaveError(null);
    const error = await run("Resolving", (p) =>
      gitService.resolveConflictSide(p, path, side, file.fingerprint),
    );
    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    toast({ tone: "success", title: `Resolved ${name}` });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const inText = (e.target as HTMLElement).tagName === "TEXTAREA";
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void close();
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      go(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "F7") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (mod && e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (mod && !inText && e.key.toLowerCase() === "z") {
      e.preventDefault();
      dispatchHistory({ type: e.shiftKey ? "redo" : "undo" });
    } else if (e.key === "Tab") {
      const focusables = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "textarea:not(:disabled), button:not(:disabled)",
        ) ?? [],
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  const status = !file
    ? ""
    : !file.segments
      ? ""
      : plainText !== null
        ? "Editing the whole result as text"
        : counts.conflicts + counts.changes === 0
          ? "All changes handled"
          : [
              counts.conflicts &&
                `${counts.conflicts} ${counts.conflicts === 1 ? "conflict" : "conflicts"}`,
              counts.changes && `${counts.changes} ${counts.changes === 1 ? "change" : "changes"}`,
            ]
              .filter(Boolean)
              .join(", ") + " left";

  let body;
  if (loadError) {
    body = (
      <div className="bl-merge__message" role="alert">
        <CircleAlert size={18} aria-hidden /> {loadError.message}
      </div>
    );
  } else if (!file || (file.segments && !history.initial)) {
    body = (
      <div className="bl-merge__message" role="status">
        <Spinner size={16} /> Loading the versions…
      </div>
    );
  } else if (!file.segments) {
    body = (
      <div className="bl-merge__choice">
        <CircleAlert size={22} aria-hidden />
        <h3 className="text-h3">This file cannot be merged line by line</h3>
        <p className="text-secondary">{file.unmergeable}</p>
        <div className="bl-merge__choice-actions">
          {(["ours", "theirs"] as const).map((side) => {
            const s = file[side];
            return (
              <Button
                key={side}
                variant={side === "ours" ? "primary" : "secondary"}
                disabled={saving}
                onClick={() => void keepSide(s.exists ? side : "delete")}
              >
                {s.exists ? `Use ${s.label}'s version` : `Delete it, like ${s.label}`}
              </Button>
            );
          })}
        </div>
      </div>
    );
  } else if (plainText !== null) {
    body = (
      <textarea
        className="bl-merge__plain"
        aria-label={`Merged text of ${path}`}
        value={plainText}
        spellCheck={false}
        onChange={(e) => setPlainText(e.target.value)}
      />
    );
  } else {
    const n = { ours: 1, result: 1, theirs: 1 };
    body = (
      <div className="bl-merge__body" ref={bodyRef}>
        {state.blocks.map((b, i) => {
          if (b.kind === "same") {
            const folded = b.lines.length > FOLD_OVER && !unfolded.has(i);
            const head = folded ? b.lines.slice(0, FOLD_CONTEXT) : b.lines;
            const tail = folded ? b.lines.slice(-FOLD_CONTEXT) : [];
            const hidden = b.lines.length - head.length - tail.length;
            const starts = { ...n };
            n.ours += b.lines.length;
            n.result += b.lines.length;
            n.theirs += b.lines.length;
            const pane = (start: number) => (
              <>
                <Lines lines={head} start={start} />
                {folded && (
                  <button
                    type="button"
                    className="bl-merge__fold"
                    onClick={() => setUnfolded((s) => new Set(s).add(i))}
                  >
                    {hidden} unchanged lines
                  </button>
                )}
                {folded && <Lines lines={tail} start={start + b.lines.length - tail.length} />}
              </>
            );
            return (
              <div key={`s${i}`} className="bl-merge__row bl-merge__row--same">
                <div className="bl-merge__pane">{pane(starts.ours)}</div>
                <div className="bl-merge__gutter" />
                <div className="bl-merge__pane">{pane(starts.result)}</div>
                <div className="bl-merge__gutter" />
                <div className="bl-merge__pane">{pane(starts.theirs)}</div>
              </div>
            );
          }
          const c = b.chunk;
          const starts = { ...n };
          n.ours += c.ours.length;
          n.result += c.result.length;
          n.theirs += c.theirs.length;
          const resolved = isResolved(c);
          const tone = c.change === "conflict" ? "conflict" : "change";
          return (
            <div
              key={`c${c.id}`}
              className={`bl-merge__row bl-merge__row--${tone}${resolved ? " bl-merge__row--resolved" : ""}`}
            >
              <div className="bl-merge__pane">
                <Lines
                  lines={c.ours}
                  start={starts.ours}
                  tone={c.oursState ? tone : undefined}
                  label={`${file.ours.label}, line ${starts.ours}`}
                />
              </div>
              <SideButtons chunk={c} side="ours" label={file.ours.label} dispatch={dispatch} />
              <div className="bl-merge__pane">
                <ResultBox
                  chunk={c}
                  start={starts.result}
                  label={`Result for ${c.change === "conflict" ? "conflict" : "change"} at line ${starts.result}${resolved ? "" : ", not resolved"}`}
                  dispatch={dispatch}
                />
              </div>
              <SideButtons chunk={c} side="theirs" label={file.theirs.label} dispatch={dispatch} />
              <div className="bl-merge__pane">
                <Lines
                  lines={c.theirs}
                  start={starts.theirs}
                  tone={c.theirsState ? tone : undefined}
                  label={`${file.theirs.label}, line ${starts.theirs}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const canMerge = !!file?.segments && plainText === null;

  return (
    <div
      ref={ref}
      className="bl-merge"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="bl-merge__header">
        <div className="bl-merge__title">
          <h2 id={titleId} className="text-h3 truncate">
            Merge {name}
          </h2>
          <span className="text-small text-muted truncate">{path}</span>
        </div>
        <span className="bl-merge__status text-small" role="status">
          {status}
        </span>
        <div className="bl-merge__tools">
          {canMerge && (
            <>
              <IconButton
                label="Previous change (Alt+↑)"
                icon={<ArrowUp size={16} aria-hidden />}
                size="sm"
                onClick={() => go(-1)}
              />
              <IconButton
                label="Next change (Alt+↓)"
                icon={<ArrowDown size={16} aria-hidden />}
                size="sm"
                onClick={() => go(1)}
              />
              <IconButton
                label="Undo"
                icon={<Undo2 size={16} aria-hidden />}
                size="sm"
                disabled={history.past.length === 0}
                onClick={() => dispatchHistory({ type: "undo" })}
              />
              <IconButton
                label="Redo"
                icon={<Redo2 size={16} aria-hidden />}
                size="sm"
                disabled={history.future.length === 0}
                onClick={() => dispatchHistory({ type: "redo" })}
              />
              <IconButton
                label="Take all changes that do not conflict"
                icon={<Wand2 size={16} aria-hidden />}
                size="sm"
                disabled={counts.changes === 0}
                onClick={() => dispatch({ type: "applyNonConflicting" })}
              />
              <IconButton
                label="Edit the whole result as text"
                icon={<FileText size={16} aria-hidden />}
                size="sm"
                onClick={() => setPlainText(resultText(state).replace(/\r\n/g, "\n"))}
              />
            </>
          )}
        </div>
      </header>

      {file?.segments && (
        <div className="bl-merge__columns text-small">
          <div className="bl-merge__column" title={sideTitle(file.ours)}>
            <span className="bl-merge__side-label">{file.ours.label}</span>
            <span className="text-muted truncate">{sideTitle(file.ours)}</span>
            {canMerge && (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void keepSide("ours")}
              >
                Use all
              </Button>
            )}
          </div>
          <div />
          <div className="bl-merge__column bl-merge__column--result">
            <span className="bl-merge__side-label">Result</span>
            <span className="text-muted truncate">
              {file.baseExists
                ? "Starts from the common base"
                : "No common base: added on both sides"}
            </span>
          </div>
          <div />
          <div className="bl-merge__column" title={sideTitle(file.theirs)}>
            <span className="bl-merge__side-label">{file.theirs.label}</span>
            <span className="text-muted truncate">{sideTitle(file.theirs)}</span>
            {canMerge && (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void keepSide("theirs")}
              >
                Use all
              </Button>
            )}
          </div>
        </div>
      )}

      {body}

      <footer className="bl-merge__footer">
        {saveError && (
          <span className="bl-field-group__error bl-merge__error" role="alert">
            <CircleAlert size={14} aria-hidden /> {saveError}
          </span>
        )}
        {plainText !== null && (
          <Button variant="ghost" onClick={() => setPlainText(null)}>
            Back to the changes
          </Button>
        )}
        <span className="bl-merge__hint text-small text-muted">
          {canMerge ? `Alt+↑/↓ moves between changes · ${modKeyLabel}↵ saves` : ""}
        </span>
        <Button variant="secondary" onClick={() => void close()}>
          Cancel
        </Button>
        {file?.segments && (
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save and mark resolved
          </Button>
        )}
      </footer>
    </div>
  );
}
