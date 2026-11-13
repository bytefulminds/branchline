import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Flag,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  Trophy,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { useConfirm } from "../../components/ConfirmDialog";
import { Spinner } from "../../components/Spinner";
import { StatusLetter } from "../../components/StatusLetter";
import { splitPath } from "../../lib/format";
import { forgeService } from "../../services/forge";
import { questService } from "../../services/quest";
import type { FileDiff, GitError } from "../../types/git";
import type { LineRef, Question, QuestFile, QuestPlan } from "../../types/quest";
import { DiffBody } from "../changes/DiffView";
import { DiffLayoutToggle } from "../changes/DiffLayoutToggle";
import { diffRows } from "../changes/diffModel";
import { fileStatus } from "../history/CommitDetailsPanel";
import type { QuestSpec } from "./QuestProvider";
import {
  type AnswerState,
  commentsText,
  coverage,
  type DraftComment,
  isAnswered,
  lineLabel,
  lineRefAt,
  emptyQuest,
  loadQuest,
  nextToPrepare,
  POINTS,
  pointsFor,
  type QuestState,
  type RoundState,
  sameLine,
  saveQuest,
  selectionFor,
  stats,
  THOUGHTFUL,
} from "./questModel";
import "../history/HistoryView.css";
import "../reviews/MergeRequestView.css";
import "./QuestView.css";

let nextOpId = 1;
const opId = () => `quest-${nextOpId++}`;

const EMPTY_ROUND: RoundState = { questions: null, answers: [], done: false, skipped: false };

/** What the AI gets to know about one file of the quest. */
const contextFor = (spec: QuestSpec, file: QuestFile) => ({
  base: spec.base,
  head: spec.head,
  path: file.path,
  originalPath: file.originalPath,
  title: spec.title,
  description: spec.description,
  discussion: spec.discussion?.[file.path] ?? "",
  ownBranch: spec.ownBranch,
});

/** Where the questions for the open file are: being asked, failed, or paused by Stop. */
interface Asking {
  asking: boolean;
  error: GitError | null;
  paused: boolean;
}

const KIND_LABEL: Record<Question["kind"], string> = {
  choice: "Quiz",
  trueFalse: "True or false",
  findLine: "Find the line",
  open: "Your take",
};

/** "+15" that floats up when points are earned. */
function Gain({ gain }: { gain: { points: number; id: number } | null }) {
  if (!gain) return null;
  return (
    <span key={gain.id} className="bl-quest__gain" aria-hidden>
      +{gain.points}
    </span>
  );
}

function QuestionCard({
  question,
  answer,
  index,
  count,
  busy,
  ownBranch,
  onChoose,
  onSendOpen,
  onSkip,
  onDraft,
}: {
  question: Question;
  answer: AnswerState | undefined;
  index: number;
  count: number;
  busy: boolean;
  ownBranch: boolean;
  onChoose: (choice: number) => void;
  onSendOpen: (text: string) => void;
  onSkip: () => void;
  onDraft: (body: string, line: LineRef | null) => void;
}) {
  const [text, setText] = useState("");
  const [shown, setShown] = useState(question);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  if (shown !== question) {
    setShown(question);
    setText("");
    setSuggestion(null);
    setAdded(false);
  }
  const answered = isAnswered(answer);
  const textId = useId();
  const reply = answer?.reply;
  const suggestedComment = suggestion ?? reply?.comment ?? "";

  return (
    <section className="bl-quest__card" aria-label={`Question ${index + 1} of ${count}`}>
      <header className="bl-quest__card-head text-small">
        <span className="bl-quest__kind">{KIND_LABEL[question.kind]}</span>
        <span className="text-muted">
          Question {index + 1} of {count}
        </span>
      </header>
      <p className="bl-quest__prompt">{question.prompt}</p>

      {(question.kind === "choice" || question.kind === "trueFalse") && (
        <div className="bl-quest__choices" role="group" aria-label="Answers">
          {question.choices.map((c, i) => {
            const chosen = answer?.choice === i;
            const right = answered && i === question.answer;
            return (
              <button
                key={i}
                type="button"
                className={[
                  "bl-quest__choice",
                  right ? "bl-quest__choice--right" : "",
                  answered && chosen && !right ? "bl-quest__choice--wrong" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={chosen}
                disabled={answered}
                onClick={() => onChoose(i)}
              >
                {right && <CircleCheck size={14} aria-hidden />}
                {answered && chosen && !right && <CircleX size={14} aria-hidden />}
                <span>{c}</span>
              </button>
            );
          })}
        </div>
      )}

      {question.kind === "findLine" && !answered && (
        <p className="bl-quest__hint text-small text-secondary">
          Click the line in the diff below.
        </p>
      )}

      {question.kind === "open" && !answered && (
        <div className="bl-quest__open">
          <label className="visually-hidden" htmlFor={textId}>
            Your answer
          </label>
          <textarea
            id={textId}
            className="bl-input bl-quest__textarea"
            rows={3}
            value={text}
            placeholder="What do you think? There is no wrong answer."
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault();
                onSendOpen(text);
              }
            }}
          />
          <span className="text-small text-muted">
            {text.trim().length >= THOUGHTFUL
              ? `+${POINTS.answer + POINTS.thoughtful} points`
              : `+${POINTS.answer} points, +${POINTS.thoughtful} for an answer with some thought`}
          </span>
        </div>
      )}

      {answer?.skipped && (
        <p className="bl-quest__verdict" role="status">
          Skipped.{question.explanation ? ` ${question.explanation}` : ""}
        </p>
      )}
      {answered && !answer?.skipped && question.kind !== "open" && (
        <p
          className={`bl-quest__verdict ${answer?.correct ? "bl-quest__verdict--right" : ""}`}
          role="status"
        >
          {answer?.correct
            ? `Right, +${POINTS.answer + POINTS.firstTry} points.`
            : `Not quite, +${POINTS.answer} points for looking.`}{" "}
          {question.explanation}
        </p>
      )}
      {answered && question.kind === "open" && answer?.text && (
        <div className="bl-quest__reply" role="status">
          <p className="bl-quest__your-answer text-small text-secondary">You: {answer.text}</p>
          {busy && !reply ? (
            <p className="text-small text-secondary">
              <Spinner size={12} /> The AI is reading your answer…
            </p>
          ) : (
            reply && <p>{reply.reply}</p>
          )}
          {reply?.comment && added && (
            <p className="text-small bl-quest__added">
              <CircleCheck size={14} aria-hidden />{" "}
              {ownBranch ? "Kept as a note." : "Added to your draft comments."}
            </p>
          )}
          {reply?.comment && !added && (
            <div className="bl-quest__suggest">
              <label className="text-small text-secondary" htmlFor={`${textId}-c`}>
                {ownBranch ? "A note for later" : "A comment you could post"} (
                {lineLabel(reply.line).toLowerCase()})
              </label>
              <textarea
                id={`${textId}-c`}
                className="bl-input bl-quest__textarea"
                rows={2}
                value={suggestedComment}
                onChange={(e) => setSuggestion(e.target.value)}
              />
              <Button
                size="sm"
                icon={<MessageSquarePlus size={14} aria-hidden />}
                disabled={!suggestedComment.trim()}
                onClick={() => {
                  onDraft(suggestedComment, reply.line);
                  setAdded(true);
                }}
              >
                {ownBranch
                  ? `Keep as a note (+${POINTS.comment})`
                  : `Add as draft comment (+${POINTS.comment})`}
              </Button>
            </div>
          )}
        </div>
      )}

      {!answered && (
        <div className="bl-quest__card-actions">
          {question.kind === "open" && (
            <Button
              variant="primary"
              disabled={!text.trim() || busy}
              loading={busy}
              onClick={() => onSendOpen(text)}
            >
              Send answer
            </Button>
          )}
          <Button variant="ghost" icon={<SkipForward size={14} aria-hidden />} onClick={onSkip}>
            Skip question
          </Button>
        </div>
      )}
    </section>
  );
}

function CommentComposer({
  line,
  ownBranch,
  onAdd,
  onCancel,
}: {
  line: LineRef;
  ownBranch: boolean;
  onAdd: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const id = useId();
  return (
    <div
      className="bl-quest__composer"
      role="group"
      aria-label={`Comment on ${lineLabel(line).toLowerCase()}`}
    >
      <label className="text-small text-secondary" htmlFor={id}>
        {ownBranch ? "Note" : "Draft comment"} on {lineLabel(line).toLowerCase()}
      </label>
      <textarea
        id={id}
        className="bl-input bl-quest__textarea"
        rows={2}
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) onAdd(body);
        }}
      />
      <div className="bl-quest__card-actions">
        <Button
          size="sm"
          variant="primary"
          icon={<MessageSquarePlus size={14} aria-hidden />}
          disabled={!body.trim()}
          onClick={() => onAdd(body)}
        >
          Add (+{POINTS.comment})
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One file: the AI's questions above the file's diff. */
function RoundPane({
  spec,
  file,
  round,
  comments,
  onUpdate,
  onAnswer,
  onDraft,
  onFinish,
  onSkipFile,
  status,
  onStop,
  onRetry,
  onAskAgain,
  onReplying,
}: {
  spec: QuestSpec;
  file: QuestFile;
  round: RoundState;
  comments: DraftComment[];
  onUpdate: (change: (r: RoundState) => RoundState) => void;
  onAnswer: (index: number, answer: AnswerState, points: number) => void;
  onDraft: (body: string, line: LineRef | null) => void;
  onFinish: () => void;
  onSkipFile: () => void;
  /** The questions are prepared by the quest, in the background. */
  status: Asking;
  onStop: () => void;
  onRetry: () => void;
  /** Ask the AI for other questions about this file (before any is answered). */
  onAskAgain: () => void;
  /** An open answer is with the AI: preparing other files waits meanwhile. */
  onReplying: (replying: boolean) => void;
}) {
  const [diff, setDiff] = useState<{ path: string; diff?: FileDiff; error?: GitError } | null>(
    null,
  );
  const [replying, setReplyingState] = useState(false);
  const setReplying = (r: boolean) => {
    setReplyingState(r);
    onReplying(r);
  };
  const [composer, setComposer] = useState<LineRef | null>(null);
  // An answered question stays in view (with its explanation) until "Next question".
  const [stay, setStay] = useState<number | null>(null);
  const context = useMemo(() => contextFor(spec, file), [spec, file]);

  useEffect(() => {
    let cancelled = false;
    forgeService
      .rangeFileDiff(spec.repoPath, spec.base, spec.head, file.path, file.originalPath, false)
      .then((d) => !cancelled && setDiff({ path: file.path, diff: d }))
      .catch((e: GitError) => !cancelled && setDiff({ path: file.path, error: e }));
    return () => {
      cancelled = true;
    };
  }, [spec.repoPath, spec.base, spec.head, file.path, file.originalPath]);

  const needQuestions = round.questions === null && !round.skipped;

  const shown = diff?.path === file.path ? (diff.diff ?? null) : null;
  const rows = useMemo(() => (shown ? diffRows(shown) : []), [shown]);
  const questions = round.questions ?? [];
  const current = questions.findIndex((_, i) => !isAnswered(round.answers[i]));
  const allAnswered = questions.length > 0 && current === -1;
  const focus =
    stay !== null && stay < questions.length
      ? stay
      : current === -1
        ? questions.length - 1
        : current;
  const question = questions[focus];
  const answer = round.answers[focus];

  // After answering, the lines that matter light up; so does a line being commented on.
  const highlighted = useMemo(() => {
    const refs: LineRef[] = [];
    if (question && isAnswered(answer)) refs.push(...question.lines);
    if (answer?.line) refs.push(answer.line);
    if (answer?.reply?.line) refs.push(answer.reply.line);
    if (composer) refs.push(composer);
    return selectionFor(shown, refs);
  }, [question, answer, composer, shown]);

  const fileComments = comments.filter((c) => c.path === file.path);
  const { name, dir } = splitPath(file.path);
  const error = needQuestions ? status.error : null;
  const waiting = needQuestions && !error && status.asking;
  const paused = needQuestions && !error && !status.asking && status.paused;

  const chooseLine = (ref: LineRef) => {
    if (question?.kind === "findLine" && !isAnswered(answer)) {
      const a: AnswerState = { line: ref, correct: question.lines.some((l) => sameLine(l, ref)) };
      onAnswer(focus, a, pointsFor(question, a));
      setStay(focus);
    } else setComposer(ref);
  };

  return (
    <div className="bl-quest__round">
      <div className="bl-quest__questions">
        {waiting && (
          <div className="bl-quest__asking" role="status">
            <Spinner size={16} /> The AI is reading {name} and thinking of questions…
            <Button
              size="sm"
              variant="ghost"
              icon={<Square size={12} aria-hidden />}
              onClick={onStop}
            >
              Stop
            </Button>
          </div>
        )}
        {paused && (
          <div className="bl-quest__error" role="status">
            <p>Stopped. The AI prepares no questions until you continue.</p>
            <div className="bl-quest__card-actions">
              <Button size="sm" onClick={onRetry}>
                Continue
              </Button>
              <Button size="sm" variant="ghost" onClick={onSkipFile}>
                Skip this file
              </Button>
            </div>
          </div>
        )}
        {round.skipped && round.questions === null && (
          <div className="bl-quest__error" role="status">
            <p>You skipped this file.</p>
            <div className="bl-quest__card-actions">
              <Button size="sm" onClick={() => onUpdate((r) => ({ ...r, skipped: false }))}>
                Ask questions about it
              </Button>
            </div>
          </div>
        )}
        {error && (
          <div className="bl-quest__error" role="alert">
            <p>{error.message}</p>
            <div className="bl-quest__card-actions">
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onSkipFile}>
                Skip this file
              </Button>
            </div>
          </div>
        )}
        {question && (
          <QuestionCard
            question={question}
            answer={answer}
            index={focus}
            count={questions.length}
            busy={replying}
            ownBranch={spec.ownBranch}
            onChoose={(choice) => {
              const a: AnswerState = { choice, correct: choice === question.answer };
              onAnswer(focus, a, pointsFor(question, a));
              setStay(focus);
            }}
            onSendOpen={(text) => {
              const a: AnswerState = { text: text.trim() };
              onAnswer(focus, a, pointsFor(question, a));
              setStay(focus);
              setReplying(true);
              const index = focus;
              questService
                .reply(
                  spec.repoPath,
                  { ...context, question: question.prompt, answer: text },
                  opId(),
                )
                .then(
                  (reply) =>
                    onUpdate((r) => ({
                      ...r,
                      answers: r.answers.map((x, i) => (i === index ? { ...x, reply } : x)),
                    })),
                  (e: GitError) =>
                    onUpdate((r) => ({
                      ...r,
                      answers: r.answers.map((x, i) =>
                        i === index
                          ? { ...x, reply: { reply: e.message, comment: null, line: null } }
                          : x,
                      ),
                    })),
                )
                .finally(() => setReplying(false));
            }}
            onSkip={() => {
              onAnswer(focus, { skipped: true }, 0);
              setStay(null);
            }}
            onDraft={onDraft}
          />
        )}
        {questions.length > 0 && (
          <div className="bl-quest__round-actions">
            {isAnswered(answer) && current !== -1 ? (
              <Button
                variant="primary"
                icon={<ArrowRight size={14} aria-hidden />}
                disabled={replying}
                onClick={() => setStay(null)}
              >
                Next question
              </Button>
            ) : allAnswered ? (
              <Button
                variant="primary"
                icon={<ArrowRight size={14} aria-hidden />}
                disabled={replying}
                onClick={onFinish}
              >
                Finish {name} (+{POINTS.round})
              </Button>
            ) : question?.kind === "findLine" && !isAnswered(answer) ? (
              <span />
            ) : (
              <span className="text-small text-muted">
                {`Click a changed line in the diff to ${spec.ownBranch ? "write a note" : "draft a comment"} on it.`}
              </span>
            )}
            <span className="bl-quest__round-tools">
              {round.answers.every((a) => !isAnswered(a)) && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw size={14} aria-hidden />}
                  title="Ask the AI for other questions about this file"
                  onClick={onAskAgain}
                >
                  New questions
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                icon={<SkipForward size={14} aria-hidden />}
                onClick={onSkipFile}
              >
                Skip file
              </Button>
            </span>
          </div>
        )}
        {composer && (
          <CommentComposer
            key={`${composer.side}${composer.line}`}
            line={composer}
            ownBranch={spec.ownBranch}
            onAdd={(body) => {
              onDraft(body, composer);
              setComposer(null);
            }}
            onCancel={() => setComposer(null)}
          />
        )}
        {fileComments.length > 0 && (
          <ul
            className="bl-quest__drafts"
            aria-label={`Your ${spec.ownBranch ? "notes" : "draft comments"} on ${name}`}
          >
            {fileComments.map((c) => (
              <li key={c.id} className="text-small">
                <span className="mono text-muted">{lineLabel(c.line)}</span> {c.body}
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="bl-diff bl-quest__diff" aria-label={`Changes in ${file.path}`}>
        <p id="bl-diff-keyboard-hint" hidden>
          Click a changed line to answer a find-the-line question, or to comment on it.
        </p>
        <header className="bl-diff__header">
          <div className="bl-diff__title">
            <StatusLetter
              status={fileStatus({ ...file, additions: null, deletions: null, binary: false })}
            />
            <div className="bl-diff__name">
              <h2 className="text-h3 truncate selectable" title={file.path}>
                {name}
              </h2>
              <span className="text-small text-muted truncate">{dir || "repository root"}</span>
            </div>
          </div>
          <div className="bl-diff__actions">
            <DiffLayoutToggle />
          </div>
        </header>
        <DiffBody
          diff={shown}
          path={file.path}
          rows={rows}
          error={diff?.path === file.path ? (diff.error ?? null) : null}
          loading={diff?.path !== file.path}
          binaryNote="Binary file; its content is not shown."
          selection={highlighted}
          partial
          onLineClick={(_, hunk, line) => {
            if (!shown) return;
            const ref = lineRefAt(shown, hunk, line);
            if (ref) chooseLine(ref);
          }}
          onShowLarge={() => {}}
        />
      </section>
    </div>
  );
}

function Summary({
  spec,
  plan,
  state,
  onEdit,
  onRemove,
  onExit,
  onRestart,
}: {
  spec: QuestSpec;
  plan: QuestPlan;
  state: QuestState;
  onEdit: (id: string, body: string) => void;
  onRemove: (id: string) => void;
  onExit: () => void;
  onRestart: () => void;
}) {
  const s = stats(state);
  const cov = coverage(plan, state);
  const [copied, setCopied] = useState(false);
  const unfinished = plan.rounds.filter((f) => !state.rounds[f.path]?.done);
  return (
    <section className="bl-quest__summary" aria-label="Quest summary">
      <div className="bl-quest__trophy">
        <Trophy size={28} aria-hidden />
        <div>
          <h2 className="text-h2">{state.points} points</h2>
          <p className="text-secondary">
            {cov}% of the changed lines covered · {s.filesDone} of {plan.rounds.length} files ·{" "}
            {s.answered} answers
            {s.quiz > 0 ? ` · ${s.firstTry} of ${s.quiz} quiz questions right` : ""}
          </p>
        </div>
      </div>

      <h3 className="bl-section-label">
        {spec.ownBranch ? "Your notes" : "Your draft comments"} ({state.comments.length})
      </h3>
      {state.comments.length === 0 ? (
        <p className="text-small text-muted">
          None yet. Click a changed line in a file's diff to{" "}
          {spec.ownBranch ? "write a note" : "draft a comment"}.
        </p>
      ) : (
        <ul className="bl-quest__comment-list">
          {state.comments.map((c) => (
            <li key={c.id}>
              <span className="text-small mono text-muted">
                {c.path} · {lineLabel(c.line).toLowerCase()}
              </span>
              <textarea
                className="bl-input bl-quest__textarea"
                aria-label={`Comment on ${c.path}, ${lineLabel(c.line).toLowerCase()}`}
                rows={2}
                value={c.body}
                onChange={(e) => onEdit(c.id, e.target.value)}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={13} aria-hidden />}
                onClick={() => onRemove(c.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {state.comments.length > 0 && (
        <div className="bl-quest__card-actions">
          <Button
            icon={<ClipboardCopy size={14} aria-hidden />}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(commentsText(state.comments))
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            {copied ? "Copied" : "Copy all"}
          </Button>
          {!spec.ownBranch && (
            <span className="text-small text-muted">
              Posting comments from Branchline comes next; for now, copy them.
            </span>
          )}
        </div>
      )}

      {(unfinished.length > 0 || plan.skipped.length > 0) && (
        <>
          <h3 className="bl-section-label">Not part of the quest</h3>
          <ul className="bl-quest__skipped text-small">
            {unfinished.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span>{" "}
                <span className="text-muted">
                  {state.rounds[f.path]?.skipped ? "skipped" : "not finished"}
                </span>
              </li>
            ))}
            {plan.skipped.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span>{" "}
                <span className="text-muted">{f.skipped?.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="bl-quest__card-actions">
        <Button variant="primary" icon={<ArrowLeft size={14} aria-hidden />} onClick={onExit}>
          Back to {spec.backLabel.toLowerCase()}
        </Button>
        <Button variant="ghost" icon={<RotateCcw size={14} aria-hidden />} onClick={onRestart}>
          Restart quest
        </Button>
      </div>
    </section>
  );
}

/** The review quest: a round of questions per changed file, points, and draft comments. */
export function QuestView({ spec, onExit }: { spec: QuestSpec; onExit: () => void }) {
  const [loaded, setLoaded] = useState<{ plan?: QuestPlan; error?: GitError } | null>(null);
  const [state, setStateRaw] = useState(() => loadQuest(spec.storageKey, spec.head));
  const [gain, setGain] = useState<{ points: number; id: number } | null>(null);
  // Files whose questions could not be prepared, until Try again.
  const [failed, setFailed] = useState<Record<string, GitError>>({});
  // Stop pauses preparing questions; an open answer with the AI waits it out too.
  const [paused, setPaused] = useState(false);
  const [replying, setReplying] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    questService.plan(spec.repoPath, spec.base, spec.head).then(
      (plan) => !cancelled && setLoaded({ plan }),
      (error: GitError) => !cancelled && setLoaded({ error }),
    );
    return () => {
      cancelled = true;
    };
  }, [spec.repoPath, spec.base, spec.head]);

  const update = (change: (s: QuestState) => QuestState) =>
    setStateRaw((s) => {
      const next = change(s);
      saveQuest(spec.storageKey, next);
      return next;
    });
  const award = (points: number) => {
    if (points <= 0) return;
    update((s) => ({ ...s, points: s.points + points }));
    setGain((g) => ({ points, id: (g?.id ?? 0) + 1 }));
  };

  const plan = loaded?.plan;
  const atSummary = !!plan && state.current >= plan.rounds.length;
  const file = plan && !atSummary ? plan.rounds[state.current] : undefined;
  const round = (file && state.rounds[file.path]) || EMPTY_ROUND;
  const setRound = (path: string, change: (r: RoundState) => RoundState) =>
    update((s) => ({
      ...s,
      rounds: { ...s.rounds, [path]: change(s.rounds[path] ?? EMPTY_ROUND) },
    }));
  const goTo = (i: number) => update((s) => ({ ...s, current: i }));
  const addComment = (path: string, body: string, line: LineRef | null) => {
    if (!body.trim()) return;
    update((s) => ({
      ...s,
      comments: [
        ...s.comments,
        { id: `${Date.now()}-${s.comments.length}`, path, line, body: body.trim() },
      ],
    }));
    award(POINTS.comment);
  };
  const cov = plan ? coverage(plan, state) : 0;

  // Questions are prepared in the background, one file at a time (a local model answers one
  // request at a time anyway): the open file first, then the next ones, so they are ready
  // when you get there. Moving to another file that has none yet asks for that one first.
  const preparing = plan && !paused && !replying ? nextToPrepare(plan, state, failed) : null;
  useEffect(() => {
    if (!preparing || !plan) return;
    const prepared = plan.rounds.find((f) => f.path === preparing);
    if (!prepared) return;
    const id = opId();
    let settled = false;
    questService.round(spec.repoPath, contextFor(spec, prepared), id).then(
      (r) => {
        settled = true;
        setRound(preparing, (x) =>
          x.questions === null ? { ...x, questions: r.questions, answers: [] } : x,
        );
      },
      (error: GitError) => {
        settled = true;
        if (error.kind !== "cancelled") setFailed((f) => ({ ...f, [preparing]: error }));
      },
    );
    return () => {
      if (!settled) void questService.cancel(id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparing]);
  // A fresh quest: new questions for every file, answers and points from zero. Draft comments
  // are kept, since they are your own findings.
  const restart = async () => {
    const ok = await confirm({
      title: "Restart the quest?",
      description: `The AI asks new questions about every file, and your answers, points and progress start over.${
        state.comments.length
          ? ` Your ${state.comments.length === 1 ? "draft comment stays" : `${state.comments.length} draft comments stay`}.`
          : ""
      }`,
      confirmLabel: "Restart quest",
    });
    if (!ok) return;
    setFailed({});
    setPaused(false);
    update((s) => ({ ...emptyQuest(spec.head), comments: s.comments }));
  };
  const retry = (path: string) => {
    setFailed((f) => {
      const rest = { ...f };
      delete rest[path];
      return rest;
    });
    setPaused(false);
  };

  return (
    <section className="bl-quest" aria-label="Review quest">
      <header className="bl-quest__head">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={14} aria-hidden />}
          onClick={onExit}
        >
          {spec.backLabel}
        </Button>
        <div className="bl-quest__title">
          <Sparkles size={16} aria-hidden className="bl-quest__spark" />
          <h1 className="text-h3 truncate">
            {spec.ownBranch ? "Review your branch" : "Review quest"}: {spec.title}
          </h1>
        </div>
        {plan && (
          <div className="bl-quest__progress" aria-label={`${cov}% of the changed lines covered`}>
            <div className="bl-quest__bar">
              <div className="bl-quest__bar-fill" style={{ width: `${cov}%` }} />
            </div>
            <span className="text-small text-secondary">{cov}% covered</span>
          </div>
        )}
        <span className="bl-quest__points" aria-live="polite">
          <Trophy size={14} aria-hidden /> {state.points} points
          <Gain gain={gain} />
        </span>
        {plan && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={14} aria-hidden />}
            title="New questions for every file, answers and points from zero"
            onClick={() => void restart()}
          >
            Restart
          </Button>
        )}
        {plan && !atSummary && (
          <Button
            size="sm"
            icon={<Flag size={14} aria-hidden />}
            onClick={() => goTo(plan.rounds.length)}
          >
            Summary
          </Button>
        )}
      </header>

      {!loaded ? (
        <div className="bl-mr__loading" role="status">
          <Spinner size={18} /> Looking at the changes…
        </div>
      ) : loaded.error ? (
        <div className="bl-quest__error" role="alert">
          <p>{loaded.error.message}</p>
        </div>
      ) : plan && plan.rounds.length === 0 ? (
        <div className="bl-quest__error" role="status">
          <p>
            There are no files with changes to ask about
            {plan.skipped.length ? " (only binary or generated files)" : ""}.
          </p>
        </div>
      ) : (
        plan && (
          <div className="bl-quest__body">
            <nav className="bl-quest__files" aria-label="Quest files">
              {plan.rounds.map((f, i) => {
                const r = state.rounds[f.path];
                const { name, dir } = splitPath(f.path);
                const count = !r?.done && !r?.skipped ? r?.questions?.length : undefined;
                const note =
                  r?.done && !r.skipped
                    ? ", done"
                    : r?.skipped
                      ? ", skipped"
                      : count !== undefined
                        ? `, ${count} ${count === 1 ? "question" : "questions"} ready`
                        : preparing === f.path
                          ? ", preparing questions"
                          : f.path in failed
                            ? ", questions could not be prepared"
                            : "";
                return (
                  <button
                    key={f.path}
                    type="button"
                    className="bl-commit-file"
                    aria-current={i === state.current || undefined}
                    onClick={() => goTo(i)}
                  >
                    {r?.done && !r.skipped ? (
                      <CircleCheck size={14} aria-hidden className="bl-quest__done" />
                    ) : r?.skipped ? (
                      <SkipForward size={14} aria-hidden className="text-muted" />
                    ) : count !== undefined ? (
                      <span className="bl-quest__dot bl-quest__dot--count" aria-hidden>
                        {count}
                      </span>
                    ) : preparing === f.path ? (
                      <span className="bl-quest__dot bl-quest__dot--busy" aria-hidden>
                        <Spinner size={10} />
                      </span>
                    ) : f.path in failed ? (
                      <span className="bl-quest__dot bl-quest__dot--failed" aria-hidden>
                        !
                      </span>
                    ) : (
                      <span className="bl-quest__dot" aria-hidden />
                    )}
                    <span className="bl-commit-file__name truncate">{name}</span>
                    <span className="bl-commit-file__dir truncate">{dir}</span>
                    <span className="visually-hidden">{note}</span>
                  </button>
                );
              })}
              {plan.skipped.length > 0 && (
                <p className="text-small text-muted bl-quest__left-out">
                  {plan.skipped.length} {plan.skipped.length === 1 ? "file" : "files"} left out
                  (binary, generated or over the limit); see the summary.
                </p>
              )}
              <button
                type="button"
                className="bl-commit-file"
                aria-current={atSummary || undefined}
                onClick={() => goTo(plan.rounds.length)}
              >
                <Flag size={14} aria-hidden />
                <span className="bl-commit-file__name truncate">Summary</span>
              </button>
            </nav>
            <div className="bl-quest__main">
              {atSummary ? (
                <Summary
                  spec={spec}
                  plan={plan}
                  state={state}
                  onEdit={(id, body) =>
                    update((s) => ({
                      ...s,
                      comments: s.comments.map((c) => (c.id === id ? { ...c, body } : c)),
                    }))
                  }
                  onRemove={(id) =>
                    update((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== id) }))
                  }
                  onExit={onExit}
                  onRestart={() => void restart()}
                />
              ) : (
                file && (
                  <RoundPane
                    key={file.path}
                    spec={spec}
                    file={file}
                    round={round}
                    comments={state.comments}
                    onUpdate={(change) => setRound(file.path, change)}
                    onAnswer={(index, answer, points) => {
                      setRound(file.path, (r) => {
                        const answers = [...r.answers];
                        answers[index] = answer;
                        return { ...r, answers };
                      });
                      award(points);
                    }}
                    onDraft={(body, line) => addComment(file.path, body, line)}
                    onFinish={() => {
                      const first = !round.done;
                      setRound(file.path, (r) => ({ ...r, done: true, skipped: false }));
                      if (first) award(POINTS.round);
                      goTo(state.current + 1);
                    }}
                    onSkipFile={() => {
                      setRound(file.path, (r) => ({ ...r, skipped: true, done: false }));
                      goTo(state.current + 1);
                    }}
                    status={{
                      asking: preparing === file.path,
                      error: failed[file.path] ?? null,
                      paused,
                    }}
                    onStop={() => setPaused(true)}
                    onRetry={() => retry(file.path)}
                    onAskAgain={() => {
                      retry(file.path);
                      setRound(file.path, (r) => ({ ...r, questions: null, answers: [] }));
                    }}
                    onReplying={setReplying}
                  />
                )
              )}
            </div>
          </div>
        )
      )}
    </section>
  );
}
