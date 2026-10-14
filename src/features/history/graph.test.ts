import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphCommit } from "./graph";

const c = (oid: string, ...parents: string[]): GraphCommit => ({ oid, parents });

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, state } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]!.lines).toEqual([{ part: "bottom", from: 0, to: 0, color: 0 }]);
    expect(rows[1]!.lines).toContainEqual({ part: "top", from: 0, to: 0, color: 0 });
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
    expect(rows[1]!.lines).toContainEqual({
      part: "bottom",
      from: 1,
      to: 1,
      color: rows[1]!.color,
    });
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
