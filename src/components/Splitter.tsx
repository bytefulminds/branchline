import { useRef } from "react";
import "./Splitter.css";

export interface SplitterProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /**
   * Which panel the value belongs to. `left` / `above`: the panel before the splitter grows
   * when dragging right or down. `right` / `below`: the panel after it grows when dragging
   * left or up. `above` and `below` make a horizontal splitter (dragged up and down).
   */
  side: "left" | "right" | "above" | "below";
  /** Double-click (or Enter) puts the panel back to its default size. */
  onReset?: () => void;
}

/** Keyboard- and pointer-resizable separator (WAI-ARIA window splitter). */
export function Splitter({ label, value, min, max, onChange, side, onReset }: SplitterProps) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  const horizontal = side === "above" || side === "below";
  const before = side === "left" || side === "above";
  const pos = (e: React.PointerEvent) => (horizontal ? e.clientY : e.clientX);
  const growKey = horizontal
    ? before
      ? "ArrowDown"
      : "ArrowUp"
    : before
      ? "ArrowRight"
      : "ArrowLeft";
  const shrinkKey = horizontal
    ? before
      ? "ArrowUp"
      : "ArrowDown"
    : before
      ? "ArrowLeft"
      : "ArrowRight";

  return (
    <div
      role="separator"
      // A vertical separator sits between columns; a horizontal one between rows.
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`bl-splitter${horizontal ? " bl-splitter--horizontal" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: pos(e), value };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = pos(e) - start.current.pos;
        onChange(clamp(start.current.value + (before ? delta : -delta)));
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === growKey) onChange(clamp(value + step));
        else if (e.key === shrinkKey) onChange(clamp(value - step));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else if (e.key === "Enter" && onReset) onReset();
        else return;
        e.preventDefault();
      }}
    />
  );
}
