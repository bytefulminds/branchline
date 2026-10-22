import { useCallback } from "react";
import { useToast } from "../../components/Toast";
import { platform } from "../../services/platform";
import { settingsService } from "../../services/settings";
import type { GitError } from "../../types/git";

/** Name of the system file manager, for menu labels. */
export const FILE_MANAGER =
  platform === "macos" ? "Finder" : platform === "windows" ? "Explorer" : "file manager";

/** Open files or the repository in the editor, a terminal or the file manager. */
export function useOpenIn() {
  const toast = useToast();
  const report = useCallback(
    (title: string) => (e: GitError) => toast({ tone: "error", title, description: e.message }),
    [toast],
  );
  return {
    editor: useCallback(
      (repo: string, path: string | null) =>
        void settingsService.openInEditor(repo, path).catch(report("Could not open the editor")),
      [report],
    ),
    terminal: useCallback(
      (repo: string) =>
        void settingsService.openTerminal(repo).catch(report("Could not open a terminal")),
      [report],
    ),
    reveal: useCallback(
      (repo: string, path: string | null) =>
        void settingsService
          .revealInFileManager(repo, path)
          .catch(report(`Could not open the ${FILE_MANAGER}`)),
      [report],
    ),
  };
}
