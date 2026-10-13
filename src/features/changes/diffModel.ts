import type { DiffArea, FileDiff, HunkSelection } from "../../types/git";
import type { ChangeEntry } from "./changeModel";

export function diffAreaFor(entry: ChangeEntry): DiffArea {
  if (entry.area === "conflicted") return "conflicted";
  if (entry.area === "staged") return "staged";
  return entry.status === "untracked" ? "untracked" : "unstaged";
}

export type DiffRow =
  | { type: "hunk"; hunk: number }
  | { type: "line"; hunk: number; line: number }
  | { type: "noNewline"; hunk: number; line: number };

/** Flatten hunks into fixed-height rows for virtualized rendering. */
export function diffRows(diff: FileDiff, showHunkHeaders = true): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, h) => {
    if (showHunkHeaders) rows.push({ type: "hunk", hunk: h });
    hunk.lines.forEach((line, i) => {
      rows.push({ type: "line", hunk: h, line: i });
      if (line.noNewline) rows.push({ type: "noNewline", hunk: h, line: i });
    });
  });
  return rows;
}

/** Selected change lines per hunk. */
export type LineSelection = ReadonlyMap<number, ReadonlySet<number>>;

export function isChangeLine(diff: FileDiff, hunk: number, line: number): boolean {
  const l = diff.hunks[hunk]?.lines[line];
  return !!l && l.kind !== "context";
}

export function toggleLine(sel: LineSelection, hunk: number, line: number): LineSelection {
  const next = new Map(sel);
  const set = new Set(next.get(hunk) ?? []);
  if (set.has(line)) set.delete(line);
  else set.add(line);
  if (set.size) next.set(hunk, set);
  else next.delete(hunk);
  return next;
}

/** Select every change line between `from` and `to` (inclusive) within one hunk. */
export function selectRange(
  diff: FileDiff,
  sel: LineSelection,
  hunk: number,
  from: number,
  to: number,
): LineSelection {
  const next = new Map(sel);
  const set = new Set(next.get(hunk) ?? []);
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) if (isChangeLine(diff, hunk, i)) set.add(i);
  if (set.size) next.set(hunk, set);
  return next;
}

export function selectionCount(sel: LineSelection): number {
  let n = 0;
  for (const set of sel.values()) n += set.size;
  return n;
}

export function toSelections(sel: LineSelection): HunkSelection[] {
  return [...sel.entries()]
    .filter(([, set]) => set.size > 0)
    .sort(([a], [b]) => a - b)
    .map(([hunk, set]) => ({ hunk, lines: [...set].sort((a, b) => a - b) }));
}

/** Longest line in characters (tabs count as 4), capped for layout purposes. */
export function longestLine(diff: FileDiff, cap = 4000): number {
  let max = 0;
  for (const h of diff.hunks)
    for (const l of h.lines) {
      let n = l.content.length;
      for (const c of l.content) if (c === "\t") n += 3;
      if (n > max) max = n;
      if (max >= cap) return cap;
    }
  return max;
}

export const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})( |$)/;
