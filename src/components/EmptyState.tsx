import type { ReactNode } from "react";
import "./EmptyState.css";

export function EmptyState({
  icon,
  title,
  description,
  tone = "neutral",
  children,
  role,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  tone?: "neutral" | "accent" | "error" | "success";
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div className={`bl-empty bl-empty--${tone}`} role={role}>
      {icon && <div className="bl-empty__icon">{icon}</div>}
      <h2 className="text-h2">{title}</h2>
      {description && <div className="bl-empty__description">{description}</div>}
      {children && <div className="bl-empty__actions">{children}</div>}
    </div>
  );
}
