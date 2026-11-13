import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Spinner } from "../../components/Spinner";
import { plural, relativeTime } from "../../lib/format";
import { gitService } from "../../services/git";
import type { GitError, GoneBranch } from "../../types/git";
import "./CleanupDialog.css";

/** Why a gone branch is kept, or null when it can go. */
export function keptBecause(b: GoneBranch): string | null {
  if (b.inUse) return "checked out";
  if (b.localOnly > 0) return `${plural(b.localOnly, "commit")} only on this computer`;
  return null;
}

/**
 * "Clean up branches": local branches whose upstream was deleted on the remote. Those whose
 * commits are all on the remote can go (checked); the others are listed and kept. Branches that
 * were never published never show up here.
 */
export function CleanupDialog({
  repoPath,
  version,
  fetching,
  onFetch,
  onDelete,
  onCancel,
}: {
  repoPath: string;
  /** Changes when the branches change (after a fetch), to look again. */
  version: unknown;
  fetching: boolean;
  onFetch: (() => void) | null;
  onDelete: (names: string[]) => Promise<GitError | null>;
  onCancel: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    version: unknown;
    list?: GoneBranch[];
    error?: GitError;
  } | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    gitService.goneBranches(repoPath).then(
      (list) => !cancelled && setLoaded({ version, list }),
      (error: GitError) => !cancelled && setLoaded({ version, error }),
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath, version]);

  const list = loaded?.list ?? [];
  const removable = list.filter((b) => !keptBecause(b));
  const kept = list.filter((b) => keptBecause(b));
  const chosen = removable.filter((b) => !unchecked.has(b.name)).map((b) => b.name);
  const loading = !loaded || loaded.version !== version;

  const submit = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    const error = await onDelete(chosen);
    setBusy(false);
    if (!error) onCancel();
  };

  return (
    <Dialog
      title="Clean up branches"
      size="wide"
      description="Local branches whose upstream was deleted on the remote, usually after their merge request was merged. Branches you never published stay."
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          {onFetch && (
            <Button
              variant="ghost"
              icon={<RefreshCw size={14} aria-hidden />}
              loading={fetching}
              disabled={busy}
              onClick={onFetch}
              title="Fetch to see branches deleted on the remote since the last fetch"
            >
              Fetch first
            </Button>
          )}
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!chosen.length || loading}
            loading={busy}
          >
            {chosen.length ? `Delete ${plural(chosen.length, "branch", "branches")}` : "Delete"}
          </Button>
        </>
      }
    >
      {loading && !loaded?.list ? (
        <p className="bl-cleanup__status" role="status">
          <Spinner size={14} /> Looking for branches…
        </p>
      ) : loaded?.error ? (
        <p className="bl-field-group__error" role="alert">
          {loaded.error.message}
        </p>
      ) : list.length === 0 ? (
        <p className="bl-cleanup__status text-secondary">
          Nothing to clean up. A branch shows up here once its upstream was deleted on the remote
          and you fetched since.
        </p>
      ) : (
        <>
          {removable.length > 0 && (
            <fieldset className="bl-cleanup__group">
              <legend className="bl-section-label">
                Can be deleted: every commit is on the remote
              </legend>
              <ul className="bl-cleanup__list">
                {removable.map((b) => (
                  <li key={b.name}>
                    <label className="bl-cleanup__row">
                      <input
                        type="checkbox"
                        checked={!unchecked.has(b.name)}
                        onChange={(e) =>
                          setUnchecked((u) => {
                            const next = new Set(u);
                            if (e.target.checked) next.delete(b.name);
                            else next.add(b.name);
                            return next;
                          })
                        }
                      />
                      <Row b={b} />
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {kept.length > 0 && (
            <section className="bl-cleanup__group" aria-label="Kept">
              <h3 className="bl-section-label">Kept</h3>
              <ul className="bl-cleanup__list">
                {kept.map((b) => (
                  <li key={b.name} className="bl-cleanup__row bl-cleanup__row--kept">
                    <Row b={b} />
                    <span className="bl-cleanup__why text-small">{keptBecause(b)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-small text-muted">
            Undo puts deleted branches back on the same commit, without their old upstream.
          </p>
        </>
      )}
    </Dialog>
  );
}

function Row({ b }: { b: GoneBranch }) {
  return (
    <span className="bl-cleanup__text">
      <span className="bl-cleanup__name mono truncate">{b.name}</span>
      <span className="text-small text-muted truncate">
        {b.upstream} deleted · {b.tipSummary} · {relativeTime(b.tipTime * 1000)}
      </span>
    </span>
  );
}
