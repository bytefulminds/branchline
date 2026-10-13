import type { ReactNode } from "react";
import "./Badge.css";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "error" | "info";

export function Badge({
  tone = "neutral",
  icon,
  mono,
  children,
  title,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  mono?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`bl-badge bl-badge--${tone}${mono ? " bl-badge--mono" : ""}`} title={title}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Small numeric count used in navigation and section headers. */
export function Count({ value, tone = "neutral" }: { value: number; tone?: BadgeTone }) {
  return <span className={`bl-count bl-count--${tone}`}>{value.toLocaleString()}</span>;
}
