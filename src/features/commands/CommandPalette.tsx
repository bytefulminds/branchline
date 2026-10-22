import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyMatch } from "./fuzzy";
import "./CommandPalette.css";

export interface Command {
  id: string;
  title: string;
  /** Section shown on the right, for example "Branch" or "Go to". */
  group: string;
  /** Extra words that should find the command. */
  keywords?: string;
  shortcut?: string;
  icon?: ReactNode;
  /** Why the command cannot run right now; it is shown but not runnable. */
  disabled?: string;
  run: () => void;
}

/** Results shown at most; typing narrows them down. */
const MAX_RESULTS = 60;

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  return <>{[...text].map((ch, i) => (marked.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>;
}

/**
 * Search box over every command (`Ctrl+K` / `⌘K`). Arrow keys move, Enter runs, Escape
 * closes. Focus stays in the search box; the list follows with `aria-activedescendant`.
 */
export function CommandPalette({
  commands,
  onClose,
  placeholder = "Type a command, branch or repository",
}: {
  commands: Command[];
  onClose: () => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const results = useMemo(() => {
    const scored = commands
      .map((command, order) => {
        const title = fuzzyMatch(query, command.title);
        const extra = title
          ? null
          : fuzzyMatch(query, `${command.group} ${command.keywords ?? ""}`);
        const match = title ?? (extra && { score: extra.score - 5, indices: [] });
        return match ? { command, match, order } : null;
      })
      .filter((r) => r !== null);
    if (query.trim()) scored.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
    return scored.slice(0, MAX_RESULTS);
  }, [commands, query]);

  const current = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const run = (i: number) => {
    const hit = results[i];
    if (!hit || hit.command.disabled) return;
    onClose();
    hit.command.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(results.length - 1, to)));
    };
    if (e.key === "ArrowDown") move(current + 1);
    else if (e.key === "ArrowUp") move(current - 1);
    else if (e.key === "PageDown") move(current + 8);
    else if (e.key === "PageUp") move(current - 8);
    else if (e.key === "Home" && e.ctrlKey) move(0);
    else if (e.key === "End" && e.ctrlKey) move(results.length - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      run(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // Nothing else to focus: keep focus in the search box.
      e.preventDefault();
    }
  };

  return (
    <div
      className="bl-palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bl-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="bl-palette__search">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(current) : undefined}
            aria-label="Command"
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="bl-palette__list"
        >
          {results.length === 0 && (
            <p className="bl-palette__empty" role="status">
              No commands match “{query}”.
            </p>
          )}
          {results.map(({ command, match }, i) => (
            <div
              key={command.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              aria-disabled={command.disabled ? true : undefined}
              className={`bl-palette__item${i === current ? " bl-palette__item--active" : ""}`}
              onPointerMove={() => i !== current && setActive(i)}
              onClick={() => run(i)}
            >
              <span className="bl-palette__icon" aria-hidden>
                {command.icon}
              </span>
              <span className="bl-palette__text">
                <span className="bl-palette__title truncate">
                  <Highlighted text={command.title} indices={match.indices} />
                </span>
                {command.disabled && (
                  <span className="bl-palette__reason truncate">{command.disabled}</span>
                )}
              </span>
              <span className="bl-palette__group">{command.group}</span>
              {command.shortcut && <kbd className="bl-kbd">{command.shortcut}</kbd>}
              {i === current && !command.disabled && (
                <CornerDownLeft size={14} aria-hidden className="bl-palette__enter" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
