import { ArrowLeft, History } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { StatusLetter } from "../../components/StatusLetter";
import { splitPath } from "../../lib/format";
import { gitService } from "../../services/git";
import type { CommitFile, FileDiff, GitError } from "../../types/git";
import { DiffBody } from "../changes/DiffView";
import { DiffLayoutToggle } from "../changes/DiffLayoutToggle";
import { diffRows } from "../changes/diffModel";
import { fileStatus } from "./CommitDetailsPanel";

/** Read-only diff of one file in a commit. Keyed by commit and file in the parent. */
export function CommitDiffView({
  repoPath,
  oid,
  file,
  onBack,
  backLabel = "History",
  onShowHistory,
}: {
  repoPath: string;
  oid: string;
  file: CommitFile;
  onBack: () => void;
  /** Text of the back button (where it returns to). */
  backLabel?: string;
  /** Show the commits that changed this file. */
  onShowHistory?: (path: string) => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<GitError | null>(null);
  const [force, setForce] = useState(false);
  const [loadedForce, setLoadedForce] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    gitService
      .commitFileDiff(repoPath, oid, file.path, file.originalPath, force)
      .then((d) => {
        if (cancelled) return;
        setDiff(d);
        setError(null);
      })
      .catch((e: GitError) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoadedForce(force));
    return () => {
      cancelled = true;
    };
  }, [repoPath, oid, file.path, file.originalPath, force]);

  const rows = useMemo(() => (diff ? diffRows(diff) : []), [diff]);
  const { name, dir } = splitPath(file.path);
  const loading = loadedForce !== force;

  return (
    <section
      className="bl-diff"
      aria-label={`Changes in ${file.path} at ${oid.slice(0, 7)}`}
      onKeyDown={(e) => e.key === "Escape" && onBack()}
    >
      <header className="bl-diff__header">
        <div className="bl-diff__title">
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowLeft size={14} aria-hidden />}
            onClick={onBack}
            autoFocus
          >
            {backLabel}
          </Button>
          <StatusLetter status={fileStatus(file)} />
          <div className="bl-diff__name">
            <h2 className="text-h3 truncate selectable" title={file.path}>
              {name}
            </h2>
            <span className="text-small text-muted truncate selectable">
              {file.originalPath ? `${file.originalPath} → ${file.path}` : dir || "repository root"}
              {" · "}
              <span className="mono">{oid.slice(0, 7)}</span>
            </span>
          </div>
          {diff && (
            <span className="bl-diff__stats mono">
              <span className="bl-diff__add">+{diff.additions}</span>
              <span className="bl-diff__del">−{diff.deletions}</span>
            </span>
          )}
          {loading && diff && <Spinner size={14} label="Loading" />}
        </div>
        <div className="bl-diff__actions">
          <DiffLayoutToggle />
          {onShowHistory && (
            <IconButton
              size="sm"
              label="Show file history"
              icon={<History size={14} aria-hidden />}
              onClick={() => onShowHistory(file.path)}
            />
          )}
        </div>
      </header>
      <DiffBody
        diff={diff}
        path={file.path}
        rows={rows}
        error={error}
        loading={loading}
        binaryNote="Binary file; its content is not shown."
        onShowLarge={() => setForce(true)}
      />
    </section>
  );
}
