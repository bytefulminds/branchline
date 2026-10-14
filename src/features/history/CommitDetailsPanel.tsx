import { Check, CircleAlert, Copy, GitCommitHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { StatusLetter } from "../../components/StatusLetter";
import { relativeTime, splitPath } from "../../lib/format";
import { gitService } from "../../services/git";
import type { CommitDetails, CommitFile, GitError, HeadState, RefInfo } from "../../types/git";
import type { StatusCode } from "../changes/changeModel";
import { Avatar } from "./Avatar";
import { RefBadges } from "./RefBadges";

const STATUS_CODE: Record<string, StatusCode> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typeChanged",
};

export function fileStatus(file: CommitFile): StatusCode {
  return STATUS_CODE[file.status] ?? "modified";
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="bl-copy"
      aria-label={label}
      data-tooltip={copied ? "Copied" : label}
      data-tooltip-align="end"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

/** Message, metadata and changed files of one commit. Keyed by commit in the parent. */
export function CommitDetailsPanel({
  repoPath,
  oid,
  refs,
  head,
  selectedFile,
  onOpenFile,
  onSelectCommit,
}: {
  repoPath: string;
  oid: string;
  refs: RefInfo[] | undefined;
  head: HeadState;
  selectedFile: string | null;
  onOpenFile: (file: CommitFile, details: CommitDetails) => void;
  onSelectCommit: (oid: string) => void;
}) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<GitError | null>(null);

  useEffect(() => {
    let cancelled = false;
    gitService
      .commitDetails(repoPath, oid)
      .then((d) => !cancelled && setDetails(d))
      .catch((e: GitError) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [repoPath, oid]);

  if (error)
    return (
      <EmptyState
        role="alert"
        tone="error"
        icon={<CircleAlert size={22} aria-hidden />}
        title="Could not load the commit"
        description={error.detail ?? error.message}
      />
    );
  if (!details)
    return (
      <div className="bl-commit-details__loading" role="status">
        <Spinner size={16} /> Loading commit…
      </div>
    );

  const [summary, ...rest] = details.message.split("\n");
  const body = rest.join("\n").trim();
  const committedSeparately =
    details.committerEmail !== details.authorEmail || details.committerName !== details.authorName;
  const totals = details.files.reduce(
    (t, f) => ({ add: t.add + (f.additions ?? 0), del: t.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );
  const headOid = head.kind === "unborn" ? null : head.oid;

  return (
    <section className="bl-commit-details" aria-label="Commit details">
      <div className="bl-commit-details__head">
        <div className="bl-commit-details__sha">
          <GitCommitHorizontal size={14} aria-hidden />
          <span className="mono selectable">{details.oid.slice(0, 12)}</span>
          <CopyButton text={details.oid} label="Copy commit id" />
        </div>
        <RefBadges refs={refs} head={head} isHeadCommit={details.oid === headOid} max={6} />
        <h2 className="text-h3 selectable bl-commit-details__summary">{summary}</h2>
        {body && <p className="bl-commit-details__body selectable">{body}</p>}
      </div>

      <dl className="bl-commit-details__meta">
        <div className="bl-person">
          <Avatar name={details.authorName} email={details.authorEmail} size={28} />
          <div>
            <dt className="visually-hidden">Author</dt>
            <dd>
              <span className="bl-person__name">{details.authorName}</span>
              <span className="text-small text-muted selectable"> {details.authorEmail}</span>
              <br />
              <time
                className="text-small text-secondary"
                dateTime={details.authorDate}
                title={new Date(details.authorDate).toLocaleString()}
              >
                Authored {relativeTime(details.authorDate)} ·{" "}
                {new Date(details.authorDate).toLocaleString()}
              </time>
            </dd>
          </div>
        </div>
        {committedSeparately && (
          <div className="text-small text-secondary">
            <dt className="visually-hidden">Committer</dt>
            <dd>
              Committed by {details.committerName} {relativeTime(details.committerDate)}
            </dd>
          </div>
        )}
        <div className="bl-commit-details__parents text-small">
          <dt className="text-muted">{details.parents.length > 1 ? "Parents" : "Parent"}</dt>
          <dd>
            {details.parents.length === 0 && <span className="text-muted">None (root commit)</span>}
            {details.parents.map((p) => (
              <button
                key={p}
                type="button"
                className="bl-link mono"
                onClick={() => onSelectCommit(p)}
              >
                {p.slice(0, 7)}
              </button>
            ))}
          </dd>
        </div>
      </dl>

      <div className="bl-commit-details__files-head">
        <h3 className="bl-section-label">
          {details.files.length} {details.files.length === 1 ? "file" : "files"} changed
        </h3>
        <span className="mono text-small">
          <span className="bl-diff__add">+{totals.add}</span>{" "}
          <span className="bl-diff__del">−{totals.del}</span>
        </span>
      </div>
      {details.parents.length > 1 && (
        <p className="text-small text-muted bl-commit-details__note">
          Changes compared with the first parent.
        </p>
      )}
      <ul className="bl-commit-files" aria-label="Changed files">
        {details.files.map((f) => {
          const { name, dir } = splitPath(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                className="bl-commit-file"
                aria-current={selectedFile === f.path || undefined}
                title={f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}
                onClick={() => onOpenFile(f, details)}
              >
                <StatusLetter status={fileStatus(f)} />
                <span className="bl-commit-file__name truncate">{name}</span>
                {dir && <span className="bl-commit-file__dir truncate">{dir}</span>}
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
    </section>
  );
}
