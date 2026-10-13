import { useCallback, useLayoutEffect, useState } from "react";

/** Height assumed before the container is measured (and in test environments). */
const FALLBACK_VIEWPORT = 800;

export interface VirtualWindow {
  start: number;
  end: number;
  totalHeight: number;
  onScroll: (e: React.UIEvent<HTMLElement>) => void;
  /** Scroll so row `index` is fully visible. */
  scrollToRow: (index: number) => void;
}

/** Track an element's client size. Pass the returned setter as a callback `ref`. */
export function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () =>
      setSize((s) =>
        s.width === element.clientWidth && s.height === element.clientHeight
          ? s
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(element);
    return () => ro.disconnect();
  }, [element]);
  return size;
}

/**
 * Fixed-height row virtualization: only rows in (and slightly around) the
 * viewport are rendered, so lists and diffs with tens of thousands of rows
 * stay responsive. `element` is the scroll container (use a callback ref).
 */
export function useVirtualRows(
  element: HTMLElement | null,
  count: number,
  rowHeight: number,
  overscan = 10,
): VirtualWindow {
  const [rawScrollTop, setScrollTop] = useState(0);
  const measured = useElementSize(element).height;
  const height = measured || FALLBACK_VIEWPORT;
  // Clamp when content shrinks below the current scroll position.
  const scrollTop = Math.min(rawScrollTop, Math.max(0, count * rowHeight - height));

  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const scrollToRow = useCallback(
    (index: number) => {
      if (!element) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      let target: number | null = null;
      if (top < element.scrollTop) target = top;
      else if (bottom > element.scrollTop + element.clientHeight)
        target = bottom - element.clientHeight;
      if (target === null) return;
      element.scrollTo?.({ top: target });
      setScrollTop(target);
    },
    [element, rowHeight],
  );

  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(height / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
    totalHeight: count * rowHeight,
    onScroll,
    scrollToRow,
  };
}
