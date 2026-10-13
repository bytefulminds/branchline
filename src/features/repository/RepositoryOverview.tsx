import { GitBranch, GitCommitHorizontal, GitMerge, MousePointerClick, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { displayPath, relativeTime } from "../../lib/format";
import type { RepositoryInfo } from "../../types/git";
import { headLabel, OPERATION_LABEL } from "./headLabel";
import "./RepositoryOverview.css";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bl-field">
      <dt className="bl-field__label">{label}</dt>
      <dd className="bl-field__value">{children}</dd>
    </div>
  );
}

/** Summary of the repository, shown when no file is selected. */
export function RepositoryOverview({ repo }: { repo: RepositoryInfo }) {
  const head = headLabel(repo.head);
  const commit = repo.headCommit;
  return (
    <section className="bl-overview" aria-label="Repository details">
      <h2 className="text-h2 truncate">{repo.name}</h2>
      <dl className="bl-overview__fields">
        <Field label="Location">
          <span className="mono selectable bl-overview__path">{displayPath(repo.path)}</span>
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

      <h3 className="bl-overview__section">Last commit</h3>
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

      {repo.totalChanges > 0 && (
        <p className="bl-overview__hint text-small text-muted">
          <MousePointerClick size={14} aria-hidden /> Select a file to see its changes.
        </p>
      )}
    </section>
  );
}
