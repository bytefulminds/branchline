import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { handleMenuKeys, menuItems, MenuItems, type MenuEntry } from "./Menu";
import "./Menu.css";

interface OpenMenu {
  x: number;
  y: number;
  entries: MenuEntry[];
  label: string;
  /** Element to refocus when the menu closes. */
  returnFocus: HTMLElement | null;
}

type ShowContextMenu = (at: { x: number; y: number }, entries: MenuEntry[], label: string) => void;

const ContextMenuContext = createContext<ShowContextMenu>(() => {});

/** Open a context menu at a pointer position (or next to the focused element). */
export function useContextMenu(): ShowContextMenu {
  return useContext(ContextMenuContext);
}

/** Position for keyboard-opened menus (Shift+F10 or the Menu key): below the element. */
export function anchorOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + 24, y: r.bottom };
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const show = useCallback<ShowContextMenu>((at, entries, label) => {
    setMenu({ ...at, entries, label, returnFocus: document.activeElement as HTMLElement | null });
  }, []);
  return (
    <ContextMenuContext.Provider value={show}>
      {children}
      {menu && (
        <ContextMenu
          key={`${menu.x},${menu.y},${menu.label}`}
          menu={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </ContextMenuContext.Provider>
  );
}

function ContextMenu({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  const close = useCallback(
    (refocus = true) => {
      onClose();
      if (refocus) menu.returnFocus?.focus?.();
    },
    [onClose, menu.returnFocus],
  );

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4));
    const top =
      menu.y + r.height > window.innerHeight - 4 ? Math.max(4, menu.y - r.height) : menu.y;
    if (left !== menu.x || top !== menu.y) setPos({ left, top });
  }, [menu.x, menu.y]);

  useEffect(() => {
    menuItems(ref.current)[0]?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    const onBlur = () => close(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [close]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      className="bl-menu bl-menu--context"
      style={{ left: pos.left, top: pos.top, minWidth: 220 }}
      onKeyDown={(e) => handleMenuKeys(e, ref.current, close)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems entries={menu.entries} onClose={() => close()} />
    </div>
  );
}
