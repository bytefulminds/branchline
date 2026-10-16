import { GitMerge } from "lucide-react";
import { Button } from "../../components/Button";
import { plural } from "../../lib/format";
import type { RepositoryInfo } from "../../types/git";
import { OPERATION_LABEL } from "../repository/headLabel";
import { useIntegrateActions } from "./IntegrateActions";

/** Merge, rebase, cherry-pick or revert in progress: what is left to do, and Continue / Skip / Abort. */
export function OperationBanner({
  repo,
  conflicts,
  busy,
}: {
  repo: RepositoryInfo;
  conflicts: number;
  busy: boolean;
}) {
  const actions = useIntegrateActions();
  const op = repo.operation;
  if (!op) return null;
  const progress = repo.operationProgress;
  const canSkip = op === "rebase" || op === "cherryPick" || op === "revert";

  const title =
    op === "rebase" && progress
      ? `Rebasing ${progress.branch ?? "branch"}: commit ${progress.step} of ${progress.total}.`
      : `${OPERATION_LABEL[op]}.`;
  const next =
    op === "bisect"
      ? "Mark commits from the command line, or stop bisecting here."
      : conflicts > 0
        ? `Resolve ${plural(conflicts, "conflicted file")}, then continue.`
        : op === "merge"
          ? "All conflicts are resolved. Commit the merge to finish it."
          : "All conflicts are resolved. Continue to finish this step.";

  return (
    <div className="bl-banner bl-banner--warning bl-operation" role="status">
      <GitMerge size={16} aria-hidden />
      <div className="bl-operation__body">
        <span>
          <strong>{title}</strong> {next}
          {repo.heldChanges &&
            " Your uncommitted changes are put aside by Git and come back when it is committed or aborted."}
        </span>
        <span className="bl-operation__actions">
          {op !== "bisect" && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || conflicts > 0}
              onClick={() => actions.step("continue")}
            >
              {op === "merge" ? "Commit merge" : "Continue"}
            </Button>
          )}
          {canSkip && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => actions.step("skip")}
            >
              Skip commit
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.step("abort")}>
            {op === "bisect" ? "Stop bisect" : "Abort"}
          </Button>
        </span>
      </div>
    </div>
  );
}
