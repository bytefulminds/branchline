import { CircleAlert, Search, SlidersHorizontal, X } from "lucide-react";
import { forwardRef, useId } from "react";
import { Button } from "../../components/Button";
import { modKeyLabel } from "../../services/platform";
import type { GitError, LogFilter } from "../../types/git";
import { EMPTY_FILTER } from "./useHistory";

/** Number of filters set besides the search text (shown on the Filters button). */
export function activeFilterCount(filter: LogFilter): number {
  return [
    filter.author.trim(),
    filter.path.trim(),
    filter.since,
    filter.until,
    filter.currentBranch ? "yes" : "",
  ].filter(Boolean).length;
}

/** Search box shown in the History header. */
export const HistorySearch = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (text: string) => void;
    filtersOpen: boolean;
    filterCount: number;
    onToggleFilters: () => void;
  }
>(function HistorySearch({ value, onChange, filtersOpen, filterCount, onToggleFilters }, ref) {
  return (
    <div className="bl-history__search">
      <label className="bl-search">
        <Search size={14} aria-hidden className="bl-search__icon" />
        <span className="visually-hidden">Search commits</span>
        <input
          ref={ref}
          type="search"
          placeholder={`Search commits (${modKeyLabel}F)`}
          title="Message, author or commit id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.stopPropagation();
              onChange("");
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            className="bl-search__clear"
            aria-label="Clear search"
            onClick={() => onChange("")}
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </label>
      <Button
        size="sm"
        variant={filtersOpen || filterCount > 0 ? "secondary" : "ghost"}
        icon={<SlidersHorizontal size={14} aria-hidden />}
        aria-expanded={filtersOpen}
        aria-controls="history-filters"
        onClick={onToggleFilters}
      >
        Filters{filterCount > 0 ? ` (${filterCount})` : ""}
      </Button>
    </div>
  );
});

/** Author, path, date range and branch filters below the History header. */
export function HistoryFilterBar({
  filter,
  onChange,
  error,
}: {
  filter: LogFilter;
  onChange: (filter: LogFilter) => void;
  error: GitError | null;
}) {
  const id = useId();
  const set = <K extends keyof LogFilter>(key: K, value: LogFilter[K]) =>
    onChange({ ...filter, [key]: value });
  const any = activeFilterCount(filter) > 0 || filter.text.trim() !== "";

  return (
    <div id="history-filters" className="bl-history__filters" role="group" aria-label="Filters">
      <div className="bl-history__filter">
        <label htmlFor={`${id}-author`}>Author</label>
        <input
          id={`${id}-author`}
          className="bl-input"
          placeholder="Name or email"
          value={filter.author}
          onChange={(e) => set("author", e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="bl-history__filter bl-history__filter--wide">
        <label htmlFor={`${id}-path`}>File or folder</label>
        <input
          id={`${id}-path`}
          className="bl-input mono"
          placeholder="src/app.ts"
          value={filter.path}
          onChange={(e) => set("path", e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="bl-history__filter bl-history__filter--date">
        <label htmlFor={`${id}-since`}>From</label>
        <input
          id={`${id}-since`}
          className="bl-input"
          type="date"
          value={filter.since}
          max={filter.until || undefined}
          onChange={(e) => set("since", e.target.value)}
        />
      </div>
      <div className="bl-history__filter bl-history__filter--date">
        <label htmlFor={`${id}-until`}>To</label>
        <input
          id={`${id}-until`}
          className="bl-input"
          type="date"
          value={filter.until}
          min={filter.since || undefined}
          onChange={(e) => set("until", e.target.value)}
        />
      </div>
      <label className="bl-checkbox bl-history__filter-branch">
        <input
          type="checkbox"
          checked={filter.currentBranch}
          onChange={(e) => set("currentBranch", e.target.checked)}
        />
        <span>Current branch only</span>
      </label>
      <Button
        size="sm"
        variant="ghost"
        disabled={!any}
        onClick={() => onChange(EMPTY_FILTER)}
        className="bl-history__filter-clear"
      >
        Clear all
      </Button>
      {error && (
        <p className="bl-history__filter-error" role="alert">
          <CircleAlert size={14} aria-hidden />
          {error.message}
        </p>
      )}
    </div>
  );
}

/** Wrap occurrences of `query` (case-insensitive) in `<mark>`. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at === 0) return <>{text}</>;
  parts.push(text.slice(at));
  return <>{parts}</>;
}
