import {
  ArrowLeft,
  CircleCheck,
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  MessageSquare,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Splitter } from "../../components/Splitter";
import { Spinner } from "../../components/Spinner";
import { StatusLetter } from "../../components/StatusLetter";
import { plural, relativeTime, splitPath } from "../../lib/format";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import { forgeService } from "../../services/forge";
import { gitService } from "../../services/git";
import type { MergeRequest, RequestDetail, Thread } from "../../types/forge";
import type { CommitFile, FileDiff, GitError, RemoteProgress } from "../../types/git";
import { DiffBody } from "../changes/DiffView";
import { DiffLayoutToggle } from "../changes/DiffLayoutToggle";
import { diffRows } from "../changes/diffModel";
import { Avatar } from "../history/Avatar";
import { fileStatus } from "../history/CommitDetailsPanel";
import { displayTitle, forgeInfo } from "./forges";
import { useReviews } from "./ReviewsProvider";
import { QuestView } from "../quest/QuestView";
import { useSettings } from "../settings/SettingsProvider";
import "../history/HistoryView.css";
import "./MergeRequestView.css";

let nextOpId = 1;

function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : relativeTime(t);
}

/** Threads on a file, matched by its path now or before a rename. */
export function threadsFor(threads: Thread[], file: CommitFile): Thread[] {
  return threads.filter(
    (t) =>
      t.position &&
      (t.position.path === file.path ||
        (!!file.originalPath && t.position.oldPath === file.originalPath)),
  );
}

function ThreadCard({ thread }: { thread: Thread }) {
  const p = thread.position;
  const line = p ? (p.newLine ?? p.oldLine) : null;
  return (
    <article
      className={`bl-thread${thread.resolved ? " bl-thread--resolved" : ""}`}
      aria-label={
        line
          ? `Comment thread on line ${line}`
          : `Comment thread by ${thread.notes[0]?.author.name}`
      }
    >
      {p && (
        <header className="bl-thread__where text-small text-muted">
          <span className="mono">
            {p.newLine ? `Line ${p.newLine}` : p.oldLine ? `Removed line ${p.oldLine}` : "File"}
          </span>
          {p.outdated && <span className="bl-tag-kind">Outdated</span>}
          {thread.resolved && (
            <span className="bl-thread__resolved">
              <CircleCheck size={12} aria-hidden /> Resolved
            </span>
          )}
        </header>
      )}
      {!p && thread.resolved && (
        <header className="bl-thread__where text-small">
          <span className="bl-thread__resolved">
            <CircleCheck size={12} aria-hidden /> Resolved
          </span>
        </header>
      )}
      {thread.notes.map((n, i) => (
        <div key={i} className="bl-note">
          <div className="bl-note__head text-small">
            <Avatar name={n.author.name} email={n.author.username} size={18} />
            <strong>{n.author.name}</strong>
            <span className="text-muted">{when(n.createdAt)}</span>
          </div>
          <p className="bl-note__body selectable">{n.body}</p>
        </div>
      ))}
    </article>
  );
}

/** Read-only diff of one file of the merge request, with its comment threads above it. */
function FileDiffPane({
  repoPath,
  detail,
  file,
}: {
  repoPath: string;
  detail: RequestDetail;
  file: CommitFile;
}) {
  const [diff, setDiff] = useState<{ key: string; diff: FileDiff } | null>(null);
  const [error, setError] = useState<{ key: string; error: GitError } | null>(null);
  const [force, setForce] = useState(false);
  const key = `${file.path}\n${force}`;

  useEffect(() => {
    let cancelled = false;
    forgeService
      .rangeFileDiff(repoPath, detail.base, detail.head, file.path, file.originalPath, force)
      .then((d) => !cancelled && setDiff({ key, diff: d }))
      .catch((e: GitError) => !cancelled && setError({ key, error: e }));
    return () => {
      cancelled = true;
    };
  }, [repoPath, detail.base, detail.head, file.path, file.originalPath, force, key]);

  const shown = diff && diff.key.startsWith(`${file.path}\n`) ? diff.diff : null;
  const rows = useMemo(() => (shown ? diffRows(shown) : []), [shown]);
  const threads = threadsFor(detail.threads, file).sort(
    (a, b) =>
      (a.position?.newLine ?? a.position?.oldLine ?? 0) -
      (b.position?.newLine ?? b.position?.oldLine ?? 0),
  );
  const { name, dir } = splitPath(file.path);

  return (
    <section className="bl-diff" aria-label={`Changes in ${file.path}`}>
      <header className="bl-diff__header">
        <div className="bl-diff__title">
          <StatusLetter status={fileStatus(file)} />
          <div className="bl-diff__name">
            <h2 className="text-h3 truncate selectable" title={file.path}>
              {name}
            </h2>
            <span className="text-small text-muted truncate selectable">
              {file.originalPath ? `${file.originalPath} → ${file.path}` : dir || "repository root"}
            </span>
          </div>
          {shown && (
            <span className="bl-diff__stats mono">
              <span className="bl-diff__add">+{shown.additions}</span>
              <span className="bl-diff__del">−{shown.deletions}</span>
            </span>
          )}
        </div>
        <div className="bl-diff__actions">
          <DiffLayoutToggle />
        </div>
      </header>
      {threads.length > 0 && (
        <div className="bl-mr__file-threads" aria-label={`Comments on ${name}`} role="region">
          {threads.map((t) => (
            <ThreadCard key={t.id} thread={t} />
          ))}
        </div>
      )}
      <DiffBody
        diff={shown}
        path={file.path}
        rows={rows}
        error={error?.key === key ? error.error : null}
        loading={diff?.key !== key && error?.key !== key}
        binaryNote="Binary file; its content is not shown."
        onShowLarge={() => setForce(true)}
      />
    </section>
  );
}

/** Description, general discussion and commits. */
function Overview({ detail }: { detail: RequestDetail }) {
  const general = detail.threads.filter((t) => !t.position);
  return (
    <section className="bl-mr__overview" aria-label="Overview">
      <h2 className="bl-section-label">Description</h2>
      {detail.description.trim() ? (
        <p className="bl-mr__description selectable">{detail.description}</p>
      ) : (
        <p className="text-small text-muted">No description.</p>
      )}
      <h2 className="bl-section-label">
        Discussion {general.length > 0 && <span className="text-muted">({general.length})</span>}
      </h2>
      {general.length ? (
        general.map((t) => <ThreadCard key={t.id} thread={t} />)
      ) : (
        <p className="text-small text-muted">No general comments.</p>
      )}
      <h2 className="bl-section-label">{plural(detail.commits.length, "commit")}</h2>
      <ul className="bl-mr__commits" aria-label="Commits">
        {detail.commits.map((c) => (
          <li key={c.oid} className="bl-mr__commit text-small">
            <GitCommitHorizontal size={14} aria-hidden className="text-muted" />
            <span className="truncate">{c.title}</span>
            <span className="text-muted truncate">{c.authorName}</span>
            <span className="mono text-muted">{c.oid.slice(0, 7)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A merge request read in Branchline: its commits are fetched into the repository and the
 * diff is computed locally; details and comments come from the service. */
export function MergeRequestView({
  repoPath,
  request,
  onBack,
}: {
  repoPath: string;
  request: MergeRequest;
  onBack: () => void;
}) {
  const [state, setState] = useState<
    | { s: "loading"; progress: RemoteProgress | null; opId: string }
    | { s: "error"; error: GitError }
    | { s: "ready"; detail: RequestDetail }
  >(() => ({ s: "loading", progress: null, opId: `mr-${nextOpId++}` }));
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = usePersistentNumber("mergeRequestPanelWidth", 340);
  const { settings } = useSettings();
  const [questing, setQuesting] = useState(false);
  const f = forgeInfo(useReviews().source?.account?.kind);
  const Noun = `${f.noun[0]!.toUpperCase()}${f.noun.slice(1)}`;
  const opId = state.s === "loading" ? state.opId : null;
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!opId || started.current === opId) return;
    started.current = opId;
    forgeService
      .openMergeRequest(repoPath, request.projectId, request.iid, opId, (progress) =>
        setState((s) => (s.s === "loading" ? { ...s, progress } : s)),
      )
      .then((detail) => setState({ s: "ready", detail }))
      .catch((error: GitError) => setState({ s: "error", error }));
  }, [opId, repoPath, request.projectId, request.iid]);

  const detail = state.s === "ready" ? state.detail : null;
  const file = detail?.files.find((f) => f.path === selected) ?? null;
  const r = detail?.request ?? request;
  const totals = (detail?.files ?? []).reduce(
    (t, f) => ({ add: t.add + (f.additions ?? 0), del: t.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );

  // The quest only exists while AI is on.
  if (questing && detail && settings.ai.enabled) {
    const discussion: Record<string, string> = {};
    for (const f of detail.files)
      discussion[f.path] = threadsFor(detail.threads, f)
        .flatMap((t) => t.notes.map((n) => `${n.author.name}: ${n.body}`))
        .join("\n");
    return (
      <QuestView
        spec={{
          repoPath,
          base: detail.base,
          head: detail.head,
          title: displayTitle(detail.request),
          description: detail.description,
          ownBranch: false,
          storageKey: `${detail.request.projectPath}${f.ref}${detail.request.iid}`,
          discussion,
          backLabel: Noun,
        }}
        onExit={() => setQuesting(false)}
      />
    );
  }

  return (
    <section
      className="bl-mr"
      aria-label={`${Noun} ${f.ref}${r.iid}`}
      onKeyDown={(e) => e.key === "Escape" && e.target === e.currentTarget && onBack()}
    >
      <aside className="bl-mr__side" style={{ width }}>
        <div className="bl-mr__head">
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowLeft size={14} aria-hidden />}
            onClick={onBack}
            autoFocus
          >
            Reviews
          </Button>
          <h1 className="text-h2 bl-mr__title selectable">{displayTitle(r)}</h1>
          <p className="text-small text-secondary bl-mr__meta">
            <span className="mono">
              {f.ref}
              {r.iid}
            </span>
            {r.draft && <span className="bl-tag-kind">Draft</span>}
            <span>
              <Avatar name={r.author.name} email={r.author.username} size={16} /> {r.author.name}
            </span>
          </p>
          <p
            className="text-small mono text-muted truncate"
            title={`${r.sourceBranch} into ${r.targetBranch}`}
          >
            {r.sourceBranch} → {r.targetBranch}
          </p>
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink size={13} aria-hidden />}
            onClick={() => void forgeService.openPage(r.webUrl).catch(() => {})}
          >
            Open on {f.name}
          </Button>
          {settings.ai.enabled && detail && (
            <Button
              size="sm"
              variant="secondary"
              className="bl-mr__quest"
              icon={<Sparkles size={14} aria-hidden />}
              onClick={() => setQuesting(true)}
            >
              Start review quest
            </Button>
          )}
        </div>

        {detail && (
          <nav className="bl-mr__nav" aria-label={`${Noun} contents`}>
            <button
              type="button"
              className="bl-commit-file"
              aria-current={selected === null || undefined}
              onClick={() => setSelected(null)}
            >
              <FileText size={14} aria-hidden />
              <span className="bl-commit-file__name truncate">Overview</span>
              {detail.threads.some((t) => !t.position) && (
                <span className="bl-mr__count text-small text-muted">
                  <MessageSquare size={12} aria-hidden />
                  {detail.threads.filter((t) => !t.position).length}
                </span>
              )}
            </button>
            <div className="bl-commit-details__files-head">
              <h2 className="bl-section-label">{plural(detail.files.length, "file")} changed</h2>
              <span className="mono text-small">
                <span className="bl-diff__add">+{totals.add}</span>{" "}
                <span className="bl-diff__del">−{totals.del}</span>
              </span>
            </div>
            <ul className="bl-commit-files" aria-label="Changed files">
              {detail.files.map((f) => {
                const { name, dir } = splitPath(f.path);
                const comments = threadsFor(detail.threads, f).length;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="bl-commit-file"
                      aria-current={selected === f.path || undefined}
                      title={f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}
                      onClick={() => setSelected(f.path)}
                    >
                      <StatusLetter status={fileStatus(f)} />
                      <span className="bl-commit-file__name truncate">{name}</span>
                      {dir && <span className="bl-commit-file__dir truncate">{dir}</span>}
                      {comments > 0 && (
                        <span
                          className="bl-mr__count text-small text-muted"
                          title={plural(comments, "comment thread")}
                        >
                          <MessageSquare size={12} aria-hidden />
                          <span className="visually-hidden">Comment threads: </span>
                          {comments}
                        </span>
                      )}
                      <span className="bl-commit-file__stats mono">
                        {f.binary ? (
                          <span className="text-muted">bin</span>
                        ) : (
                          <>
                            <span className="bl-diff__add">+{f.additions ?? 0}</span>
                            <span className="bl-diff__del">−{f.deletions ?? 0}</span>
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </aside>
      <Splitter
        label={`Resize ${f.noun} panel`}
        value={width}
        min={260}
        max={560}
        side="left"
        onChange={setWidth}
      />
      <div className="bl-mr__main">
        {state.s === "loading" && (
          <div className="bl-mr__loading" role="status">
            <Spinner size={18} />
            <span>
              {state.progress
                ? `${state.progress.phase}${state.progress.percent !== null ? ` ${state.progress.percent}%` : ""}`
                : `Opening the ${f.noun}…`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void gitService.cancelRemote(state.opId)}
            >
              Stop
            </Button>
          </div>
        )}
        {state.s === "error" && (
          <div className="bl-mr__error">
            <div className="bl-banner bl-banner--error" role="alert">
              <TriangleAlert size={16} aria-hidden />
              <span>{state.error.message}</span>
            </div>
            <div className="bl-mr__error-actions">
              <Button
                size="sm"
                onClick={() => setState({ s: "loading", progress: null, opId: `mr-${nextOpId++}` })}
              >
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onBack}>
                Back to Reviews
              </Button>
            </div>
          </div>
        )}
        {detail && !file && <Overview detail={detail} />}
        {detail && file && (
          <FileDiffPane key={file.path} repoPath={repoPath} detail={detail} file={file} />
        )}
      </div>
    </section>
  );
}
