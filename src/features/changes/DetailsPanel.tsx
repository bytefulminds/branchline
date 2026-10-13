import { GitBranch, GitCommitHorizontal, GitMerge, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { StatusLetter } from "../../components/StatusLetter";
import { displayPath, relativeTime, splitPath } from "../../lib/format";
import type { RepositoryInfo } from "../../types/git";
import { headLabel, OPERATION_LABEL } from "../repository/headLabel";
import { AREA_LABEL, CONFLICT_LABEL, STATUS_META, type ChangeEntry } from "./changeModel";
import "./DetailsPanel.css";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bl-field">
      <dt className="bl-field__label">{label}</dt>
      <dd className="bl-field__value">{children}</dd>
    </div>
  );
}

function FileDetails({ entry }: { entry: ChangeEntry }) {
  const { name, dir } = splitPath(entry.path);
  return (
    <>
      <div className="bl-details__title">
        <StatusLetter status={entry.status} />
        <h2 className="text-h3 truncate selectable" title={entry.path}>
          {name}
        </h2>
      </div>
      <dl className="bl-details__fields">
        <Field label="Status">
          {STATUS_META[entry.status].label}
          {entry.conflict && (
            <span className="text-secondary"> · {CONFLICT_LABEL[entry.conflict]}</span>
          )}
        </Field>
        <Field label="Area">{AREA_LABEL[entry.area]}</Field>
        <Field label="Path">
          <span className="mono selectable bl-details__path">{entry.path}</span>
        </Field>
        {dir && <Field label="Folder">{dir}</Field>}
        {entry.originalPath && (
          <Field label="Renamed from">
            <span className="mono selectable bl-details__path">{entry.originalPath}</span>
          </Field>
        )}
        {entry.isSubmodule && <Field label="Type">Submodule</Field>}
      </dl>
      <p className="bl-details__note text-small text-muted">
        Diff viewing, staging and discarding are not available yet.
      </p>
    </>
  );
}

function RepositoryOverview({ repo }: { repo: RepositoryInfo }) {
  const head = headLabel(repo.head);
  const commit = repo.headCommit;
  return (
    <>
      <div className="bl-details__title">
        <h2 className="text-h3 truncate">{repo.name}</h2>
      </div>
      <dl className="bl-details__fields">
        <Field label="Location">
          <span className="mono selectable bl-details__path">{displayPath(repo.path)}</span>
        </Field>
        <Field label="HEAD">
          <Badge
            tone={repo.head.kind === "branch" ? "accent" : "warning"}
            icon={<GitBranch size={12} aria-hidden />}
            mono={head.mono}
          >
            {head.text}
            {head.qualifier ? ` (${head.qualifier})` : ""}
          </Badge>
        </Field>
        <Field label="Upstream">
          {repo.upstream ? (
            repo.upstream.gone ? (
              <Badge tone="warning" icon={<Unplug size={12} aria-hidden />}>
                {repo.upstream.name} (gone)
              </Badge>
            ) : (
              <span>
                <span className="mono">{repo.upstream.name}</span>
                <span className="text-secondary">
                  {" "}
                  · {repo.upstream.ahead} ahead, {repo.upstream.behind} behind
                </span>
              </span>
            )
          ) : (
            <span className="text-muted">None</span>
          )}
        </Field>
        {repo.operation && (
          <Field label="In progress">
            <Badge tone="warning" icon={<GitMerge size={12} aria-hidden />}>
              {OPERATION_LABEL[repo.operation]}
            </Badge>
          </Field>
        )}
      </dl>

      <h3 className="bl-details__section">Last commit</h3>
      {commit ? (
        <div className="bl-commit-card">
          <p className="bl-commit-card__summary selectable">{commit.summary}</p>
          <div className="bl-commit-card__meta text-small">
            <GitCommitHorizontal size={14} aria-hidden />
            <span className="mono selectable" title={commit.oid}>
              {commit.shortOid}
            </span>
            <span className="text-secondary truncate">{commit.authorName}</span>
            <time
              className="text-muted"
              dateTime={commit.authorDate}
              title={new Date(commit.authorDate).toLocaleString()}
            >
              {relativeTime(commit.authorDate)}
            </time>
          </div>
        </div>
      ) : (
        <p className="text-secondary text-small">This branch has no commits yet.</p>
      )}
    </>
  );
}

export function DetailsPanel({
  repo,
  selected,
  width,
}: {
  repo: RepositoryInfo;
  selected: ChangeEntry | null;
  width: number;
}) {
  return (
    <aside
      className="bl-details"
      style={{ width }}
      aria-label={selected ? "File details" : "Repository details"}
    >
      {selected ? <FileDetails entry={selected} /> : <RepositoryOverview repo={repo} />}
    </aside>
  );
}
