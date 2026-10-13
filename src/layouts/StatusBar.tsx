import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  GitBranch,
  GitMerge,
  Unplug,
} from "lucide-react";
import { Spinner } from "../components/Spinner";
import { headLabel, OPERATION_LABEL } from "../features/repository/headLabel";
import type { RepositoryState } from "../features/repository/useRepository";
import { clockTime, plural } from "../lib/format";
import type { GitError, GitVersion } from "../types/git";
import "./StatusBar.css";

export function StatusBar({
  state,
  gitVersion,
}: {
  state: RepositoryState;
  gitVersion: GitVersion | GitError | null;
}) {
  const repo = state.status === "ready" ? state.repo : null;
  const conflicts = repo?.changes.filter((c) => c.conflict).length ?? 0;
  const head = repo ? headLabel(repo.head) : null;

  return (
    <footer className="bl-statusbar" role="contentinfo" aria-label="Status bar">
      <div className="bl-statusbar__group">
        {state.status === "idle" && <span className="bl-statusbar__item">No repository open</span>}
        {state.status === "loading" && (
          <span className="bl-statusbar__item" role="status">
            <Spinner size={12} /> Opening repository…
          </span>
        )}
        {state.status === "error" && (
          <span className="bl-statusbar__item bl-statusbar__item--error">
            <CircleAlert size={13} aria-hidden /> {state.error.message}
          </span>
        )}
        {repo && head && (
          <>
            <span className="bl-statusbar__item" title={head.title}>
              <GitBranch size={13} aria-hidden />
              <span className={head.mono ? "mono" : undefined}>{head.text}</span>
              {head.qualifier && <span className="text-muted">({head.qualifier})</span>}
            </span>
            {repo.upstream && !repo.upstream.gone && (
              <span
                className="bl-statusbar__item"
                title={`${repo.upstream.ahead} ahead, ${repo.upstream.behind} behind ${repo.upstream.name}`}
              >
                <ArrowUp size={13} aria-hidden />
                <span aria-label={`${repo.upstream.ahead} ahead`}>{repo.upstream.ahead}</span>
                <ArrowDown size={13} aria-hidden />
                <span aria-label={`${repo.upstream.behind} behind`}>{repo.upstream.behind}</span>
              </span>
            )}
            {repo.upstream?.gone && (
              <span
                className="bl-statusbar__item bl-statusbar__item--warning"
                title={`${repo.upstream.name} no longer exists`}
              >
                <Unplug size={13} aria-hidden /> Upstream gone
              </span>
            )}
            {repo.operation && (
              <span className="bl-statusbar__item bl-statusbar__item--warning">
                <GitMerge size={13} aria-hidden /> {OPERATION_LABEL[repo.operation]}
              </span>
            )}
            {conflicts > 0 ? (
              <span className="bl-statusbar__item bl-statusbar__item--error">
                <CircleAlert size={13} aria-hidden /> {plural(conflicts, "conflict")}
              </span>
            ) : repo.totalChanges === 0 ? (
              <span className="bl-statusbar__item bl-statusbar__item--success">
                <CircleCheck size={13} aria-hidden /> Working tree clean
              </span>
            ) : (
              <span className="bl-statusbar__item">
                {plural(repo.totalChanges, "changed file")}
              </span>
            )}
          </>
        )}
      </div>

      <div className="bl-statusbar__group">
        {state.status === "ready" &&
          (state.refreshing ? (
            <span className="bl-statusbar__item" role="status">
              <Spinner size={12} /> Refreshing…
            </span>
          ) : (
            <span
              className="bl-statusbar__item text-muted"
              title={`Git status took ${state.repo.durationMs} ms`}
            >
              Updated {clockTime(state.repo.inspectedAt)}
            </span>
          ))}
        {gitVersion && "version" in gitVersion && (
          <span className="bl-statusbar__item text-muted" title={gitVersion.path}>
            Git {gitVersion.version}
          </span>
        )}
        {gitVersion && "kind" in gitVersion && (
          <span className="bl-statusbar__item bl-statusbar__item--error" title={gitVersion.message}>
            <CircleAlert size={13} aria-hidden /> Git unavailable
          </span>
        )}
      </div>
    </footer>
  );
}
