import { memo } from "react";
import type { GraphRow } from "./graph";

export const LANE_WIDTH = 14;
export const GRAPH_PAD = 10;
const PAD = GRAPH_PAD;

export function laneX(lane: number): number {
  return PAD + lane * LANE_WIDTH;
}

const color = (c: number) => `var(--graph-${c})`;

/** One row of the commit graph, drawn as SVG at a fixed row height. */
export const GraphCell = memo(function GraphCell({
  row,
  height,
  lanes,
  isHead,
  follow = null,
}: {
  row: GraphRow;
  height: number;
  /** Number of lanes to reserve (shared by all rows, so columns line up). */
  lanes: number;
  isHead: boolean;
  /** The followed branch segment: everything else is drawn faded. */
  follow?: number | null;
}) {
  const mid = height / 2;
  const width = PAD * 2 + Math.max(lanes - 1, 0) * LANE_WIDTH;
  const x = laneX;
  const faded = (segment: number) =>
    follow === null ? undefined : segment === follow ? "bl-graph__followed" : "bl-graph__faded";
  const node = faded(row.segment);
  return (
    <svg className="bl-graph" width={width} height={height} aria-hidden focusable="false">
      {row.lines.map((l, i) => {
        let d: string;
        if (l.part === "full") d = `M${x(l.from)} 0V${height}`;
        else if (l.part === "top")
          d =
            l.from === l.to
              ? `M${x(l.from)} 0V${mid}`
              : `M${x(l.from)} 0C${x(l.from)} ${mid * 0.7} ${x(l.to)} ${mid * 0.3} ${x(l.to)} ${mid}`;
        else
          d =
            l.from === l.to
              ? `M${x(l.from)} ${mid}V${height}`
              : `M${x(l.from)} ${mid}C${x(l.from)} ${mid + mid * 0.7} ${x(l.to)} ${height - mid * 0.7} ${x(l.to)} ${height}`;
        return (
          <path
            key={i}
            d={d}
            className={faded(l.segment)}
            stroke={color(l.color)}
            strokeWidth={2}
            fill="none"
          />
        );
      })}
      {isHead && (
        <circle
          className={node}
          cx={x(row.lane)}
          cy={mid}
          r={7.5}
          fill="none"
          stroke={color(row.color)}
          strokeWidth={1.5}
          opacity={0.6}
        />
      )}
      {row.isMerge ? (
        <circle
          className={node}
          cx={x(row.lane)}
          cy={mid}
          r={3.5}
          fill="var(--color-background)"
          stroke={color(row.color)}
          strokeWidth={2}
        />
      ) : (
        <circle
          className={node}
          cx={x(row.lane)}
          cy={mid}
          r={4.5}
          fill={color(row.color)}
          stroke="var(--color-background)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
});
