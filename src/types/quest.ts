/** Mirrors `src-tauri/src/ai/review.rs`. */
export interface QuestFile {
  path: string;
  originalPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Why the file has no round. */
  skipped: string | null;
}

export interface QuestPlan {
  rounds: QuestFile[];
  skipped: QuestFile[];
  totalLines: number;
}

export interface LineRef {
  side: "old" | "new";
  line: number;
}

export type QuestionKind = "choice" | "trueFalse" | "findLine" | "open";

export interface Question {
  kind: QuestionKind;
  prompt: string;
  choices: string[];
  answer: number | null;
  lines: LineRef[];
  explanation: string;
}

export interface Round {
  path: string;
  questions: Question[];
}

export interface QuestContext {
  base: string;
  head: string;
  path: string;
  originalPath: string | null;
  title: string;
  description: string;
  discussion: string;
  ownBranch: boolean;
}

export interface Reply {
  reply: string;
  comment: string | null;
  line: LineRef | null;
}
