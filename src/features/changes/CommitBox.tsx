import { CircleAlert, GitCommitHorizontal, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Splitter } from "../../components/Splitter";
import { useToast } from "../../components/Toast";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import { aiService } from "../../services/ai";
import { gitService } from "../../services/git";
import { modKeyLabel, isPrimaryModifier } from "../../services/platform";
import type { CommitDraft, GitError, RepositoryInfo } from "../../types/git";
import type { RepositoryController } from "../repository/useRepository";
import { useGitConsole } from "../console/GitConsoleProvider";
import { useSettings } from "../settings/SettingsProvider";
import "./CommitBox.css";

/** Summary length Git tools conventionally recommend. */
export const SUMMARY_SOFT_LIMIT = 72;

/** Description height: the default, the smallest, and the room always left for the file list. */
export const DESCRIPTION_DEFAULT = 64;
const DESCRIPTION_MIN = 40;
const FILE_LIST_RESERVE = 200;

interface Message {
  summary: string;
  description: string;
}

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

let nextSuggestion = 1;

export function CommitBox({
  repo,
  controller,
}: {
  repo: RepositoryInfo;
  controller: Pick<RepositoryController, "run" | "operation">;
}) {
  const toast = useToast();
  const { settings } = useSettings();
  const gitConsole = useGitConsole();
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
  // The running suggestion, so it can be stopped (also when the repository changes).
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const suggestion = useRef<string | null>(null);
  // The message from before the suggestion started, restored when it is stopped.
  const beforeSuggestion = useRef<Message | null>(null);

  // Dragging the line above the summary resizes the description. The largest size leaves
  // room for the file list and follows the window size.
  const [descriptionHeight, setDescriptionHeight] = usePersistentNumber(
    "commitDescriptionHeight",
    DESCRIPTION_DEFAULT,
  );
  const [maxDescription, setMaxDescription] = useState(480);
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const measure = useCallback(() => {
    const form = formRef.current;
    const area = descriptionRef.current;
    const column = form?.parentElement;
    if (!form || !area || !column || column.clientHeight === 0) return;
    const room = column.clientHeight - form.offsetHeight - FILE_LIST_RESERVE;
    setMaxDescription(Math.max(DESCRIPTION_MIN, area.offsetHeight + room));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const column = formRef.current?.parentElement;
    if (!column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [measure]);
  const shownHeight = Math.min(maxDescription, Math.max(DESCRIPTION_MIN, descriptionHeight));

  useEffect(
    () => () => {
      if (suggestion.current) void aiService.cancel(suggestion.current).catch(() => {});
      suggestion.current = null;
    },
    [repo.path],
  );

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

  const stopSuggesting = () => {
    const id = suggestion.current;
    suggestion.current = null;
    setSuggesting(null);
    if (beforeSuggestion.current) setMessage(beforeSuggestion.current);
    if (id) void aiService.cancel(id).catch(() => {});
  };

  const suggest = async () => {
    if (suggestion.current) return;
    const opId = `suggest-${nextSuggestion++}`;
    const before = message;
    beforeSuggestion.current = before;
    suggestion.current = opId;
    setSuggesting(opId);
    setError(null);
    const show = (text: string) => {
      if (suggestion.current === opId) setMessage(splitMessage(text));
    };
    try {
      const text = await aiService.suggestCommitMessage(repo.path, opId, show);
      if (suggestion.current !== opId) return;
      setMessage(splitMessage(text));
      prefilled.current = null;
      if (before.summary || before.description)
        toast({
          title: "Message suggested",
          description: "It replaced the message you had typed.",
          actions: [{ label: "Undo", onClick: () => setMessage(before) }],
          durationMs: 8000,
        });
      summaryRef.current?.focus();
    } catch (e) {
      if (suggestion.current !== opId) return;
      const err = e as GitError;
      setMessage(before);
      if (err.kind !== "cancelled") setError(err);
    } finally {
      if (suggestion.current === opId) {
        suggestion.current = null;
        setSuggesting(null);
      }
    }
  };

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
    if (e.key === "Escape" && suggesting) {
      e.preventDefault();
      e.stopPropagation();
      stopSuggesting();
      return;
    }
    if (e.key === "Enter" && isPrimaryModifier(e) && !suggesting) {
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
    <>
      <Splitter
        label="Resize commit message"
        value={shownHeight}
        min={DESCRIPTION_MIN}
        max={maxDescription}
        side="below"
        onChange={setDescriptionHeight}
        onReset={() => setDescriptionHeight(DESCRIPTION_DEFAULT)}
      />
      <form
        ref={formRef}
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
            readOnly={!!suggesting}
            aria-busy={!!suggesting}
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
          ref={descriptionRef}
          style={{ height: shownHeight }}
          value={message.description}
          readOnly={!!suggesting}
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
          {settings.ai.enabled &&
            (suggesting ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Square size={12} aria-hidden />}
                onClick={stopSuggesting}
                title="Stop (Esc)"
              >
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={<Sparkles size={14} aria-hidden />}
                disabled={staged === 0 || busy}
                title={
                  staged === 0
                    ? "Stage changes first"
                    : `Write a message for the staged changes with ${settings.ai.model || "your Ollama model"}`
                }
                onClick={() => void suggest()}
              >
                Suggest message
              </Button>
            ))}
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
              {error.kind !== "ai" && (
                <button
                  type="button"
                  className="bl-commit-box__output-link"
                  onClick={gitConsole.showLatestFailure}
                >
                  Show Git output
                </button>
              )}
            </div>
          </div>
        )}

        <Button
          type="submit"
          variant="primary"
          icon={<GitCommitHorizontal size={16} aria-hidden />}
          disabled={!!blocker || busy || !!suggesting}
          loading={
            busy && (controller.operation === "Committing" || controller.operation === "Amending")
          }
          shortcut={`${modKeyLabel}↵`}
          className="bl-commit-box__submit"
        >
          {label}
        </Button>
        <p className="bl-commit-box__hint text-small" aria-live="polite">
          {suggesting
            ? `Writing with ${settings.ai.model || "Ollama"}…`
            : (blocker ??
              (draft?.author
                ? `As ${draft.author.name} <${draft.author.email}>`
                : draft
                  ? "Git has no author name and email configured."
                  : ""))}
        </p>
      </form>
    </>
  );
}
