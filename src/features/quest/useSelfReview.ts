import { useCallback } from "react";
import { useToast } from "../../components/Toast";
import { gitService } from "../../services/git";
import type { GitError, RepositoryInfo } from "../../types/git";
import { useSettings } from "../settings/SettingsProvider";
import { useQuest } from "./QuestProvider";

/**
 * Start a review quest on the current branch's own commits (where it was created or forked,
 * up to HEAD). Null while AI is off, so callers show nothing.
 */
export function useSelfReview(repo: RepositoryInfo | null): (() => void) | null {
  const { settings } = useSettings();
  const quest = useQuest();
  const toast = useToast();
  const start = useCallback(async () => {
    if (!repo || repo.head.kind !== "branch") return;
    const branch = repo.head.name;
    try {
      const info = await gitService.rewriteBase(repo.path);
      quest.start({
        repoPath: repo.path,
        base: info.base,
        head: repo.head.oid,
        title: branch,
        description: `The ${info.commits === 1 ? "commit" : `${info.commits} commits`} of ${branch}${
          info.from ? `, which started from ${info.from}` : ""
        }.`,
        ownBranch: true,
        storageKey: `self:${repo.path}:${branch}`,
        backLabel: "Back",
      });
    } catch (e) {
      toast({
        tone: "error",
        title: "Could not review this branch",
        description: (e as GitError).message,
      });
    }
  }, [repo, quest, toast]);
  const run = useCallback(() => void start(), [start]);
  return settings.ai.enabled && repo?.head.kind === "branch" ? run : null;
}
