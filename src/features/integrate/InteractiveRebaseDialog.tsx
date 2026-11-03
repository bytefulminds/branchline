import { CircleAlert, GripVertical, Pencil, Sparkles, Square, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Spinner } from "../../components/Spinner";
import { relativeTime } from "../../lib/format";
import { gitService } from "../../services/git";
import type {
  GitError,
  PlanAction,
  PlanCommit,
  PlanStep,
  RebaseSuggestion,
  RewriteBase,
} from "../../types/git";
import { useSettings } from "../settings/SettingsProvider";
import "./InteractiveRebaseDialog.css";
import { setDragGhost } from "./refDrag";

export interface Row extends PlanCommit {
  action: PlanAction;
  /** Edited message for reword (of the combined commit, when others are combined into it). */
  draft: string;
  /** Why the AI suggested this, shown on the commit others are combined into. */
  aiReason?: string;
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

const combining = (a: PlanAction) => a === "squash" || a === "fixup";

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
  if (combining(oldestFirst[0]!.action))
    return "The oldest commit you keep cannot be squashed or fixed up: there is nothing below it to combine with.";
  if (rows.some((r) => r.action === "reword" && !r.draft.trim()))
    return "A reworded commit needs a message.";
  return null;
}

/**
 * For each row (newest first), the index of the row it is combined into: the nearest kept
 * commit below it, past dropped commits and other squashed ones. Null for other rows.
 */
export function combineTargets(rows: Row[]): (number | null)[] {
  return rows.map((r, i) => {
    if (!combining(r.action)) return null;
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[j]!.action;
      if (a === "pick" || a === "reword") return j;
    }
    return null;
  });
}

/** The message Git gives a combined commit: its own, then each squashed one, oldest first. */
export function combinedMessage(rows: Row[], target: number, targets: (number | null)[]): string {
  const parts = [rows[target]!.message];
  for (let i = target - 1; i >= 0; i--)
    if (targets[i] === target && rows[i]!.action === "squash") parts.push(rows[i]!.message);
  return parts.join("\n\n");
}

/**
 * Apply an AI suggestion to the commits in their original order (newest first): the oldest
 * commit of each group keeps its place and gets the suggested message, the others are fixed
 * up into it.
 */
export function applySuggestion(original: Row[], suggestion: RebaseSuggestion): Row[] {
  const rows = original.map<Row>((r) => ({ ...r, action: "pick", draft: r.message }));
  const index = new Map(rows.map((r, i) => [r.oid, i]));
  for (const g of suggestion.groups) {
    const [first, ...rest] = g.commits;
    const at = first === undefined ? undefined : index.get(first);
    if (at === undefined) continue;
    const row = rows[at]!;
    const changed = rest.length > 0 || g.message.trim() !== row.message.trim();
    rows[at] = {
      ...row,
      action: changed ? "reword" : "pick",
      draft: changed ? g.message : row.message,
      aiReason: g.reason ?? undefined,
    };
    for (const oid of rest) {
      const i = index.get(oid);
      if (i !== undefined) rows[i] = { ...rows[i]!, action: "fixup" };
    }
  }
  return rows;
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

let nextSuggestion = 1;

export function InteractiveRebaseDialog({
  repoPath,
  base,
  baseLabel,
  branch,
  rewrite,
  onSubmit,
  onCancel,
}: {
  repoPath: string;
  /** Commits after this one are rewritten. */
  base: string;
  baseLabel: string;
  branch: string;
  /** Set when opened with "Rewrite history": what Branchline found about the branch. */
  rewrite?: RewriteBase;
  /** Plan is oldest first. Resolves to an error message to show, or null when started. */
  onSubmit: (plan: PlanStep[]) => Promise<string | null>;
  onCancel: () => void;
}) {
  const { settings } = useSettings();
  const [original, setOriginal] = useState<Row[] | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<GitError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const suggestion = useRef<string | null>(null);
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

  // A suggestion still running when the dialog closes is stopped.
  useEffect(
    () => () => {
      if (suggestion.current) void gitService.cancelRemote(suggestion.current).catch(() => {});
    },
    [],
  );

  const problem = rows ? planProblem(rows) : null;
  const targets = useMemo(() => (rows ? combineTargets(rows) : []), [rows]);
  const members = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of targets) if (t !== null) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [targets]);
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
    if (!rows || problem || !changed || busy || suggesting) return;
    setBusy(true);
    setSubmitError(await onSubmit(planFromRows(rows)));
    setBusy(false);
  };

  const suggest = async () => {
    if (!original || suggestion.current) return;
    const opId = `rebase-suggest-${nextSuggestion++}`;
    suggestion.current = opId;
    setSuggesting(opId);
    setAiNote(null);
    try {
      const result = await gitService.suggestRebase(repoPath, base, opId);
      if (suggestion.current !== opId) return;
      setRows(applySuggestion(original, result));
      const combined = result.groups.filter((g) => g.commits.length > 1);
      const into = combined.reduce((n, g) => n + g.commits.length, 0);
      setAiNote({
        tone: "ok",
        text: combined.length
          ? `Suggested: ${into} commits combined into ${combined.length}${
              combined.length === 1 ? "" : " commits"
            }, with new messages. Check the plan and change anything before you start.`
          : "Suggested: no commits to combine. Better messages are filled in where the AI had one.",
      });
    } catch (e) {
      const err = e as GitError;
      if (suggestion.current === opId && err.kind !== "cancelled")
        setAiNote({ tone: "error", text: err.message });
    } finally {
      if (suggestion.current === opId) {
        suggestion.current = null;
        setSuggesting(null);
      }
    }
  };

  const stopSuggesting = () => {
    const id = suggestion.current;
    suggestion.current = null;
    setSuggesting(null);
    if (id) void gitService.cancelRemote(id).catch(() => {});
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

  const aiOn = settings.ai.enabled;

  return (
    <Dialog
      size="wide"
      title={rewrite ? `Rewrite history of ${branch}` : `Rebase ${branch} interactively`}
      description={
        <>
          {rewrite
            ? `Squash, reword, reorder or drop the ${rewrite.commits === 1 ? "commit" : `${rewrite.commits} commits`} after ${baseLabel}.`
            : `Rewrites the commits after ${baseLabel}.`}{" "}
          Drag commits (or use Alt+↑ and Alt+↓) to change their order; newest is on top. Squash and
          fixup combine a commit into the one below it, shown indented above it.
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
            onClick={() => {
              if (original) setRows(original);
              setAiNote(null);
            }}
          >
            Reset
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!rows || !!problem || !changed || !!suggesting}
            loading={busy}
          >
            Start rebase
          </Button>
        </>
      }
    >
      {rewrite && (rewrite.published > 0 || rewrite.afterMerge || rewrite.limited) && (
        <div className="bl-irebase__notes text-small">
          {rewrite.published > 0 && (
            <p className="bl-irebase__warning">
              <TriangleAlert size={14} aria-hidden />
              {rewrite.published === rewrite.commits
                ? "These commits are already pushed."
                : `${rewrite.published} of these commits are already pushed.`}{" "}
              After rewriting, push with force, and anyone else who uses {branch} has to reset to
              the new history.
            </p>
          )}
          {rewrite.afterMerge && (
            <p className="text-secondary">
              The history stops at the newest merge commit; commits before it cannot be rewritten
              here.
            </p>
          )}
          {rewrite.limited && (
            <p className="text-secondary">Only the newest 300 commits are shown.</p>
          )}
        </div>
      )}
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
          {aiOn && rows.length > 1 && (
            <div className="bl-irebase__ai">
              {suggesting ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Square size={12} aria-hidden />}
                  onClick={stopSuggesting}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Sparkles size={14} aria-hidden />}
                  disabled={busy}
                  onClick={() => void suggest()}
                >
                  Suggest with AI
                </Button>
              )}
              <span
                className={`text-small ${aiNote?.tone === "error" ? "bl-field-group__error" : "text-secondary"}`}
                role="status"
                aria-live="polite"
              >
                {suggesting
                  ? "Looking at the commits…"
                  : (aiNote?.text ??
                    "Let the AI suggest which commits belong together, with a message for each.")}
              </span>
            </div>
          )}
          <ol className="bl-irebase" aria-label="Rebase plan, newest first">
            {rows.map((r, i) => {
              const target = targets[i] ?? null;
              const into = target !== null ? rows[target]! : null;
              const groupSize = members.get(i) ?? 0;
              // The top row of a group starts the rail that leads down to the commit.
              const groupTop = target !== null && (i === 0 || targets[i - 1] !== target);
              return (
                <li
                  key={r.oid}
                  className={[
                    "bl-irebase__row",
                    `bl-irebase__row--${r.action}`,
                    into ? "bl-irebase__row--combined" : "",
                    groupTop ? "bl-irebase__row--group-top" : "",
                    groupSize > 0 ? "bl-irebase__row--target" : "",
                    combining(r.action) && !into ? "bl-irebase__row--orphan" : "",
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
                        aria-label={
                          groupSize > 0
                            ? `Message for the combined commit of ${r.summary}`
                            : `New message for ${r.summary}`
                        }
                        value={r.draft}
                        rows={Math.min(8, Math.max(2, r.draft.split("\n").length))}
                        onChange={(e) => update(i, { draft: e.target.value })}
                      />
                    ) : (
                      <span className="bl-irebase__summary-text truncate">{r.summary}</span>
                    )}
                    <span className="bl-irebase__meta text-small text-muted">
                      <span className="mono">{r.oid.slice(0, 7)}</span> · {r.authorName} ·{" "}
                      {relativeTime(r.authorTime * 1000)}
                      {into && (
                        <span>
                          {" "}
                          · into <span className="mono">{into.oid.slice(0, 7)}</span>
                        </span>
                      )}
                      {groupSize > 0 && (
                        <span className="bl-irebase__badge">+{groupSize} combined</span>
                      )}
                    </span>
                    {groupSize > 0 && r.action === "pick" && (
                      <span className="bl-irebase__result text-small text-secondary">
                        {counts.squash > 0 &&
                        rows.some((x, k) => targets[k] === i && x.action === "squash")
                          ? "The combined commit keeps the messages of the squashed commits."
                          : "The combined commit keeps this message."}{" "}
                        <button
                          type="button"
                          className="bl-link-button"
                          onClick={() =>
                            update(i, {
                              action: "reword",
                              draft: combinedMessage(rows, i, targets),
                            })
                          }
                        >
                          <Pencil size={12} aria-hidden /> Edit message
                        </button>
                      </span>
                    )}
                    {r.aiReason && (
                      <span className="bl-irebase__reason text-small text-secondary">
                        <Sparkles size={12} aria-hidden /> {r.aiReason}
                      </span>
                    )}
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
