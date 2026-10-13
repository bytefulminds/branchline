import { STATUS_META, type StatusCode } from "../features/changes/changeModel";
import "./StatusLetter.css";

/** Git status code with color, letter and an accessible label. */
export function StatusLetter({ status }: { status: StatusCode }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="bl-status-letter"
      style={{ color: `var(${meta.colorVar})` }}
      role="img"
      aria-label={meta.label}
      title={meta.label}
    >
      {meta.letter}
    </span>
  );
}
