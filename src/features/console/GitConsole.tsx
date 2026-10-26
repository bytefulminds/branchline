import { ChevronRight, CircleCheck, CircleX, Copy, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { Splitter } from "../../components/Splitter";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import { formatCommand, gitLogService, type GitLogEntry } from "../../services/gitLog";
import { readJson, writeJson } from "../../services/storage";
import { SHORTCUTS } from "../commands/shortcuts";
import { useGitConsole } from "./GitConsoleProvider";
import "./GitConsole.css";

/** How often the open console asks for new commands. */
export const POLL_MS = 1000;
/** Most commands kept in the panel (the backend keeps the same number). */
const MAX_SHOWN = 500;
const HIDE_READS_KEY = "branchline.console.hideReads";

export interface ConsoleFilter {
  hideReads: boolean;
  failedOnly: boolean;
  text: string;
}

/** Entries to show: failures always stay visible, even routine reads. */
export function visibleEntries(entries: GitLogEntry[], f: ConsoleFilter): GitLogEntry[] {
  const q = f.text.trim().toLowerCase();
  return entries.filter((e) => {
    const failed = e.ok === false;
    if (f.failedOnly && !failed) return false;
    if (f.hideReads && e.readOnly && !failed) return false;
    if (!q) return true;
    return (
      formatCommand(e.args).toLowerCase().includes(q) ||
      e.stderr.toLowerCase().includes(q) ||
      e.cwd.toLowerCase().includes(q)
    );
  });
}

/** Merge newly reported entries into the list by id, oldest first, capped. */
export function mergeEntries(list: GitLogEntry[], updates: GitLogEntry[]): GitLogEntry[] {
  if (updates.length === 0) return list;
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const u of updates) byId.set(u.id, u);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-MAX_SHOWN);
}

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

const duration = (ms: number | null) =>
  ms === null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

const folderName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;

function Output({
  title,
  text,
  bytes,
  limitNote,
}: {
  title: string;
  text: string;
  bytes: number;
  limitNote: boolean;
}) {
  if (!text) return null;
  const clipped = bytes > new TextEncoder().encode(text).length;
  return (
    <section className="bl-console__output">
      <h3>
        {title}
        {clipped && limitNote && <span className="text-muted"> (first part of {size(bytes)})</span>}
      </h3>
      <pre className="mono selectable">{text}</pre>
    </section>
  );
}

function Entry({
  entry,
  expanded,
  onToggle,
}: {
  entry: GitLogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const command = formatCommand(entry.args);
  const status =
    entry.ok === null ? (
      <Spinner size={12} label="Running" />
    ) : entry.ok ? (
      <CircleCheck size={14} aria-label="Succeeded" className="bl-console__ok" />
    ) : (
      <CircleX size={14} aria-label="Failed" className="bl-console__failed" />
    );
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  return (
    <li
      className={`bl-console__entry${entry.ok === false ? " bl-console__entry--failed" : ""}`}
      data-entry-id={entry.id}
    >
      <button
        type="button"
        className="bl-console__row"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <ChevronRight size={14} aria-hidden className="bl-console__chevron" />
        {status}
        <time className="bl-console__time mono" dateTime={new Date(entry.startedAt).toISOString()}>
          {time(entry.startedAt)}
        </time>
        <span className="bl-console__command mono truncate">{command}</span>
        <span className="bl-console__repo text-muted truncate">{folderName(entry.cwd)}</span>
        <span className="bl-console__duration text-muted mono">{duration(entry.durationMs)}</span>
      </button>
      {expanded && (
        <div id={detailId} className="bl-console__detail">
          <dl className="bl-console__facts">
            <dt>Folder</dt>
            <dd className="mono selectable">{entry.cwd}</dd>
            <dt>Result</dt>
            <dd>
              {entry.ok === null
                ? "Running…"
                : entry.error
                  ? entry.error
                  : `Exit code ${entry.exitCode}${entry.ok ? "" : " (failed)"}`}
              {entry.durationMs !== null && ` · ${duration(entry.durationMs)}`}
            </dd>
            {entry.stdinBytes !== null && (
              <>
                <dt>Input</dt>
                <dd>{size(entry.stdinBytes)} sent to Git (not shown)</dd>
              </>
            )}
          </dl>
          <Output
            title="Messages (stderr)"
            text={entry.stderr}
            bytes={entry.stderrBytes}
            limitNote
          />
          <Output title="Output (stdout)" text={entry.stdout} bytes={entry.stdoutBytes} limitNote />
          {!entry.stderr && !entry.stdout && entry.ok !== null && (
            <p className="text-muted text-small">Git printed nothing.</p>
          )}
          <div className="bl-console__actions">
            <Button size="sm" icon={<Copy size={14} aria-hidden />} onClick={() => copy(command)}>
              Copy command
            </Button>
            {(entry.stderr || entry.stdout) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  copy([`$ ${command}`, entry.stderr, entry.stdout].filter(Boolean).join("\n"))
                }
              >
                Copy output
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Bottom panel listing every Git command Branchline runs, with its output. */
export function GitConsole() {
  const { setOpen, revealToken, consumeReveal } = useGitConsole();
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [hideReads, setHideReadsState] = useState(
    () => readJson<unknown>(HIDE_READS_KEY, true) !== false,
  );
  const [failedOnly, setFailedOnly] = useState(false);
  const [text, setText] = useState("");
  const [height, setHeight] = usePersistentNumber("branchline.layout.consoleHeight", 260);
  const [maxHeight] = useState(() => Math.max(240, Math.round(window.innerHeight * 0.7)));
  const lastSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const entriesRef = useRef<GitLogEntry[]>([]);

  const setHideReads = (v: boolean) => {
    setHideReadsState(v);
    writeJson(HIDE_READS_KEY, v);
  };

  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const poll = useCallback(async () => {
    try {
      const updates = await gitLogService.entries(lastSeq.current);
      for (const u of updates) lastSeq.current = Math.max(lastSeq.current, u.seq);
      const merged = mergeEntries(entriesRef.current, updates);
      entriesRef.current = merged;
      setEntries(merged);
      setError(null);
      // "Show Git output": expand the newest failure once it is in the list.
      const failure = [...merged].reverse().find((e) => e.ok === false);
      if (failure && consumeReveal()) {
        setFailedOnly(false);
        setText("");
        setExpanded((s) => new Set(s).add(failure.id));
        setScrollTo(failure.id);
      }
    } catch (e) {
      setError((e as { message?: string }).message ?? "Could not read the Git log.");
    }
  }, [consumeReveal]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  // Asked to show a failure while already open: look right away.
  useEffect(() => {
    if (revealToken) void poll();
  }, [revealToken, poll]);

  useEffect(() => {
    if (scrollTo === null) return;
    stickToBottom.current = false;
    listRef.current
      ?.querySelector(`[data-entry-id="${scrollTo}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [scrollTo]);

  const shown = useMemo(
    () => visibleEntries(entries, { hideReads, failedOnly, text }),
    [entries, hideReads, failedOnly, text],
  );

  // Follow new commands while scrolled to the bottom, like a terminal.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const clear = async () => {
    await gitLogService.clear().catch(() => {});
    entriesRef.current = [];
    setEntries([]);
    setExpanded(new Set());
  };

  const hidden = entries.length - shown.length;

  return (
    <section
      className="bl-console"
      aria-label="Git console"
      style={{ height: Math.min(height, maxHeight) }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target as HTMLElement).closest("input")) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <Splitter
        label="Resize Git console"
        value={height}
        min={120}
        max={maxHeight}
        side="below"
        onChange={setHeight}
        onReset={() => setHeight(260)}
      />
      <header className="bl-console__header">
        <h2 className="bl-console__title">Git console</h2>
        <span className="text-small text-muted">
          {shown.length} {shown.length === 1 ? "command" : "commands"}
          {hidden > 0 && ` · ${hidden} hidden`}
        </span>
        <label className="bl-checkbox">
          <input
            type="checkbox"
            checked={hideReads}
            onChange={(e) => setHideReads(e.target.checked)}
          />
          <span>Hide routine reads</span>
        </label>
        <label className="bl-checkbox">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.target.checked)}
          />
          <span>Failed only</span>
        </label>
        <label className="bl-search bl-console__search">
          <Search size={14} aria-hidden className="bl-search__icon" />
          <span className="visually-hidden">Search commands and messages</span>
          <input
            type="search"
            placeholder="Search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && text) {
                e.stopPropagation();
                setText("");
              }
            }}
            spellCheck={false}
          />
        </label>
        <IconButton
          size="sm"
          label="Clear the console"
          icon={<Trash2 size={14} aria-hidden />}
          onClick={() => void clear()}
          tooltipSide="top"
        />
        <IconButton
          size="sm"
          label={`Close (${SHORTCUTS.console})`}
          icon={<X size={14} aria-hidden />}
          onClick={() => setOpen(false)}
          tooltipSide="top"
          data-tooltip-align="end"
        />
      </header>
      <div
        ref={listRef}
        className="bl-console__list"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {error && (
          <p className="bl-console__empty bl-field-group__error" role="alert">
            {error}
          </p>
        )}
        {!error && shown.length === 0 && (
          <p className="bl-console__empty text-muted text-small">
            {entries.length === 0
              ? "Commands Branchline runs appear here, with Git's output. The log is kept in memory only."
              : "No commands match. Routine reads such as status and log are hidden."}
          </p>
        )}
        <ol aria-label="Git commands">
          {shown.map((e) => (
            <Entry
              key={e.id}
              entry={e}
              expanded={expanded.has(e.id)}
              onToggle={() =>
                setExpanded((s) => {
                  const next = new Set(s);
                  if (next.has(e.id)) next.delete(e.id);
                  else next.add(e.id);
                  return next;
                })
              }
            />
          ))}
        </ol>
      </div>
    </section>
  );
}
