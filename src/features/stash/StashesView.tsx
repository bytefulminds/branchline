import { Archive, CircleAlert, GitBranch, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { Splitter } from "../../components/Splitter";
import { StatusLetter } from "../../components/StatusLetter";
import { plural, relativeTime, splitPath } from "../../lib/format";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import { gitService } from "../../services/git";
import type { CommitFile, GitError, RepositoryInfo, StashInfo } from "../../types/git";
import { fileStatus } from "../history/CommitDetailsPanel";
import { CommitDiffView } from "../history/CommitDiffView";
import { stashLabel, useStashActions } from "./StashActions";
import "../history/HistoryView.css";
import "./StashesView.css";

interface StashFile {
  file: CommitFile;
  /** Commit the file's diff is read from (the stash, or its untracked-files commit). */
  oid: string;
  untracked: boolean;
}

/** Files of a stash: tracked changes against its base, plus untracked files. */
function useStashFiles(repoPath: string, stash: StashInfo) {
  const [state, setState] = useState<{ files: StashFile[] | null; error: GitError | null }>({
    files: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    const tracked = gitService.commitDetails(repoPath, stash.oid);
    const untracked = stash.untrackedOid
      ? gitService.commitDetails(repoPath, stash.untrackedOid)
      : Promise.resolve(null);
    Promise.all([tracked, untracked])
      .then(([t, u]) => {
        if (cancelled) return;
        const files: StashFile[] = [
          ...t.files.map((file) => ({ file, oid: stash.oid, untracked: false })),
          ...(u?.files ?? []).map((file) => ({ file, oid: u!.oid, untracked: true })),
        ];
        setState({ files, error: null });
      })
      .catch((error: GitError) => !cancelled && setState({ files: null, error }));
    return () => {
      cancelled = true;
    };
  }, [repoPath, stash.oid, stash.untrackedOid]);
  return state;
}

function StashDetails({
  repo,
  stash,
  busy,
}: {
  repo: RepositoryInfo;
  stash: StashInfo;
  busy: boolean;
}) {
  const actions = useStashActions();
  const { files, error } = useStashFiles(repo.path, stash);
  const [open, setOpen] = useState<StashFile | null>(null);

  if (open) {
    return (
      <CommitDiffView
        key={`${open.oid}:${open.file.path}`}
        repoPath={repo.path}
        oid={open.oid}
        file={open.file}
        onBack={() => setOpen(null)}
        backLabel="Stash"
      />
    );
  }

  return (
    <section className="bl-stash-details" aria-label="Stash details">
      <div className="bl-stash-details__head">
        <h2 className="text-h3 selectable">{stashLabel(stash)}</h2>
        {stash.autoMessage && <p className="text-small text-muted selectable">{stash.message}</p>}
        <p className="bl-stash-details__meta text-small text-secondary">
          <GitBranch size={13} aria-hidden />
          <span>{stash.branch ?? "detached HEAD"}</span>
          <span aria-hidden>·</span>
          <time dateTime={new Date(stash.time * 1000).toISOString()}>
            {relativeTime(stash.time * 1000)}
          </time>
          <span aria-hidden>·</span>
          <span className="mono">stash@{`{${stash.index}}`}</span>
        </p>
        <div className="bl-stash-details__actions">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => actions.pop(stash)}
            title="Apply the changes and remove the stash"
          >
            Pop
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => actions.apply(stash)}
            title="Apply the changes and keep the stash"
          >
            Apply
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={14} aria-hidden />}
            disabled={busy}
            onClick={() => actions.drop(stash)}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="bl-stash-details__files">
        {error ? (
          <EmptyState
            role="alert"
            tone="error"
            icon={<CircleAlert size={22} aria-hidden />}
            title="Could not load the stash"
            description={error.detail ?? error.message}
          />
        ) : !files ? (
          <div className="bl-commit-details__loading" role="status">
            <Spinner size={16} /> Loading files…
          </div>
        ) : (
          <>
            <div className="bl-commit-details__files-head">
              <h3 className="bl-section-label">{plural(files.length, "file")}</h3>
            </div>
            <ul className="bl-commit-files" aria-label="Stashed files">
              {files.map((f) => {
                const { name, dir } = splitPath(f.file.path);
                return (
                  <li key={`${f.untracked ? "u" : "t"}:${f.file.path}`}>
                    <button
                      type="button"
                      className="bl-commit-file"
                      title={f.file.path}
                      onClick={() => setOpen(f)}
                    >
                      <StatusLetter status={f.untracked ? "untracked" : fileStatus(f.file)} />
                      <span className="bl-commit-file__name truncate">{name}</span>
                      {dir && <span className="bl-commit-file__dir truncate">{dir}</span>}
                      <span className="bl-commit-file__stats mono">
                        {f.file.binary ? (
                          <span className="text-muted">bin</span>
                        ) : (
                          <>
                            {f.file.additions ? (
                              <span className="bl-diff__add">+{f.file.additions}</span>
                            ) : null}{" "}
                            {f.file.deletions ? (
                              <span className="bl-diff__del">−{f.file.deletions}</span>
                            ) : null}
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

export function StashesView({ repo, busy }: { repo: RepositoryInfo; busy: boolean }) {
  const actions = useStashActions();
  const { stashes } = actions;
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [listWidth, setListWidth] = usePersistentNumber("branchline.layout.stashListWidth", 380);
  const selected = stashes.find((s) => s.oid === selectedOid) ?? stashes[0] ?? null;
  const canStash = repo.totalChanges > 0;

  return (
    <div className="bl-stashes">
      <div className="bl-stashes__list" style={{ width: stashes.length ? listWidth : undefined }}>
        <div className="bl-stashes__header">
          <h1 className="text-h2">Stashes</h1>
          <span className="text-small text-secondary">
            {stashes.length ? plural(stashes.length, "stash", "stashes") : ""}
          </span>
          <span className="bl-stashes__spacer" />
          <IconButton
            label="Stash changes…"
            icon={<Plus size={16} aria-hidden />}
            disabled={!canStash || busy}
            onClick={actions.save}
            data-tooltip-align="end"
          />
        </div>
        {stashes.length === 0 ? (
          <EmptyState
            icon={<Archive size={22} aria-hidden />}
            title="No stashes"
            description="Stash puts uncommitted changes aside, so you can switch branches or pull, and bring them back later."
          >
            {canStash && (
              <Button variant="primary" onClick={actions.save} disabled={busy}>
                Stash changes…
              </Button>
            )}
          </EmptyState>
        ) : (
          <ul className="bl-stash-list" aria-label="Stashes">
            {stashes.map((s) => (
              <li key={s.oid}>
                <button
                  type="button"
                  className="bl-stash"
                  aria-current={selected?.oid === s.oid || undefined}
                  onClick={() => setSelectedOid(s.oid)}
                >
                  <Archive size={16} aria-hidden className="bl-stash__icon" />
                  <span className="bl-stash__text">
                    <span className="bl-stash__message truncate">{stashLabel(s)}</span>
                    <span className="bl-stash__meta text-small text-muted truncate">
                      {s.branch ?? "detached HEAD"} · {relativeTime(s.time * 1000)}
                      {s.untrackedOid ? " · with untracked files" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected && (
        <>
          <Splitter
            label="Resize stash list"
            value={listWidth}
            min={260}
            max={640}
            side="left"
            onChange={setListWidth}
          />
          <div className="bl-stashes__detail">
            <StashDetails key={selected.oid} repo={repo} stash={selected} busy={busy} />
          </div>
        </>
      )}
    </div>
  );
}
