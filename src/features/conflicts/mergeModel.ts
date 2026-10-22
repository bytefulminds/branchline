import type { ChangeSide, MergeSegment } from "../../types/git";

/**
 * State of the merge editor (three panes: ours, result, theirs).
 *
 * The file is a list of blocks: text that is the same on every side, and
 * changes. Each change has a result (the lines that end up in the file) and,
 * per side that changed it, whether that side's change was applied, ignored or
 * is still pending. Like JetBrains' merge tool: applying one side replaces the
 * base text; applying the other side too appends its lines after it.
 *
 * Lines keep their line endings so the result is written back exactly.
 */
export type SideState = "pending" | "applied" | "ignored";
export type Side = "ours" | "theirs";

export interface Chunk {
  id: number;
  change: ChangeSide;
  base: string[];
  ours: string[];
  theirs: string[];
  /** Absent for a side that did not change this part. */
  oursState?: SideState;
  theirsState?: SideState;
  result: string[];
  /** Typed in by hand; the side buttons no longer apply. */
  edited: boolean;
}

export type Block = { kind: "same"; lines: string[] } | { kind: "change"; chunk: Chunk };

export interface MergeState {
  blocks: Block[];
  /** Line ending used for typed text. */
  eol: "\n" | "\r\n";
}

export function sidesOf(change: ChangeSide): Side[] {
  if (change === "ours") return ["ours"];
  if (change === "theirs") return ["theirs"];
  return ["ours", "theirs"];
}

function initialChunk(id: number, seg: Extract<MergeSegment, { kind: "change" }>): Chunk {
  const sides = sidesOf(seg.change);
  return {
    id,
    change: seg.change,
    base: seg.base,
    ours: seg.ours,
    theirs: seg.theirs,
    oursState: sides.includes("ours") ? "pending" : undefined,
    theirsState: sides.includes("theirs") ? "pending" : undefined,
    result: seg.base,
    edited: false,
  };
}

/** Use CRLF for typed text when most lines of the file use it. */
export function detectEol(segments: MergeSegment[]): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (const s of segments) {
    for (const line of s.kind === "same" ? s.lines : [...s.ours, ...s.theirs]) {
      if (line.endsWith("\r\n")) crlf++;
      else if (line.endsWith("\n")) lf++;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function initialState(segments: MergeSegment[]): MergeState {
  let id = 0;
  return {
    eol: detectEol(segments),
    blocks: segments.map((s) =>
      s.kind === "same"
        ? { kind: "same", lines: s.lines }
        : { kind: "change", chunk: initialChunk(id++, s) },
    ),
  };
}

function mapChunk(state: MergeState, id: number, fn: (c: Chunk) => Chunk): MergeState {
  return {
    ...state,
    blocks: state.blocks.map((b) =>
      b.kind === "change" && b.chunk.id === id ? { kind: "change", chunk: fn(b.chunk) } : b,
    ),
  };
}

const stateKey = (side: Side) => (side === "ours" ? "oursState" : "theirsState");

/** Take one side's lines into the result. */
export function applyChunk(c: Chunk, side: Side): Chunk {
  if (c.edited || c[stateKey(side)] !== "pending") return c;
  if (c.change === "both") {
    // The same change on both sides: applying it once handles both.
    return { ...c, oursState: "applied", theirsState: "applied", result: c.ours };
  }
  const other = side === "ours" ? "theirs" : "ours";
  const otherApplied = c[stateKey(other)] === "applied";
  return {
    ...c,
    [stateKey(side)]: "applied",
    result: otherApplied ? [...c.result, ...c[side]] : c[side],
  };
}

/** Leave one side's change out. */
export function ignoreChunk(c: Chunk, side: Side): Chunk {
  if (c.edited || c[stateKey(side)] !== "pending") return c;
  if (c.change === "both") return { ...c, oursState: "ignored", theirsState: "ignored" };
  return { ...c, [stateKey(side)]: "ignored" };
}

export function isResolved(c: Chunk): boolean {
  return c.edited || (c.oursState !== "pending" && c.theirsState !== "pending");
}

/** Lines typed into a change's result box. */
export function linesFromText(text: string, eol: string, finalNewline: boolean): string[] {
  if (text === "") return [];
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  return parts.map((p, i) => (i < parts.length - 1 || finalNewline ? p + eol : p));
}

/** Text shown for lines (line endings removed). */
export function textOf(lines: string[]): string {
  return lines.map(stripEol).join("\n");
}

export function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

export type MergeAction =
  | { type: "apply"; id: number; side: Side }
  | { type: "ignore"; id: number; side: Side }
  | { type: "edit"; id: number; text: string }
  | { type: "reset"; id: number }
  | { type: "applyNonConflicting" }
  | { type: "applyAll"; side: Side };

export function reduce(state: MergeState, action: MergeAction): MergeState {
  switch (action.type) {
    case "apply":
      return mapChunk(state, action.id, (c) => applyChunk(c, action.side));
    case "ignore":
      return mapChunk(state, action.id, (c) => ignoreChunk(c, action.side));
    case "edit": {
      const last = state.blocks[state.blocks.length - 1];
      return mapChunk(state, action.id, (c) => {
        // Keep a missing final newline at the end of the file.
        const atEnd = last?.kind === "change" && last.chunk.id === c.id;
        const prev = c.result.length ? c.result : c.base.length ? c.base : c.ours;
        const finalNewline = !(atEnd && prev.length > 0 && !/\n$/.test(prev[prev.length - 1]!));
        return {
          ...c,
          edited: true,
          result: linesFromText(action.text, state.eol, finalNewline),
        };
      });
    }
    case "reset":
      return mapChunk(state, action.id, (c) =>
        initialChunk(c.id, {
          kind: "change",
          change: c.change,
          base: c.base,
          ours: c.ours,
          theirs: c.theirs,
        }),
      );
    case "applyNonConflicting":
      return {
        ...state,
        blocks: state.blocks.map((b) =>
          b.kind === "change" && b.chunk.change !== "conflict"
            ? { kind: "change", chunk: applyChunk(applyChunk(b.chunk, "ours"), "theirs") }
            : b,
        ),
      };
    case "applyAll":
      return {
        ...state,
        blocks: state.blocks.map((b) => {
          if (b.kind !== "change") return b;
          const other = action.side === "ours" ? "theirs" : "ours";
          return {
            kind: "change",
            chunk: ignoreChunk(applyChunk(b.chunk, action.side), other),
          };
        }),
      };
  }
}

/** The merged file. */
export function resultText(state: MergeState): string {
  return state.blocks.map((b) => (b.kind === "same" ? b.lines : b.chunk.result).join("")).join("");
}

export interface MergeCounts {
  conflicts: number;
  /** Non-conflicting changes not applied or ignored yet. */
  changes: number;
}

export function remaining(state: MergeState): MergeCounts {
  let conflicts = 0;
  let changes = 0;
  for (const b of state.blocks) {
    if (b.kind !== "change" || isResolved(b.chunk)) continue;
    if (b.chunk.change === "conflict") conflicts++;
    else changes++;
  }
  return { conflicts, changes };
}

const MARKER = /^(<{7}|>{7}|={7})( |\r?\n|$)/;

/** Whether the text still contains conflict markers. */
export function hasMarkers(text: string): boolean {
  return text.split("\n").some((l) => MARKER.test(l));
}
