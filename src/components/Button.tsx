import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Spinner } from "./Spinner";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  /** Keyboard shortcut hint rendered after the label. */
  shortcut?: string;
}

/** "⌘O" / "Ctrl+O" / "Ctrl+↵" to the aria-keyshortcuts format ("Meta+O", "Control+Enter"). */
export function toAriaShortcut(label: string): string {
  return label
    .replace("⌘", "Meta+")
    .replace("⇧", "Shift+")
    .replace("Ctrl+", "Control+")
    .replace("↵", "Enter")
    .replace(/\+\+/g, "+");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    loading,
    shortcut,
    children,
    className,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={["bl-button", `bl-button--${variant}`, `bl-button--${size}`, className]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-keyshortcuts={shortcut ? toAriaShortcut(shortcut) : undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children && <span className="bl-button__label">{children}</span>}
      {/* The hint is visual; the shortcut is announced through aria-keyshortcuts. */}
      {shortcut && (
        <kbd className="bl-button__kbd" aria-hidden>
          {shortcut}
        </kbd>
      )}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as tooltip. */
  label: string;
  icon: ReactNode;
  size?: ButtonSize;
  tooltipSide?: "top" | "bottom";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", tooltipSide = "bottom", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
      className={["bl-icon-button", `bl-icon-button--${size}`, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {icon}
    </button>
  );
});
