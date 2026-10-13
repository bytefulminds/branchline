import { useRef } from "react";
import "./Splitter.css";

export interface SplitterProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** `left`: dragging right grows the panel before the splitter; `right`: grows the panel after it. */
  side: "left" | "right";
}

/** Keyboard- and pointer-resizable vertical separator (WAI-ARIA window splitter). */
export function Splitter({ label, value, min, max, onChange, side }: SplitterProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="bl-splitter"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, value };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = e.clientX - start.current.x;
        onChange(clamp(start.current.value + (side === "left" ? delta : -delta)));
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
        const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow) onChange(clamp(value + step));
        else if (e.key === shrink) onChange(clamp(value - step));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else return;
        e.preventDefault();
      }}
    />
  );
}
