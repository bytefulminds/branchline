import { describe, expect, it } from "vitest";
import {
  branchNames,
  emptyGraphState,
  historyGraph,
  layoutGraph,
  segmentAt,
  TRUNK_SEGMENT,
  trunkTips,
  type GraphCommit,
  type GraphRow,
  type RefLike,
} from "./graph";

const c = (oid: string, ...parents: string[]): GraphCommit => ({ oid, parents });

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, state } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]!.lines).toEqual([
      expect.objectContaining({ part: "bottom", from: 0, to: 0, color: 0 }),
    ]);
    expect(rows[1]!.lines).toContainEqual(
      expect.objectContaining({ part: "top", from: 0, to: 0, color: 0 }),
    );
    expect(rows[2]!.isRoot).toBe(true);
    expect(state.lanes).toEqual([]);
  });

  it("opens a lane for a merge parent and closes it at the fork point", () => {
    // m merges f into main; f and b both come from a.
    const { rows } = layoutGraph([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    expect(rows[0]!.isMerge).toBe(true);
    expect(rows[0]!.lines).toContainEqual(
      expect.objectContaining({ part: "bottom", from: 0, to: 1 }),
    );
    expect(rows[1]!.lane).toBe(1); // f continues the second lane
    // b passes lane 1 (expecting a) while sitting on lane 0.
    expect(rows[2]!.lane).toBe(0);
    // At a, both lanes converge.
    const tops = rows[3]!.lines.filter((l) => l.part === "top");
    expect(tops.map((l) => [l.from, l.to])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(rows[3]!.lane).toBe(0);
  });

  it("gives separate branch tips their own lanes and colors", () => {
    const { rows } = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(1);
    expect(rows[0]!.color).not.toBe(rows[1]!.color);
    // Both lanes run down to a and converge there.
    expect(rows[1]!.lines).toContainEqual(
      expect.objectContaining({ part: "bottom", from: 1, to: 1, color: rows[1]!.color }),
    );
    expect(rows[2]!.lane).toBe(0);
    expect(rows[2]!.lines.filter((l) => l.part === "top").map((l) => l.from)).toEqual([0, 1]);
  });

  it("continues across pages with the returned state", () => {
    const all = [c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")];
    const whole = layoutGraph(all).rows;
    const first = layoutGraph(all.slice(0, 2));
    const second = layoutGraph(all.slice(2), first.state);
    expect([...first.rows, ...second.rows]).toEqual(whole);
  });

  it("reuses freed lanes", () => {
    const { rows } = layoutGraph([
      c("m", "b", "f"),
      c("f", "a"),
      c("b", "a"),
      c("a", "z"),
      c("t", "z"), // new tip after lane 1 was freed
      c("z"),
    ]);
    expect(rows[4]!.lane).toBe(1);
  });

  it("handles octopus merges", () => {
    const { rows } = layoutGraph([c("o", "a", "b", "c"), c("a"), c("b"), c("c")]);
    const bottoms = rows[0]!.lines.filter((l) => l.part === "bottom").map((l) => l.to);
    expect(bottoms).toEqual([0, 1, 2]);
    expect(rows[0]!.width).toBe(3);
  });
});

const branch = (name: string, oid: string): RefLike => ({ name, kind: "branch", oid });
const remote = (name: string, oid: string): RefLike => ({ name, kind: "remote", oid });
const lanesOf = (rows: GraphRow[]) => rows.map((r) => r.lane);

describe("the default branch", () => {
  it("keeps main on its own lane when a new branch has one commit on top", () => {
    // feature/login was made from main and has one commit.
    const commits = [c("x", "m"), c("m", "b"), c("b", "a"), c("a")];
    const refs = [branch("feature/login", "x"), branch("main", "m"), remote("origin/main", "m")];
    const { rows } = historyGraph(commits, refs);
    expect(lanesOf(rows)).toEqual([1, 0, 0, 0]);
    // The branch curves into main at main's tip.
    expect(rows[1]!.lines).toContainEqual(expect.objectContaining({ part: "top", from: 1, to: 0 }));
    expect(rows.slice(1).every((r) => r.trunk && r.color === 0)).toBe(true);
    expect(rows[0]!.color).not.toBe(0);
    // Nothing is drawn on main's lane above its tip.
    expect(rows[0]!.lines.some((l) => l.from === 0 || l.to === 0)).toBe(false);
  });

  it("follows main's first parents, so merged branches leave it", () => {
    const commits = [c("m2", "m1", "f1"), c("f1", "m0"), c("m1", "m0"), c("m0")];
    const { rows } = historyGraph(commits, [branch("main", "m2")]);
    expect(lanesOf(rows)).toEqual([0, 1, 0, 0]);
    expect(rows.map((r) => r.trunk)).toEqual([true, false, true, true]);
  });

  it("starts at whichever of main and origin/main comes first", () => {
    // origin/main is one commit ahead of main.
    const commits = [c("o", "m"), c("m", "a"), c("a")];
    const { rows } = historyGraph(commits, [branch("main", "m"), remote("origin/main", "o")]);
    expect(lanesOf(rows)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.trunk)).toBe(true);
  });

  it("uses master, trunk or develop when there is no main", () => {
    expect(trunkTips([branch("develop", "d"), branch("master", "m")])).toEqual(["m"]);
    expect(trunkTips([remote("upstream/main", "u"), remote("origin/main", "o")])).toEqual([
      "o",
      "u",
    ]);
    expect(trunkTips([branch("feature", "f")])).toEqual([]);
  });

  it("lays out without a default branch as before", () => {
    const commits = [c("x", "m"), c("m", "a"), c("a")];
    expect(lanesOf(historyGraph(commits, [branch("feature", "x")]).rows)).toEqual([0, 0, 0]);
    expect(lanesOf(layoutGraph(commits).rows)).toEqual([0, 0, 0]);
  });

  it("leaves lane 0 free while main's tip has not been loaded yet", () => {
    const { rows, state } = layoutGraph([c("x", "y")], emptyGraphState(["m"]));
    expect(rows[0]!.lane).toBe(1);
    expect(state.lanes[0]).not.toBeNull();
  });
});

describe("branch segments", () => {
  it("gives every branch its own segment, also when it continues a lane", () => {
    // feature/b was branched from feature/a, which was branched from main.
    const commits = [c("b1", "a2"), c("a2", "a1"), c("a1", "m"), c("m")];
    const refs = [branch("feature/b", "b1"), branch("feature/a", "a2"), branch("main", "m")];
    const { rows } = historyGraph(commits, refs);
    const [b1, a2, a1, m] = rows.map((r) => r.segment);
    expect(a2).toBe(a1);
    expect(b1).not.toBe(a2);
    expect(m).toBe(TRUNK_SEGMENT);
    expect(rows[0]!.color).not.toBe(rows[1]!.color);
  });

  it("keeps a branch and its copy on the remote in one segment", () => {
    const commits = [c("f2", "f1"), c("f1", "m"), c("m")];
    const refs = [branch("feature", "f2"), remote("origin/feature", "f1"), branch("main", "m")];
    const [f2, f1] = historyGraph(commits, refs).rows;
    expect(f2!.segment).toBe(f1!.segment);
  });

  it("finds the segment under a click: a commit, or a line passing by", () => {
    const commits = [c("x", "m"), c("y", "m"), c("m")];
    const { rows } = historyGraph(commits, [
      branch("main", "m"),
      branch("x", "x"),
      branch("y", "y"),
    ]);
    // Row y: its own commit on lane 2, x's line passing on lane 1.
    expect(segmentAt(rows[1]!, 2)).toBe(rows[1]!.segment);
    expect(segmentAt(rows[1]!, 1)).toBe(rows[0]!.segment);
    expect(segmentAt(rows[1]!, 5)).toBeNull();
  });

  it("collects short branch names per commit, without tags", () => {
    const names = branchNames([
      branch("main", "a"),
      remote("origin/main", "a"),
      remote("origin/HEAD", "a"),
      { name: "v1", kind: "tag", oid: "a" },
      remote("origin/feature/x", "b"),
    ]);
    expect(names.get("a")).toEqual(["main"]);
    expect(names.get("b")).toEqual(["feature/x"]);
  });
});

describe("merged side branches", () => {
  // main: m3 merges s (s2, s1, both unnamed) into m2; m1 is the fork point.
  const commits = [c("m3", "m2", "s2"), c("s2", "s1"), c("m2", "m1"), c("s1", "m1"), c("m1")];
  const refs = [branch("main", "m3")];

  it("marks the commits of an unnamed merged branch with their merge", () => {
    const { rows, folds } = historyGraph(commits, refs);
    expect(rows.map((r) => r.mergedBy)).toEqual([null, "m3", null, "m3", null]);
    expect(folds.get("m3")).toEqual({ count: 2, expanded: false });
  });

  it("collapses them into the merge, and shows them again when expanded", () => {
    const collapsed = historyGraph(commits, refs, true);
    expect(collapsed.commits.map((x) => x.oid)).toEqual(["m3", "m2", "m1"]);
    expect(lanesOf(collapsed.rows)).toEqual([0, 0, 0]);
    expect(collapsed.rows[0]!.isMerge).toBe(true);
    // The merge no longer draws a line to the hidden side branch.
    expect(collapsed.rows[0]!.lines.filter((l) => l.part === "bottom")).toHaveLength(1);

    const open = historyGraph(commits, refs, true, new Set(["m3"]));
    expect(open.commits).toHaveLength(5);
    expect(open.folds.get("m3")).toEqual({ count: 2, expanded: true });
  });

  it("keeps a merged branch that still has a name", () => {
    const named = [...refs, branch("feature/s", "s2")];
    const { rows, commits: shown, folds } = historyGraph(commits, named, true);
    expect(rows.map((r) => r.mergedBy)).toEqual([null, null, null, null, null]);
    expect(shown).toHaveLength(5);
    expect(folds.size).toBe(0);
  });

  it("collapses nested side branches with the outer merge", () => {
    // s2 itself merged an unnamed branch t1 before s was merged into main.
    const nested = [
      c("m3", "m2", "s2"),
      c("s2", "s1", "t1"),
      c("t1", "s1"),
      c("m2", "m1"),
      c("s1", "m1"),
      c("m1"),
    ];
    const { folds, commits: shown } = historyGraph(nested, refs, true);
    expect(folds.get("m3")!.count).toBe(3);
    expect(folds.get("s2")!.count).toBe(1);
    expect(shown.map((x) => x.oid)).toEqual(["m3", "m2", "m1"]);
    const outer = historyGraph(nested, refs, true, new Set(["m3"]));
    expect(outer.commits.map((x) => x.oid)).toEqual(["m3", "s2", "m2", "s1", "m1"]);
  });
});

describe("layoutGraph on random histories", () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  }

  /** Random DAG, returned newest first (a valid children-before-parents order). */
  function randomHistory(rand: () => number, size: number): GraphCommit[] {
    const created: GraphCommit[] = [];
    for (let i = 0; i < size; i++) {
      const pick = () => created[Math.floor(rand() * created.length)]!.oid;
      let parents: string[] = [];
      if (created.length > 0 && rand() > 0.03) {
        // Prefer recent commits, like real branches.
        const recent = created[Math.max(0, created.length - 1 - Math.floor(rand() * 6))]!.oid;
        parents = [recent];
        if (rand() < 0.15) parents.push(pick());
        if (rand() < 0.02) parents.push(pick());
        parents = [...new Set(parents)];
      }
      created.push({ oid: `c${i}`, parents });
    }
    return created.reverse();
  }

  /** Lines leaving one row enter the next, lines from above end at the node, none run off. */
  function expectContinuous(rows: GraphRow[]) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      for (const l of row.lines) if (l.part === "top") expect(l.to).toBe(row.lane);
      const leaving = new Set(row.lines.filter((l) => l.part !== "top").map((l) => l.to));
      const next = rows[r + 1];
      const entering = new Set(
        next ? next.lines.filter((l) => l.part !== "bottom").map((l) => l.from) : [],
      );
      expect([...entering].sort()).toEqual([...leaving].sort());
    }
  }

  it("stays continuous with a default branch, names and collapsed side branches", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const commits = randomHistory(rand, 5 + Math.floor(rand() * 60));
      const pick = () => commits[Math.floor(rand() * commits.length)]!.oid;
      const refs: RefLike[] = [branch("main", pick())];
      for (let i = 0; i < 4; i++) {
        if (rand() < 0.5) refs.push(branch(`b${i}`, pick()));
        if (rand() < 0.3) refs.push(remote(`origin/b${i}`, pick()));
      }
      const all = historyGraph(commits, refs);
      expectContinuous(all.rows);
      const expanded = new Set([...all.folds.keys()].filter(() => rand() < 0.3));
      const folded = historyGraph(commits, refs, true, expanded);
      expectContinuous(folded.rows);
      expect(folded.commits.length).toBeLessThanOrEqual(commits.length);
    }
  });

  it("keeps every line continuous and closes all lanes", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const commits = randomHistory(rand, 5 + Math.floor(rand() * 60));
      // Lay out in random page sizes to exercise the incremental state too.
      let state;
      const rows = [];
      for (let i = 0; i < commits.length;) {
        const n = 1 + Math.floor(rand() * 7);
        const out = layoutGraph(commits.slice(i, i + n), state);
        rows.push(...out.rows);
        state = out.state;
        i += n;
      }
      expect(state!.lanes.every((l) => l === null)).toBe(true);

      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        // Every line entering from above ends at this row's node.
        for (const l of row.lines) if (l.part === "top") expect(l.to).toBe(row.lane);
        if (r + 1 < rows.length) {
          const leaving = new Set(row.lines.filter((l) => l.part !== "top").map((l) => l.to));
          const next = rows[r + 1]!;
          const entering = new Set(
            next.lines.filter((l) => l.part !== "bottom").map((l) => l.from),
          );
          expect([...entering].sort()).toEqual([...leaving].sort());
        }
      }
    }
  });
});
