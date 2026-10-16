import { CircleAlert, GitCommitHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { useToast } from "../../components/Toast";
import { gitService } from "../../services/git";
import { modKeyLabel, isPrimaryModifier } from "../../services/platform";
import type { CommitDraft, GitError, RepositoryInfo } from "../../types/git";
import type { RepositoryController } from "../repository/useRepository";
import "./CommitBox.css";

/** Summary length Git tools conventionally recommend. */
export const SUMMARY_SOFT_LIMIT = 72;

interface Message {
  summary: string;
  description: string;
}

/** Unsent messages per repository survive switching views. */
/** Unsent messages per repository; `prefilled` is the prepared message Branchline filled in. */
const drafts = new Map<string, Message & { amend: boolean; prefilled: string | null }>();

/** Test helper: forget unsent messages. */
export function resetCommitDrafts() {
  drafts.clear();
}

export function splitMessage(message: string): Message {
  const [summary = "", ...rest] = message.replace(/\r\n/g, "\n").split("\n");
  return { summary, description: rest.join("\n").replace(/^\n+/, "") };
}

export function joinMessage({ summary, description }: Message): string {
  const body = description.trim();
  return body ? `${summary.trim()}\n\n${body}` : summary.trim();
}

/** Why committing is not possible right now, or null when it is. */
export function commitBlocker(
  repo: RepositoryInfo,
  message: Message,
  amend: boolean,
): string | null {
  const conflicts = repo.changes.filter((c) => c.conflict).length;
  const staged = repo.changes.filter((c) => c.indexStatus).length;
  if (conflicts > 0)
    return `Resolve ${conflicts === 1 ? "the conflict" : `${conflicts} conflicts`} first.`;
  // A plain commit in the middle of a rebase would add an unrelated commit.
  if (repo.operation === "rebase") return "Use Continue above to finish this rebase step.";
  if (!amend && staged === 0 && repo.operation !== "merge") return "Stage changes to commit.";
  if (!message.summary.trim()) return "Enter a summary.";
  return null;
}

export function CommitBox({
  repo,
  controller,
}: {
  repo: RepositoryInfo;
  controller: Pick<RepositoryController, "run" | "operation">;
}) {
  const toast = useToast();
  const summaryId = useId();
  const saved = drafts.get(repo.path);
  const [message, setMessage] = useState<Message>(saved ?? { summary: "", description: "" });
  const [amend, setAmend] = useState(saved?.amend ?? false);
  const [draft, setDraft] = useState<CommitDraft | null>(null);
  // The prepared (merge, cherry-pick, ...) message Branchline filled in, if still there.
  const prefilled = useRef<string | null>(saved?.prefilled ?? null);
  const [error, setError] = useState<GitError | null>(null);
  const summaryRef = useRef<HTMLInputElement>(null);
  const headOid = repo.head.kind === "unborn" ? null : repo.head.oid;

  useEffect(() => {
    drafts.set(repo.path, { ...message, amend, prefilled: prefilled.current });
  }, [repo.path, message, amend]);

  // Author, HEAD message and prepared merge message change with HEAD and operations.
  useEffect(() => {
    let cancelled = false;
    gitService
      .commitDraft(repo.path)
      .then((d) => {
        if (cancelled) return;
        setDraft(d);
        // Prefill a prepared merge/cherry-pick message if the box is empty. A prefill the
        // user did not touch follows the operation: replaced by the next prepared message,
        // or cleared when the operation ends (for example after Abort).
        setMessage((m) => {
          const untouched = prefilled.current !== null && joinMessage(m) === prefilled.current;
          const empty = !m.summary && !m.description;
          if (d.preparedMessage && (empty || untouched)) {
            const next = splitMessage(d.preparedMessage);
            prefilled.current = joinMessage(next);
            return next;
          }
          if (!d.preparedMessage && untouched) {
            prefilled.current = null;
            return { summary: "", description: "" };
          }
          return m;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repo.path, headOid, repo.operation]);

  const staged = repo.changes.filter((c) => c.indexStatus).length;
  const blocker = commitBlocker(repo, message, amend);
  const busy = controller.operation !== null;
  const long = message.summary.length > SUMMARY_SOFT_LIMIT;

  const toggleAmend = (on: boolean) => {
    setAmend(on);
    if (on && draft?.headMessage && !message.summary && !message.description) {
      setMessage(splitMessage(draft.headMessage));
    }
  };

  const submit = async () => {
    if (blocker || busy) return;
    setError(null);
    const text = joinMessage(message);
    const failure = await controller.run(amend ? "Amending" : "Committing", (path) =>
      gitService.createCommit(path, text, amend),
    );
    if (failure) {
      setError(failure);
      return;
    }
    setMessage({ summary: "", description: "" });
    setAmend(false);
    prefilled.current = null;
    drafts.delete(repo.path);
    toast({
      tone: "success",
      title: amend ? "Commit amended" : "Commit created",
      description: message.summary.trim(),
    });
    summaryRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && isPrimaryModifier(e)) {
      e.preventDefault();
      void submit();
    }
  };

  const label = amend
    ? "Amend last commit"
    : repo.operation === "merge"
      ? "Commit merge"
      : staged > 0
        ? `Commit ${staged} ${staged === 1 ? "file" : "files"}`
        : "Commit";

  return (
    <form
      className="bl-commit-box"
      aria-label="Commit"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="bl-commit-box__summary">
        <label htmlFor={summaryId} className="visually-hidden">
          Commit summary
        </label>
        <input
          id={summaryId}
          ref={summaryRef}
          className="bl-input"
          placeholder="Summary"
          value={message.summary}
          onChange={(e) => setMessage((m) => ({ ...m, summary: e.target.value }))}
          spellCheck
          autoComplete="off"
          aria-describedby={long ? `${summaryId}-count` : undefined}
        />
        {message.summary.length > 50 && (
          <span
            id={`${summaryId}-count`}
            className={`bl-commit-box__count${long ? " bl-commit-box__count--long" : ""}`}
            aria-live="polite"
          >
            {message.summary.length}
            {long ? ` (over ${SUMMARY_SOFT_LIMIT})` : ""}
          </span>
        )}
      </div>
      <textarea
        className="bl-input bl-commit-box__description"
        placeholder="Description (optional)"
        aria-label="Commit description"
        rows={3}
        value={message.description}
        onChange={(e) => setMessage((m) => ({ ...m, description: e.target.value }))}
        spellCheck
      />
      <div className="bl-commit-box__row">
        <label className="bl-checkbox">
          <input
            type="checkbox"
            checked={amend}
            disabled={!draft?.canAmend || busy}
            onChange={(e) => toggleAmend(e.target.checked)}
          />
          <span>Amend last commit</span>
        </label>
      </div>

      {error && (
        <div className="bl-commit-box__error" role="alert">
          <CircleAlert size={14} aria-hidden />
          <div>
            <div>{error.message}</div>
            {error.kind === "identityMissing" && (
              <code className="mono selectable">git config --global user.name "Your Name"</code>
            )}
            {error.detail && error.kind !== "identityMissing" && (
              <pre className="mono selectable">{error.detail}</pre>
            )}
          </div>
        </div>
      )}

      <Button
        type="submit"
        variant="primary"
        icon={<GitCommitHorizontal size={16} aria-hidden />}
        disabled={!!blocker || busy}
        loading={
          busy && (controller.operation === "Committing" || controller.operation === "Amending")
        }
        shortcut={`${modKeyLabel}↵`}
        className="bl-commit-box__submit"
      >
        {label}
      </Button>
      <p className="bl-commit-box__hint text-small" aria-live="polite">
        {blocker ??
          (draft?.author
            ? `As ${draft.author.name} <${draft.author.email}>`
            : draft
              ? "Git has no author name and email configured."
              : "")}
      </p>
    </form>
  );
}
