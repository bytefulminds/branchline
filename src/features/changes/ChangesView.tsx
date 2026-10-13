import { CircleCheck, GitMerge, Search, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Splitter } from "../../components/Splitter";
import { plural } from "../../lib/format";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import type { RepositoryInfo } from "../../types/git";
import { OPERATION_LABEL } from "../repository/headLabel";
import { filterGroups, groupChanges, type ChangeEntry } from "./changeModel";
import { DetailsPanel } from "./DetailsPanel";
import { FileList } from "./FileList";
import "./ChangesView.css";

export function ChangesView({ repo }: { repo: RepositoryInfo }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailsWidth, setDetailsWidth] = usePersistentNumber(
    "branchline.layout.detailsWidth",
    320,
  );

  const groups = useMemo(() => groupChanges(repo.changes), [repo.changes]);
  const filtered = useMemo(() => filterGroups(groups, query), [groups, query]);
  const all = useMemo(() => [...groups.conflicted, ...groups.unstaged, ...groups.staged], [groups]);
  // Selection survives refreshes as long as the same file/area still exists.
  const selected: ChangeEntry | null = all.find((e) => e.id === selectedId) ?? null;
  const filteredCount =
    filtered.conflicted.length + filtered.unstaged.length + filtered.staged.length;

  const summary = [
    groups.conflicted.length && plural(groups.conflicted.length, "conflict"),
    groups.unstaged.length && `${groups.unstaged.length.toLocaleString()} unstaged`,
    groups.staged.length && `${groups.staged.length.toLocaleString()} staged`,
  ].filter(Boolean);

  return (
    <div className="bl-changes">
      <div className="bl-changes__main">
        <div className="bl-changes__header">
          <div className="bl-changes__heading">
            <h1 className="text-h2">Changes</h1>
            <span className="text-small text-secondary">
              {summary.length ? summary.join(" · ") : "Nothing to commit"}
            </span>
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

        {repo.operation && (
          <div className="bl-banner bl-banner--warning" role="status">
            <GitMerge size={16} aria-hidden />
            <span>
              <strong>{OPERATION_LABEL[repo.operation]}.</strong>{" "}
              {groups.conflicted.length > 0
                ? `Resolve ${plural(groups.conflicted.length, "conflicted file")} to continue.`
                : "Finish or abort it from the command line for now."}
            </span>
          </div>
        )}
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
          />
        )}
      </div>

      <Splitter
        label="Resize details panel"
        value={detailsWidth}
        min={260}
        max={560}
        side="right"
        onChange={setDetailsWidth}
      />
      <DetailsPanel repo={repo} selected={selected} width={detailsWidth} />
    </div>
  );
}
