import { Cherry, Copy, X } from "lucide-react";
import { Button } from "../../components/Button";
import { relativeTime } from "../../lib/format";
import { modKeyLabel } from "../../services/platform";
import type { LogCommit } from "../../types/git";
import { Avatar } from "./Avatar";

/** Why several commits cannot be cherry-picked right now, or null. */
export function cherryPickProblem({
  commits,
  mergeOids,
  busy,
  unborn,
}: {
  commits: LogCommit[];
  mergeOids: ReadonlySet<string>;
  busy: boolean;
  unborn: boolean;
}): string | null {
  if (busy) return "Finish the operation in progress first.";
  if (unborn) return "Create the first commit before cherry-picking.";
  if (commits.some((c) => mergeOids.has(c.oid)))
    return "The selection includes a merge commit. Cherry-pick merge commits one at a time.";
  return null;
}

/** Details panel for several selected commits: what is selected and what can be done with it. */
export function MultiSelectionPanel({
  commits,
  target,
  problem,
  onCherryPick,
  onSelectCommit,
  onClear,
}: {
  /** Selected commits, oldest first. */
  commits: LogCommit[];
  /** Name of the branch commits are picked onto. */
  target: string;
  problem: string | null;
  onCherryPick: () => void;
  onSelectCommit: (oid: string) => void;
  onClear: () => void;
}) {
  const n = commits.length;
  return (
    <section className="bl-commit-details bl-multi" aria-label={`${n} commits selected`}>
      <div className="bl-multi__head">
        <h2 className="bl-commit-details__summary">{n} commits selected</h2>
        <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className="bl-multi__actions">
        <Button
          variant="primary"
          icon={<Cherry size={16} aria-hidden />}
          disabled={!!problem}
          onClick={onCherryPick}
        >
          Cherry-pick {n} commits onto {target}
        </Button>
        <Button
          variant="secondary"
          icon={<Copy size={14} aria-hidden />}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(commits.map((c) => c.oid).join("\n"))
              .catch(() => {})
          }
        >
          Copy commit ids
        </Button>
        <p
          className="text-small text-secondary bl-multi__note"
          role={problem ? "alert" : undefined}
        >
          {problem ??
            `Applied oldest first, as listed below. Commits already on ${target} are skipped.`}
        </p>
      </div>
      <div>
        <div className="bl-section-label">In the order they are applied</div>
        <ol className="bl-multi__list">
          {commits.map((c) => (
            <li key={c.oid}>
              <button
                type="button"
                className="bl-multi__item"
                title="Show only this commit"
                onClick={() => onSelectCommit(c.oid)}
              >
                <Avatar name={c.authorName} email={c.authorEmail} />
                <span className="bl-multi__text">
                  <span className="truncate">{c.summary}</span>
                  <span className="text-small text-muted">
                    <span className="mono">{c.oid.slice(0, 7)}</span> · {c.authorName} ·{" "}
                    {relativeTime(c.authorTime * 1000)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <p className="text-small text-muted">
        {modKeyLabel}click adds or removes a commit, Shift+click selects a range, Esc keeps only the
        focused commit.
      </p>
    </section>
  );
}
