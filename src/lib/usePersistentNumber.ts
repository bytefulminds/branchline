import { useCallback, useEffect, useRef, useState } from "react";
import { readJson, writeJson } from "../services/storage";

/** Number state remembered per device (panel sizes and similar conveniences). */
export function usePersistentNumber(key: string, initial: number): [number, (v: number) => void] {
  const [value, setValue] = useState(() => {
    const stored = readJson<unknown>(key, initial);
    return typeof stored === "number" && Number.isFinite(stored) ? stored : initial;
  });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    // Debounced: dragging a splitter should not write on every pointer move.
    timer.current = window.setTimeout(() => writeJson(key, value), 250);
    return () => window.clearTimeout(timer.current);
  }, [key, value]);
  const set = useCallback((v: number) => setValue(v), []);
  return [value, set];
}
