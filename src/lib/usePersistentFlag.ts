import { useCallback, useState } from "react";
import { readJson, writeJson } from "../services/storage";

/** Boolean state remembered per device (a collapsed panel, a hidden column). */
export function usePersistentFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = readJson<unknown>(key, initial);
    return typeof stored === "boolean" ? stored : initial;
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      writeJson(key, v);
    },
    [key],
  );
  return [value, set];
}
