import { createContext, useContext } from "react";

/** Opens History filtered to one file or folder. */
const FileHistoryContext = createContext<((path: string) => void) | null>(null);

export const FileHistoryProvider = FileHistoryContext.Provider;

/** `null` outside a repository (the button is then not shown). */
export function useShowFileHistory(): ((path: string) => void) | null {
  return useContext(FileHistoryContext);
}
