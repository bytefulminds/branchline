import { createContext, useContext } from "react";

/** What a review quest is about. */
export interface QuestSpec {
  repoPath: string;
  base: string;
  head: string;
  /** Merge request title, or the branch for a self-review. */
  title: string;
  description: string;
  /** Reviewing your own branch: findings are notes for yourself. */
  ownBranch: boolean;
  /** Where the quest's progress is saved ("gitlab:acme/lumen!42", "self:/repo:feature/x"). */
  storageKey: string;
  /** Earlier comments per file path, so the AI does not ask about them again. */
  discussion?: Record<string, string>;
  /** The label of the way back ("Merge request", "Changes"). */
  backLabel: string;
}

export interface QuestActions {
  /** The running quest, or null. */
  spec: QuestSpec | null;
  start: (spec: QuestSpec) => void;
  stop: () => void;
}

const QuestContext = createContext<QuestActions>({
  spec: null,
  start: () => {},
  stop: () => {},
});

export const QuestProvider = QuestContext.Provider;
export const useQuest = () => useContext(QuestContext);
