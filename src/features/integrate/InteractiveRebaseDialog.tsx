import { CircleAlert, GripVertical } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Spinner } from "../../components/Spinner";
import { relativeTime } from "../../lib/format";
import { gitService } from "../../services/git";
import type { GitError, PlanAction, PlanCommit, PlanStep } from "../../types/git";
import "./InteractiveRebaseDialog.css";
import { setDragGhost } from "./refDrag";

interface Row extends PlanCommit {
  action: PlanAction;
  /** Edited message for reword. */
  draft: string;
}

const ACTIONS: { value: PlanAction; label: string; hint: string }[] = [
  { value: "pick", label: "Pick", hint: "Keep the commit" },
  { value: "reword", label: "Reword", hint: "Keep it with a new message" },
  {
    value: "squash",
    label: "Squash",
    hint: "Combine into the commit below, keeping both messages",
  },
  { value: "fixup", label: "Fixup", hint: "Combine into the commit below, keeping its message" },
  { value: "drop", label: "Drop", hint: "Remove the commit" },
];

/** Rows are shown newest first (like History); the plan Git runs is oldest first. */
export function planFromRows(rows: Row[]): PlanStep[] {
  return [...rows].reverse().map((r) => ({
    oid: r.oid,
    action: r.action,
    message: r.action === "reword" ? r.draft : null,
  }));
}

/** Why the plan cannot run, or null. Mirrors the backend's checks. */
export function planProblem(rows: Row[]): string | null {
  const oldestFirst = [...rows].reverse().filter((r) => r.action !== "drop");
  if (oldestFirst.length === 0) return "Keep at least one commit.";
  if (oldestFirst[0]!.action === "squash" || oldestFirst[0]!.action === "fixup")
    return "The oldest commit you keep cannot be squashed or fixed up: there is nothing below it to combine with.";
  if (rows.some((r) => r.action === "reword" && !r.draft.trim()))
    return "A reworded commit needs a message.";
  return null;
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function InteractiveRebaseDialog({
  repoPath,
  base,
  baseLabel,
  branch,
  onSubmit,
  onCancel,
}: {
  repoPath: string;
  /** Commits after this one are rewritten. */
  base: string;
  baseLabel: string;
  branch: string;
  /** Plan is oldest first. Resolves to an error message to show, or null when started. */
  onSubmit: (plan: PlanStep[]) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [original, setOriginal] = useState<Row[] | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<GitError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    gitService
      .rebasePlanCommits(repoPath, base)
      .then((commits) => {
        if (cancelled) return;
        const initial = [...commits]
          .reverse()
          .map<Row>((c) => ({ ...c, action: "pick", draft: c.message }));
        setOriginal(initial);
        setRows(initial);
      })
      .catch((e: GitError) => !cancelled && setLoadError(e));
    return () => {
      cancelled = true;
    };
  }, [repoPath, base]);

  const problem = rows ? planProblem(rows) : null;
  const changed = useMemo(
    () =>
      !!rows &&
      !!original &&
      rows.some((r, i) => r.oid !== original[i]!.oid || r.action !== "pick"),
    [rows, original],
  );
  const counts = useMemo(() => {
    const c: Record<PlanAction, number> = { pick: 0, reword: 0, squash: 0, fixup: 0, drop: 0 };
    for (const r of rows ?? []) c[r.action]++;
    return c;
  }, [rows]);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((list) => list && list.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const moveRow = (from: number, to: number) => {
    if (!rows || to < 0 || to >= rows.length || from === to) return;
    setRows(move(rows, from, to));
    // Keep keyboard focus on the moved row's handle.
    window.setTimeout(() => {
      document.getElementById(`${listId}-handle-${to}`)?.focus();
    });
  };

  const submit = async () => {
    if (!rows || problem || !changed || busy) return;
    setBusy(true);
    setSubmitError(await onSubmit(planFromRows(rows)));
    setBusy(false);
  };

  const summary = rows
    ? (Object.entries(counts) as [PlanAction, number][])
        .filter(([, n]) => n > 0)
        .map(
          ([a, n]) =>
            `${n} ${a === "pick" ? "kept" : a === "drop" ? "dropped" : `${a === "reword" ? "reworded" : a === "squash" ? "squashed" : "fixed up"}`}`,
        )
        .join(" · ")
    : "";

  return (
    <Dialog
      size="wide"
      title={`Rebase ${branch} interactively`}
      description={
        <>
          Rewrites the commits after {baseLabel}. Drag commits (or use Alt+↑ and Alt+↓) to change
          their order; newest is on top. Squash and fixup combine a commit into the one below it.
        </>
      }
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <span className="bl-irebase__summary text-small text-secondary">{summary}</span>
          <Button
            variant="ghost"
            disabled={!changed || busy}
            onClick={() => original && setRows(original)}
          >
            Reset
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!rows || !!problem || !changed}
            loading={busy}
          >
            Start rebase
          </Button>
        </>
      }
    >
      {loadError ? (
        <p className="bl-field-group__error" role="alert">
          {loadError.message}
        </p>
      ) : !rows ? (
        <div className="bl-irebase__loading" role="status">
          <Spinner size={16} /> Loading commits…
        </div>
      ) : (
        <>
          <ol className="bl-irebase" aria-label="Rebase plan, newest first">
            {rows.map((r, i) => {
              const combining = r.action === "squash" || r.action === "fixup";
              return (
                <li
                  key={r.oid}
                  className={[
                    "bl-irebase__row",
                    `bl-irebase__row--${r.action}`,
                    dragIndex === i ? "bl-irebase__row--dragging" : "",
                    overIndex === i && dragIndex !== null && dragIndex !== i
                      ? dragIndex < i
                        ? "bl-irebase__row--drop-after"
                        : "bl-irebase__row--drop-before"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", r.oid);
                    setDragGhost(e, r.summary);
                  }}
                  onDragOver={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overIndex !== i) setOverIndex(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null) moveRow(dragIndex, i);
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                >
                  <button
                    type="button"
                    id={`${listId}-handle-${i}`}
                    className="bl-irebase__handle"
                    aria-label={`Move ${r.summary}. Alt+Up or Alt+Down to move.`}
                    onKeyDown={(e) => {
                      if (!e.altKey) return;
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        moveRow(i, i - 1);
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        moveRow(i, i + 1);
                      }
                    }}
                  >
                    <GripVertical size={16} aria-hidden />
                  </button>
                  <select
                    className="bl-irebase__action"
                    aria-label={`Action for ${r.summary}`}
                    value={r.action}
                    title={ACTIONS.find((a) => a.value === r.action)?.hint}
                    onChange={(e) => update(i, { action: e.target.value as PlanAction })}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <span className="bl-irebase__main">
                    {r.action === "reword" ? (
                      <textarea
                        className="bl-input bl-irebase__message mono"
                        aria-label={`New message for ${r.summary}`}
                        value={r.draft}
                        rows={Math.min(6, Math.max(2, r.draft.split("\n").length))}
                        onChange={(e) => update(i, { draft: e.target.value })}
                      />
                    ) : (
                      <span className="bl-irebase__summary-text truncate">{r.summary}</span>
                    )}
                    <span className="bl-irebase__meta text-small text-muted">
                      <span className="mono">{r.oid.slice(0, 7)}</span> · {r.authorName} ·{" "}
                      {relativeTime(r.authorTime * 1000)}
                      {combining && <span> · into the commit below</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="bl-irebase__base text-small text-muted">Below: {baseLabel} (unchanged)</p>
          {(problem || submitError) && (
            <p className="bl-field-group__error bl-irebase__problem" role="alert">
              <CircleAlert size={14} aria-hidden /> {submitError ?? problem}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
