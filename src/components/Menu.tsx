import { Check, ChevronRight } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
      /** With `checked`: an on/off choice (a checkbox) instead of one of several. */
      toggle?: boolean;
      disabled?: boolean;
      /** Destructive action (shown in the error color). */
      danger?: boolean;
      onSelect: () => void;
    }
  | { type: "separator"; id: string }
  | { type: "header"; id: string; label: string }
  | {
      /** An item that opens a menu of its own beside it. */
      type: "submenu";
      id: string;
      label: string;
      description?: string;
      icon?: ReactNode;
      disabled?: boolean;
      danger?: boolean;
      entries: MenuEntry[];
    };

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
      const inSub = (t as Element).closest?.(".bl-menu--sub");
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t) && !inSub) close(false);
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
  // Only this menu's own items, not those of a submenu opened inside it.
  return Array.from(
    menu?.querySelectorAll<HTMLButtonElement>(
      ':scope > [role="menuitem"]:not(:disabled), :scope > [role="menuitemradio"]:not(:disabled), :scope > [role="menuitemcheckbox"]:not(:disabled), :scope > .bl-submenu > [role="menuitem"]:not(:disabled)',
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

/** An item that opens its own menu beside it: on hover, click, Enter, Space or Right. */
function SubmenuItem({
  entry,
  onClose,
}: {
  entry: Extract<MenuEntry, { type: "submenu" }>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const show = (focusFirst: boolean) => {
    if (entry.disabled) return;
    const r = itemRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.right + 2, top: r.top - 4 });
    setOpen(true);
    if (focusFirst) window.setTimeout(() => menuItems(menuRef.current)[0]?.focus(), 0);
  };
  const hide = (refocus: boolean) => {
    window.clearTimeout(leaveTimer.current);
    setOpen(false);
    if (refocus) itemRef.current?.focus();
  };
  // Leaving closes after a moment, so the pointer can cross the gap into the submenu.
  const leaveTimer = useRef<number | undefined>(undefined);
  const stay = () => window.clearTimeout(leaveTimer.current);
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setOpen(false), 250);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // Keep the submenu inside the window: flip it to the left of the item when needed.
  useLayoutEffect(() => {
    const el = menuRef.current;
    const item = itemRef.current;
    if (!open || !el || !item || !pos) return;
    const m = el.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    const left =
      pos.left + m.width > window.innerWidth - 4 ? Math.max(4, r.left - m.width - 2) : pos.left;
    const top = Math.max(4, Math.min(pos.top, window.innerHeight - m.height - 4));
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [open, pos]);

  return (
    <div className="bl-submenu" onMouseEnter={stay} onMouseLeave={leave}>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={entry.disabled}
        className={`bl-menu__item${entry.danger ? " bl-menu__item--danger" : ""}`}
        onMouseEnter={() => {
          stay();
          show(false);
        }}
        onClick={() => show(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            show(true);
          }
        }}
      >
        <span className="bl-menu__icon">{entry.icon}</span>
        <span className="bl-menu__text">
          <span className="truncate">{entry.label}</span>
          {entry.description && (
            <span className="bl-menu__description truncate">{entry.description}</span>
          )}
        </span>
        <ChevronRight size={14} aria-hidden className="bl-submenu__chevron" />
      </button>
      {open &&
        pos &&
        // Rendered at the end of the page, so the parent menu can neither contain nor clip it.
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={entry.label}
            className="bl-menu bl-menu--sub"
            style={{ left: pos.left, top: pos.top, minWidth: 200 }}
            onMouseEnter={stay}
            onMouseLeave={leave}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                hide(true);
                return;
              }
              handleMenuKeys(e, menuRef.current, (refocus) => hide(refocus ?? true));
            }}
          >
            <MenuItems entries={entry.entries} onClose={onClose} />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function MenuItems({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) {
  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "submenu")
          return <SubmenuItem key={entry.id} entry={entry} onClose={onClose} />;
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
            role={
              entry.checked === undefined
                ? "menuitem"
                : entry.toggle
                  ? "menuitemcheckbox"
                  : "menuitemradio"
            }
            aria-checked={entry.checked}
            disabled={entry.disabled}
            className={`bl-menu__item${entry.danger ? " bl-menu__item--danger" : ""}`}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="bl-menu__icon">
              {entry.toggle && entry.checked ? <Check size={16} aria-hidden /> : entry.icon}
            </span>
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
