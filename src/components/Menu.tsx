import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./Menu.css";

export type MenuEntry =
  | {
      type?: "item";
      id: string;
      label: string;
      description?: string;
      icon?: ReactNode;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      /** Destructive action (shown in the error color). */
      danger?: boolean;
      onSelect: () => void;
    }
  | { type: "separator"; id: string }
  | { type: "header"; id: string; label: string };

export interface MenuProps {
  entries: MenuEntry[];
  /** Renders the trigger; spread `props` onto a button. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
    onClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  }) => ReactNode;
  align?: "start" | "end";
  minWidth?: number;
  emptyLabel?: string;
}

/** Accessible dropdown menu (WAI-ARIA menu button pattern). */
export function Menu({ entries, trigger, align = "start", minWidth = 260, emptyLabel }: MenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = () => menuItems(menuRef.current);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    const onBlur = () => close(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, close]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => handleMenuKeys(e, menuRef.current, close);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="bl-menu-anchor">
      {trigger({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        onClick: () => setOpen((o) => !o),
        onKeyDown: onTriggerKeyDown,
      })}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className={`bl-menu bl-menu--${align}`}
          style={{ minWidth }}
          onKeyDown={onMenuKeyDown}
        >
          {entries.length === 0 && emptyLabel && <div className="bl-menu__empty">{emptyLabel}</div>}
          <MenuItems entries={entries} onClose={() => close()} />
        </div>
      )}
    </div>
  );
}

/** Enabled, focusable items of a menu element (plain and checkable). */
export function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(
    menu?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    ) ?? [],
  );
}

/** Arrow keys, Home/End, Escape and Tab handling shared by all menus. */
export function handleMenuKeys(
  e: React.KeyboardEvent,
  menu: HTMLElement | null,
  close: (refocus?: boolean) => void,
) {
  const list = menuItems(menu);
  const index = list.indexOf(document.activeElement as HTMLButtonElement);
  const focusAt = (i: number) => list[(i + list.length) % list.length]?.focus();
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      focusAt(index + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      focusAt(index - 1);
      break;
    case "Home":
      e.preventDefault();
      focusAt(0);
      break;
    case "End":
      e.preventDefault();
      focusAt(list.length - 1);
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      close();
      break;
    case "Tab":
      close(false);
      break;
  }
}

export function MenuItems({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) {
  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "separator")
          return <div key={entry.id} role="separator" className="bl-menu__separator" />;
        if (entry.type === "header")
          return (
            <div key={entry.id} role="presentation" className="bl-menu__header">
              {entry.label}
            </div>
          );
        return (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            className={`bl-menu__item${entry.danger ? " bl-menu__item--danger" : ""}`}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="bl-menu__icon">{entry.icon}</span>
            <span className="bl-menu__text">
              <span className="truncate">{entry.label}</span>
              {entry.description && (
                <span className="bl-menu__description truncate">{entry.description}</span>
              )}
            </span>
            {entry.shortcut && <kbd className="bl-menu__kbd">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </>
  );
}
