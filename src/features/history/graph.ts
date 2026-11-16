/**
 * Commit graph lane layout.
 *
 * Commits arrive newest first with children before parents (`--date-order`).
 * Each lane "expects" the commit id that will continue it. The layout is
 * incremental: pass the returned state to the next call to continue a page.
 *
 * The default branch (the trunk, usually main) keeps the first lane and its own color
 * from top to bottom, so a branch that starts from it curves into it instead of taking it
 * over. Every run of a branch through the graph is a segment with its own id, which the
 * History view uses to follow one branch.
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
  /** The branch segment this line belongs to. */
  segment: number;
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
  /** The branch segment the commit is on. */
  segment: number;
  /** The commit is on the default branch's line. */
  trunk: boolean;
  /**
   * The merge commit whose unnamed side branch this commit is on: a branch that was merged
   * and has no branch name left. Null for every other commit.
   */
  mergedBy: string | null;
}

export interface GraphState {
  lanes: (string | null)[];
  colors: number[];
  /** Segment id per lane. */
  segments: number[];
  nextColor: number;
  nextSegment: number;
  /** Branch names at the tip of each segment. */
  segmentNames: Map<number, string[]>;
  /** The merge commit that started each unnamed side-branch segment. */
  segmentMergedBy: Map<number, string>;
  /**
   * The default branch: the tips it may start at (until one is reached), then the next
   * commit on its first-parent line. Null when there is none, or once it has ended.
   */
  trunk: { tips: string[] | null; next: string | null } | null;
  /** Color 0 stays reserved for the trunk. */
  trunkColor: boolean;
}

export interface LayoutOptions {
  /** Short branch names per commit (`origin/main` counts as `main`); tags are left out. */
  names?: ReadonlyMap<string, readonly string[]>;
}

export const GRAPH_COLORS = 8;
/** Segment id of the default branch. */
export const TRUNK_SEGMENT = 0;
/** Lane 0 is kept free for the default branch until its tip comes along. */
const RESERVED = "\u0000trunk";

/**
 * A fresh layout. `trunkTips` are the commits the default branch may start at (for example
 * `main` and `origin/main`); the first one met in the history becomes the trunk.
 */
export function emptyGraphState(trunkTips: readonly string[] = []): GraphState {
  const trunk = trunkTips.length > 0;
  return {
    lanes: trunk ? [RESERVED] : [],
    colors: trunk ? [0] : [],
    segments: trunk ? [TRUNK_SEGMENT] : [],
    nextColor: 0,
    nextSegment: TRUNK_SEGMENT + 1,
    segmentNames: new Map(),
    segmentMergedBy: new Map(),
    trunk: trunk ? { tips: [...trunkTips], next: null } : null,
    trunkColor: trunk,
  };
}

function freeLane(lanes: (string | null)[], avoid: number): number {
  for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i;
  return lanes.length === avoid ? avoid + 1 : lanes.length;
}

const NO_NAMES: readonly string[] = [];

export function layoutGraph(
  commits: GraphCommit[],
  previous: GraphState = emptyGraphState(),
  options: LayoutOptions = {},
): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...previous.lanes];
  const colors = [...previous.colors];
  const segments = [...previous.segments];
  let { nextColor, nextSegment } = previous;
  const segmentNames = new Map(previous.segmentNames);
  const segmentMergedBy = new Map(previous.segmentMergedBy);
  let trunk = previous.trunk ? { ...previous.trunk } : null;
  const rows: GraphRow[] = [];
  const namesOf = (oid: string) => options.names?.get(oid) ?? NO_NAMES;

  const newColor = () =>
    previous.trunkColor ? 1 + (nextColor++ % (GRAPH_COLORS - 1)) : nextColor++ % GRAPH_COLORS;
  const newSegment = (names: readonly string[], mergedBy: string | null) => {
    const id = nextSegment++;
    if (names.length) segmentNames.set(id, [...names]);
    if (mergedBy !== null) segmentMergedBy.set(id, mergedBy);
    return id;
  };

  for (const commit of commits) {
    const before = [...lanes];
    const colorsBefore = [...colors];
    const segmentsBefore = [...segments];
    const lines: GraphLine[] = [];
    const names = namesOf(commit.oid);

    const isTrunk =
      trunk !== null && (trunk.next === commit.oid || (trunk.tips?.includes(commit.oid) ?? false));

    let lane: number;
    if (isTrunk) {
      lane = 0;
      lanes[0] = commit.oid;
      colors[0] = 0;
      segments[0] = TRUNK_SEGMENT;
      trunk = { tips: null, next: null };
    } else {
      const expecting: number[] = [];
      before.forEach((expected, i) => {
        if (expected === commit.oid) expecting.push(i);
      });
      if (expecting.length === 0) {
        // A branch tip: nothing above leads here.
        lane = freeLane(lanes, -1);
        lanes[lane] = commit.oid;
        colors[lane] = newColor();
        segments[lane] = newSegment(names, null);
      } else {
        // A commit that some named branch also leads to belongs to that branch, not to a
        // merged side branch.
        lane = expecting.find((i) => !segmentMergedBy.has(segments[i]!)) ?? expecting[0]!;
        const current = segmentNames.get(segments[lane]!) ?? NO_NAMES;
        // Another branch's tip: a new segment (and color) starts here.
        if (
          segments[lane] !== TRUNK_SEGMENT &&
          names.length > 0 &&
          !names.some((n) => current.includes(n))
        ) {
          colors[lane] = newColor();
          segments[lane] = newSegment(names, null);
        }
      }
    }
    const color = colors[lane]!;
    const segment = segments[lane]!;

    // Lines entering from above.
    before.forEach((expected, i) => {
      if (expected === commit.oid) {
        lines.push({
          part: "top",
          from: i,
          to: lane,
          color: colorsBefore[i]!,
          segment: segmentsBefore[i]!,
        });
        if (i !== lane) lanes[i] = null; // merges into this commit's lane
      }
    });

    // Parents leaving below.
    const [first, ...others] = commit.parents;
    if (first === undefined) {
      lanes[lane] = null;
      if (isTrunk) trunk = null;
    } else {
      // Keep this lane running down to the first parent, even when another lane
      // also expects it; parallel lanes converge at the parent's row.
      lanes[lane] = first;
      if (isTrunk) trunk = { tips: null, next: first };
      lines.push({ part: "bottom", from: lane, to: lane, color, segment });
      for (const parent of others) {
        const j = lanes.indexOf(parent);
        if (j !== -1) {
          lines.push({
            part: "bottom",
            from: lane,
            to: j,
            color: colors[j]!,
            segment: segments[j]!,
          });
        } else {
          const k = freeLane(lanes, lane);
          const parentNames = namesOf(parent);
          lanes[k] = parent;
          colors[k] = newColor();
          segments[k] = newSegment(parentNames, parentNames.length ? null : commit.oid);
          lines.push({
            part: "bottom",
            from: lane,
            to: k,
            color: colors[k]!,
            segment: segments[k]!,
          });
        }
      }
    }

    // Lanes that simply pass by this row.
    before.forEach((expected, i) => {
      if (
        expected !== null &&
        expected !== undefined &&
        expected !== commit.oid &&
        expected !== RESERVED
      ) {
        lines.push({
          part: "full",
          from: i,
          to: i,
          color: colorsBefore[i]!,
          segment: segmentsBefore[i]!,
        });
      }
    });

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
      segments.pop();
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
      segment,
      trunk: isTrunk,
      mergedBy: segmentMergedBy.get(segment) ?? null,
    });
  }

  return {
    rows,
    state: {
      lanes,
      colors,
      segments,
      nextColor,
      nextSegment,
      segmentNames,
      segmentMergedBy,
      trunk,
      trunkColor: previous.trunkColor,
    },
  };
}

/** The lane a point in a graph row is on, from its x position. */
export function laneAt(x: number, pad: number, laneWidth: number): number {
  return Math.max(0, Math.round((x - pad) / laneWidth));
}

/** The segment drawn at `lane` in this row: its commit, or a line passing or ending there. */
export function segmentAt(row: GraphRow, lane: number): number | null {
  if (lane === row.lane) return row.segment;
  const line =
    row.lines.find((l) => l.part === "full" && l.from === lane) ??
    row.lines.find((l) => (l.part === "top" ? l.from : l.to) === lane);
  return line ? line.segment : null;
}

/** What a ref contributes to the layout: branch names per commit and the default branch. */
export interface RefLike {
  name: string;
  kind: "branch" | "remote" | "tag";
  oid: string;
}

/** Names of the default branch, most likely first. */
const TRUNK_NAMES = ["main", "master", "trunk", "develop"];

/** Short branch names per commit: `origin/main` counts as `main`. Tags are left out. */
export function branchNames(refs: readonly RefLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of refs) {
    if (r.kind === "tag") continue;
    const name = r.kind === "remote" ? r.name.slice(r.name.indexOf("/") + 1) : r.name;
    if (!name || name === "HEAD") continue;
    const list = map.get(r.oid);
    if (!list) map.set(r.oid, [name]);
    else if (!list.includes(name)) list.push(name);
  }
  return map;
}

/**
 * The commits the default branch may start at: the local branch and its copy on the
 * remote (origin first) for the first of main, master, trunk and develop that exists.
 */
export function trunkTips(refs: readonly RefLike[]): string[] {
  for (const name of TRUNK_NAMES) {
    const local = refs.filter((r) => r.kind === "branch" && r.name === name);
    const remote = refs
      .filter(
        (r) => r.kind === "remote" && r.name.endsWith(`/${name}`) && r.name.split("/").length === 2,
      )
      .sort((a, b) => Number(b.name.startsWith("origin/")) - Number(a.name.startsWith("origin/")));
    const tips = [...local, ...remote].map((r) => r.oid);
    if (tips.length) return [...new Set(tips)];
  }
  return [];
}

export interface HistoryGraph<C extends GraphCommit> {
  /** The commits to show, without those of collapsed side branches. */
  commits: C[];
  rows: GraphRow[];
  /** Merge commits with merged side branches: how many commits the side branches hold. */
  folds: Map<string, { count: number; expanded: boolean }>;
}

/**
 * Lays out the history. With `collapse`, the commits of unnamed merged side branches are
 * left out (except under the merges in `expanded`), and their merges list how many.
 */
export function historyGraph<C extends GraphCommit>(
  commits: C[],
  refs: readonly RefLike[],
  collapse = false,
  expanded: ReadonlySet<string> = new Set(),
): HistoryGraph<C> {
  const names = branchNames(refs);
  const tips = trunkTips(refs);
  const first = layoutGraph(commits, emptyGraphState(tips), { names }).rows;

  // Total side-branch commits under each merge, nested side branches included.
  const mergedByOf = new Map<string, string | null>();
  const folds = new Map<string, { count: number; expanded: boolean }>();
  commits.forEach((c, i) => {
    const row = first[i]!;
    mergedByOf.set(c.oid, row.mergedBy);
    for (let m = row.mergedBy; m !== null; m = mergedByOf.get(m) ?? null) {
      const f = folds.get(m) ?? { count: 0, expanded: expanded.has(m) };
      f.count++;
      folds.set(m, f);
    }
  });
  if (!collapse) return { commits, rows: first, folds };

  // A commit is hidden when the merge that started its side branch is collapsed or hidden.
  const hidden = new Set<string>();
  commits.forEach((c, i) => {
    const m = first[i]!.mergedBy;
    if (m !== null && (hidden.has(m) || !expanded.has(m))) hidden.add(c.oid);
  });
  const shown: C[] = [];
  const links: GraphCommit[] = [];
  for (const c of commits) {
    if (hidden.has(c.oid)) continue;
    shown.push(c);
    // Lines to hidden commits are left out: a collapsed merge no longer links to its side branch.
    links.push(
      c.parents.some((p) => hidden.has(p))
        ? { oid: c.oid, parents: c.parents.filter((p) => !hidden.has(p)) }
        : c,
    );
  }
  const rows = layoutGraph(links, emptyGraphState(tips), { names }).rows;
  // A collapsed merge keeps drawing as a merge.
  shown.forEach((c, i) => {
    if (folds.has(c.oid)) rows[i] = { ...rows[i]!, isMerge: true };
  });
  return { commits: shown, rows, folds };
}
