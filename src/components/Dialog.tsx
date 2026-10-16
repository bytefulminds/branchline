import { useEffect, useId, useRef, type ReactNode } from "react";
import "./ConfirmDialog.css";

/**
 * Modal dialog shell: focus is trapped inside, Escape and backdrop clicks
 * cancel, and focus returns to where it was when the dialog closes.
 */
export function Dialog({
  title,
  description,
  children,
  actions,
  onCancel,
  onSubmit,
  role = "dialog",
  size = "default",
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onCancel: () => void;
  onSubmit?: () => void;
  role?: "dialog" | "alertdialog";
  /** `wide` for dialogs with lists, such as the interactive rebase plan. */
  size?: "default" | "wide";
}) {
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea, button");
    first?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab") {
      const focusables = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "input:not(:disabled), select:not(:disabled), textarea, button:not(:disabled)",
        ) ?? [],
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="bl-dialog-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <form
        ref={ref}
        className={`bl-dialog${size === "wide" ? " bl-dialog--wide" : ""}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        <div className="bl-dialog__body">
          <div className="bl-dialog__text">
            <h2 id={titleId} className="text-h3">
              {title}
            </h2>
            {description && (
              <div id={descId} className="bl-dialog__description">
                {description}
              </div>
            )}
            {children}
          </div>
        </div>
        <div className="bl-dialog__actions">{actions}</div>
      </form>
    </div>
  );
}
