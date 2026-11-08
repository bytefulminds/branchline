import type { FileDiff } from "../../types/git";
import type { LineRef, Question, QuestPlan, Reply } from "../../types/quest";
import type { LineSelection } from "../changes/diffModel";

/** Points are for thought and findings, never for speed. */
export const POINTS = {
  /** Every question answered. */
  answer: 10,
  /** A quiz question right the first time. */
  firstTry: 5,
  /** An open answer with some substance (at least `THOUGHTFUL` characters). */
  thoughtful: 5,
  /** A draft comment written. */
  comment: 15,
  /** Every file finished. */
  round: 5,
} as const;
export const THOUGHTFUL = 40;

export interface AnswerState {
  /** Quiz: the choice made; find the line: the line clicked; open: the text sent. */
  choice?: number;
  line?: LineRef;
  text?: string;
  reply?: Reply;
  correct?: boolean;
  /** Skipped without an answer (no points). */
  skipped?: boolean;
}

export interface RoundState {
  questions: Question[] | null;
  answers: AnswerState[];
  done: boolean;
  skipped: boolean;
}

export interface DraftComment {
  id: string;
  path: string;
  line: LineRef | null;
  body: string;
}

/** Everything a quest remembers, saved per merge request (or branch). */
export interface QuestState {
  /** The commit the quest is about; a quest on an older head starts again. */
  head: string;
  /** Index into the plan's rounds; equal to its length for the summary. */
  current: number;
  rounds: Record<string, RoundState>;
  comments: DraftComment[];
  points: number;
}

export function emptyQuest(head: string): QuestState {
  return { head, current: 0, rounds: {}, comments: [], points: 0 };
}

const key = (storageKey: string) => `branchline.quest.${storageKey}`;

export function loadQuest(storageKey: string, head: string): QuestState {
  try {
    const raw = window.localStorage.getItem(key(storageKey));
    const saved = raw ? (JSON.parse(raw) as QuestState) : null;
    if (saved && saved.head === head && typeof saved.points === "number") return saved;
  } catch {
    // A broken or missing save starts a new quest.
  }
  return emptyQuest(head);
}

export function saveQuest(storageKey: string, state: QuestState): void {
  try {
    window.localStorage.setItem(key(storageKey), JSON.stringify(state));
  } catch {
    // Saving is a convenience; the quest goes on without it.
  }
}

export function sameLine(a: LineRef | null | undefined, b: LineRef | null | undefined): boolean {
  return !!a && !!b && a.side === b.side && a.line === b.line;
}

/** The diff line (hunk, index) a click landed on, as a reference the AI uses. */
export function lineRefAt(diff: FileDiff, hunk: number, index: number): LineRef | null {
  const l = diff.hunks[hunk]?.lines[index];
  if (!l) return null;
  if (l.kind === "delete") return l.oldLine === null ? null : { side: "old", line: l.oldLine };
  return l.newLine === null ? null : { side: "new", line: l.newLine };
}

/** Highlight these references in the diff. */
export function selectionFor(diff: FileDiff | null, refs: LineRef[]): LineSelection {
  const out = new Map<number, Set<number>>();
  if (!diff || refs.length === 0) return out;
  diff.hunks.forEach((h, hi) =>
    h.lines.forEach((_, li) => {
      if (refs.some((r) => sameLine(r, lineRefAt(diff, hi, li)))) {
        if (!out.has(hi)) out.set(hi, new Set());
        out.get(hi)!.add(li);
      }
    }),
  );
  return out;
}

/** Points earned by one answer. */
export function pointsFor(question: Question, answer: AnswerState): number {
  if (answer.skipped) return 0;
  let p = POINTS.answer;
  if (question.kind === "open") {
    if ((answer.text ?? "").trim().length >= THOUGHTFUL) p += POINTS.thoughtful;
  } else if (answer.correct) p += POINTS.firstTry;
  return p;
}

/** Share of the changed lines of the quest's files that were part of a finished round. */
export function coverage(plan: QuestPlan, state: QuestState): number {
  const lines = (path: string) => {
    const f = plan.rounds.find((r) => r.path === path);
    return f ? f.additions + f.deletions : 0;
  };
  const total = plan.rounds.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (total === 0) return 0;
  const done = Object.entries(state.rounds)
    .filter(([, r]) => r.done && !r.skipped)
    .reduce((n, [path]) => n + lines(path), 0);
  return Math.round((done / total) * 100);
}

export interface QuestStats {
  answered: number;
  firstTry: number;
  quiz: number;
  filesDone: number;
  filesSkipped: number;
}

export function stats(state: QuestState): QuestStats {
  const s: QuestStats = { answered: 0, firstTry: 0, quiz: 0, filesDone: 0, filesSkipped: 0 };
  for (const r of Object.values(state.rounds)) {
    if (r.done && !r.skipped) s.filesDone++;
    if (r.skipped) s.filesSkipped++;
    r.questions?.forEach((q, i) => {
      const a = r.answers[i];
      if (!a || a.skipped) return;
      if (a.choice !== undefined || a.line || a.text) s.answered++;
      if (q.kind !== "open" && a.correct !== undefined) {
        s.quiz++;
        if (a.correct) s.firstTry++;
      }
    });
  }
  return s;
}

/** Whether a question has been answered (or skipped). */
export function isAnswered(a: AnswerState | undefined): boolean {
  return !!a && (a.skipped || a.choice !== undefined || !!a.line || a.text !== undefined);
}

/** "Line 17" or "Removed line 20", for comments and explanations. */
export function lineLabel(ref: LineRef | null): string {
  if (!ref) return "File";
  return ref.side === "old" ? `Removed line ${ref.line}` : `Line ${ref.line}`;
}

/** Draft comments as text, for copying them to GitLab until Branchline posts them itself. */
export function commentsText(comments: DraftComment[]): string {
  return comments
    .map((c) => `${c.path} (${lineLabel(c.line).toLowerCase()}):\n${c.body.trim()}`)
    .join("\n\n");
}
