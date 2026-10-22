/**
 * Commit selection in History: one focused commit (shown in the details panel)
 * plus, when several are selected, the whole set. Like a file manager:
 * click selects one, Cmd/Ctrl+click adds or removes one, Shift+click selects a range.
 */
export interface CommitSelection {
  /** Commit shown in the details panel and moved by the arrow keys. */
  focus: string | null;
  /** Fixed end of a Shift range. */
  anchor: string | null;
  oids: ReadonlySet<string>;
}

export type SelectMode = "replace" | "toggle" | "range";

export const EMPTY_SELECTION: CommitSelection = { focus: null, anchor: null, oids: new Set() };

export function single(oid: string): CommitSelection {
  return { focus: oid, anchor: oid, oids: new Set([oid]) };
}

/** Selection after selecting `oid`; `order` is the History order (newest first). */
export function nextSelection(
  current: CommitSelection,
  oid: string,
  mode: SelectMode,
  order: readonly string[],
): CommitSelection {
  if (mode === "toggle") {
    const oids = new Set(current.oids);
    if (current.oids.size === 0 && current.focus) oids.add(current.focus);
    if (oids.has(oid) && oids.size > 1) {
      oids.delete(oid);
      // Keep showing a commit that is still selected.
      const focus = order.find((o) => oids.has(o)) ?? null;
      return { focus, anchor: oid, oids };
    }
    oids.add(oid);
    return { focus: oid, anchor: oid, oids };
  }
  if (mode === "range") {
    const anchor = current.anchor ?? current.focus ?? oid;
    const from = order.indexOf(anchor);
    const to = order.indexOf(oid);
    if (from < 0 || to < 0) return single(oid);
    const [lo, hi] = from < to ? [from, to] : [to, from];
    return { focus: oid, anchor, oids: new Set(order.slice(lo, hi + 1)) };
  }
  return single(oid);
}

/** Selected commits that are still in the list, oldest first (the order to apply them). */
export function oldestFirst(oids: ReadonlySet<string>, order: readonly string[]): string[] {
  return order.filter((o) => oids.has(o)).reverse();
}
