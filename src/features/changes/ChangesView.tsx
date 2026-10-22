import { Archive, CircleCheck, Search, TriangleAlert, X } from "lucide-react";
import { IconButton } from "../../components/Button";
import { useStashActions } from "../stash/StashActions";
import { useCallback, useMemo, useState } from "react";
import { useConfirm } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Splitter } from "../../components/Splitter";
import { useToast } from "../../components/Toast";
import { plural, splitPath } from "../../lib/format";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import { gitService } from "../../services/git";
import type {
  FileDiff,
  GitError,
  HunkSelection,
  LineAction,
  RepositoryInfo,
} from "../../types/git";
import { MergeEditor } from "../conflicts/MergeEditor";
import { useSettings } from "../settings/SettingsProvider";
import { OperationBanner } from "../integrate/OperationBanner";
import { RepositoryOverview } from "../repository/RepositoryOverview";
import type { RepositoryController } from "../repository/useRepository";
import { filterGroups, groupChanges, type ChangeEntry } from "./changeModel";
import { CommitBox } from "./CommitBox";
import { DiffView } from "./DiffView";
import { FileList, type FileAction } from "./FileList";
import "./ChangesView.css";

const ERROR_TITLE: Partial<Record<GitError["kind"], string>> = {
  stale: "The file changed",
  locked: "Repository is busy",
  applyFailed: "Could not apply the selection",
  unsupported: "Not possible",
};

/** Paths Git needs for an entry; renames involve both the old and the new path. */
function pathsOf(entries: ChangeEntry[]): string[] {
  const paths = entries.flatMap((e) => (e.originalPath ? [e.originalPath, e.path] : [e.path]));
  return [...new Set(paths)];
}

/**
 * When the selected entry disappears (for example after staging it), select the
 * next entry of the same area, else the same file in another area, else nothing.
 */
export function nextSelection(
  before: ChangeEntry[],
  after: ChangeEntry[],
  selectedId: string,
): string | null {
  const ids = new Set(after.map((e) => e.id));
  const index = before.findIndex((e) => e.id === selectedId);
  const old = before[index];
  if (!old) return null;
  const sameArea = before.filter((e) => e.area === old.area);
  const pos = sameArea.indexOf(old);
  const candidate =
    sameArea.slice(pos + 1).find((e) => ids.has(e.id)) ??
    sameArea
      .slice(0, pos)
      .reverse()
      .find((e) => ids.has(e.id)) ??
    after.find((e) => e.path === old.path);
  return candidate?.id ?? null;
}

export function ChangesView({
  repo,
  controller,
}: {
  repo: RepositoryInfo;
  controller: Pick<RepositoryController, "run" | "operation">;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const askDiscard = useSettings().settings.safety.confirmDiscard;
  const stash = useStashActions();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mergePath, setMergePath] = useState<string | null>(null);
  const [listWidth, setListWidth] = usePersistentNumber("branchline.layout.fileListWidth", 380);

  const groups = useMemo(() => groupChanges(repo.changes), [repo.changes]);
  const filtered = useMemo(() => filterGroups(groups, query), [groups, query]);
  const all = useMemo(() => [...groups.conflicted, ...groups.unstaged, ...groups.staged], [groups]);

  // Follow the selection when the list changes underneath it (adjusting state during render).
  const [previousAll, setPreviousAll] = useState(all);
  if (previousAll !== all) {
    setPreviousAll(all);
    if (selectedId && !all.some((e) => e.id === selectedId)) {
      setSelectedId(nextSelection(previousAll, all, selectedId));
    }
  }

  const selected = all.find((e) => e.id === selectedId) ?? null;
  const filteredCount =
    filtered.conflicted.length + filtered.unstaged.length + filtered.staged.length;
  const busy = controller.operation !== null;

  const reportError = useCallback(
    (title: string, error: GitError) =>
      toast({
        tone: error.kind === "stale" ? "info" : "error",
        title: ERROR_TITLE[error.kind] ?? title,
        description: error.detail ?? error.message,
      }),
    [toast],
  );

  const onFileAction = useCallback(
    async (action: FileAction, entries: ChangeEntry[]) => {
      if (entries.length === 0) return;
      const paths = pathsOf(entries);
      if (action === "discard" && askDiscard) {
        const untracked = entries.every((e) => e.status === "untracked");
        const one = entries.length === 1 ? splitPath(entries[0]!.path).name : null;
        const ok = await confirm({
          title: one
            ? `${untracked ? "Delete" : "Discard changes to"} ${one}?`
            : `Discard changes to ${entries.length} files?`,
          description: untracked
            ? "The untracked file is deleted from disk. This cannot be undone."
            : "Unstaged changes are lost; staged changes are kept. This cannot be undone.",
          confirmLabel: untracked ? "Delete file" : "Discard changes",
          destructive: true,
        });
        if (!ok) return;
      }
      const ops = {
        stage: ["Staging", gitService.stageFiles],
        unstage: ["Unstaging", gitService.unstageFiles],
        discard: ["Discarding", gitService.discardFiles],
      } as const;
      const [label, fn] = ops[action];
      const error = await controller.run(label, (repoPath) => fn(repoPath, paths));
      if (error) reportError(`${label} failed`, error);
    },
    [confirm, controller, reportError, askDiscard],
  );

  const onLineAction = useCallback(
    async (action: LineAction, diff: FileDiff, selections: HunkSelection[]) => {
      if (action === "discard" && askDiscard) {
        const ok = await confirm({
          title: "Discard the selected changes?",
          description: `They are removed from ${splitPath(diff.path).name} in your working tree. This cannot be undone.`,
          confirmLabel: "Discard",
          destructive: true,
        });
        if (!ok) return false;
      }
      const label =
        action === "stage" ? "Staging" : action === "unstage" ? "Unstaging" : "Discarding";
      const error = await controller.run(label, (repoPath) =>
        gitService.applyLines(repoPath, {
          path: diff.path,
          action,
          fingerprint: diff.fingerprint,
          selections,
        }),
      );
      if (error) reportError(`${label} failed`, error);
      return !error;
    },
    [confirm, controller, reportError, askDiscard],
  );

  const summary = [
    groups.conflicted.length && plural(groups.conflicted.length, "conflict"),
    groups.unstaged.length && `${groups.unstaged.length.toLocaleString()} unstaged`,
    groups.staged.length && `${groups.staged.length.toLocaleString()} staged`,
  ].filter(Boolean);

  return (
    <div className="bl-changes">
      <div className="bl-changes__list" style={{ width: listWidth }}>
        <div className="bl-changes__header">
          <div className="bl-changes__heading">
            <h1 className="text-h2">Changes</h1>
            <span className="text-small text-secondary truncate">
              {summary.length ? summary.join(" · ") : "Nothing to commit"}
            </span>
            {repo.totalChanges > 0 && (
              <IconButton
                label="Stash changes…"
                icon={<Archive size={16} aria-hidden />}
                size="sm"
                className="bl-changes__stash"
                disabled={busy || groups.conflicted.length > 0}
                onClick={stash.save}
                data-tooltip-align="end"
              />
            )}
          </div>
          {repo.totalChanges > 0 && (
            <label className="bl-search">
              <Search size={14} aria-hidden className="bl-search__icon" />
              <span className="visually-hidden">Filter changed files</span>
              <input
                type="search"
                placeholder="Filter files"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                spellCheck={false}
                autoComplete="off"
              />
              {query && (
                <button
                  type="button"
                  className="bl-search__clear"
                  aria-label="Clear filter"
                  onClick={() => setQuery("")}
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </label>
          )}
        </div>

        <OperationBanner repo={repo} conflicts={groups.conflicted.length} busy={busy} />
        {repo.truncated && (
          <div className="bl-banner bl-banner--warning" role="status">
            <TriangleAlert size={16} aria-hidden />
            <span>
              Showing the first {repo.changes.length.toLocaleString()} of{" "}
              {repo.totalChanges.toLocaleString()} changed files.
            </span>
          </div>
        )}

        {repo.totalChanges === 0 ? (
          <EmptyState
            tone="success"
            icon={<CircleCheck size={22} aria-hidden />}
            title="Working tree clean"
            description="There are no changes to stage or commit."
          />
        ) : filteredCount === 0 ? (
          <EmptyState
            icon={<Search size={20} aria-hidden />}
            title="No matching files"
            description={`Nothing matches “${query}”.`}
          />
        ) : (
          <FileList
            groups={filtered}
            selectedId={selected?.id ?? null}
            onSelect={(e) => setSelectedId(e.id)}
            onAction={(action, entries) => void onFileAction(action, entries)}
            onOpenMerge={(e) => setMergePath(e.path)}
            busy={busy}
          />
        )}
        <CommitBox repo={repo} controller={controller} />
      </div>

      <Splitter
        label="Resize file list"
        value={listWidth}
        min={260}
        max={720}
        side="left"
        onChange={setListWidth}
      />

      <div className="bl-changes__detail">
        {selected ? (
          <DiffView
            key={selected.id}
            repoPath={repo.path}
            revision={repo.inspectedAt}
            entry={selected}
            busy={busy}
            onFileAction={(action, entries) => void onFileAction(action, entries)}
            onLineAction={onLineAction}
            onOpenMerge={(e) => setMergePath(e.path)}
          />
        ) : (
          <RepositoryOverview repo={repo} />
        )}
      </div>
      {mergePath && (
        <MergeEditor
          key={mergePath}
          repoPath={repo.path}
          path={mergePath}
          run={controller.run}
          onClose={() => setMergePath(null)}
        />
      )}
    </div>
  );
}
