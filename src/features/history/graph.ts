/**
 * Commit graph lane layout.
 *
 * Commits arrive newest first with children before parents (`--date-order`).
 * Each lane "expects" the commit id that will continue it. The layout is
 * incremental: pass the returned state to the next call to continue a page.
 */

export interface GraphCommit {
  oid: string;
  parents: string[];
}

export type LinePart = "top" | "bottom" | "full";

export interface GraphLine {
  part: LinePart;
  /** Lane at the top (for "top"/"full") or at the node (for "bottom"). */
  from: number;
  /** Lane at the node (for "top") or at the bottom (for "bottom"/"full"). */
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  isMerge: boolean;
  /** Commit has no parents. */
  isRoot: boolean;
  lines: GraphLine[];
  /** Number of lanes this row touches (for sizing). */
  width: number;
}

export interface GraphState {
  lanes: (string | null)[];
  colors: number[];
  nextColor: number;
}

export const GRAPH_COLORS = 8;

export function emptyGraphState(): GraphState {
  return { lanes: [], colors: [], nextColor: 0 };
}

function freeLane(lanes: (string | null)[], avoid: number): number {
  for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i;
  return lanes.length === avoid ? avoid + 1 : lanes.length;
}

export function layoutGraph(
  commits: GraphCommit[],
  previous: GraphState = emptyGraphState(),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...previous.lanes];
  const colors = [...previous.colors];
  let nextColor = previous.nextColor;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = [...lanes];
    const lines: GraphLine[] = [];

    let lane = lanes.indexOf(commit.oid);
    if (lane === -1) {
      // A branch tip: nothing above leads here.
      lane = freeLane(lanes, -1);
      lanes[lane] = commit.oid;
      colors[lane] = nextColor++ % GRAPH_COLORS;
    }
    const color = colors[lane]!;

    // Lines entering from above.
    before.forEach((expected, i) => {
      if (expected === null || expected === undefined) return;
      if (expected === commit.oid) {
        lines.push({ part: "top", from: i, to: lane, color: colors[i]! });
        if (i !== lane) lanes[i] = null; // merges into this commit's lane
      }
    });

    // Parents leaving below.
    const [first, ...others] = commit.parents;
    if (first === undefined) {
      lanes[lane] = null;
    } else {
      // Keep this lane running down to the first parent, even when another lane
      // also expects it; parallel lanes converge at the parent's row.
      lanes[lane] = first;
      lines.push({ part: "bottom", from: lane, to: lane, color });
      for (const parent of others) {
        const j = lanes.indexOf(parent);
        if (j !== -1) {
          lines.push({ part: "bottom", from: lane, to: j, color: colors[j]! });
        } else {
          const k = freeLane(lanes, lane);
          lanes[k] = parent;
          colors[k] = nextColor++ % GRAPH_COLORS;
          lines.push({ part: "bottom", from: lane, to: k, color: colors[k]! });
        }
      }
    }

    // Lanes that simply pass by this row.
    before.forEach((expected, i) => {
      if (expected !== null && expected !== undefined && expected !== commit.oid) {
        lines.push({ part: "full", from: i, to: i, color: colors[i]! });
      }
    });

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }

    let width = lane + 1;
    for (const l of lines) width = Math.max(width, l.from + 1, l.to + 1);
    rows.push({
      lane,
      color,
      isMerge: commit.parents.length > 1,
      isRoot: commit.parents.length === 0,
      lines,
      width,
    });
  }

  return { rows, state: { lanes, colors, nextColor } };
}
