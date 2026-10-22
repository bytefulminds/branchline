import { FolderOpen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { pickFolder } from "../../services/dialog";
import { gitService } from "../../services/git";
import type { BranchList, RepositoryInfo, StartPoint, WorktreeTarget } from "../../types/git";
import "../remote/PublishDialog.css";
import "./Worktrees.css";

const DEBOUNCE_MS = 150;

/** How the dialog opens: preset to a branch, or to start a new branch somewhere. */
export type WorktreePreset =
  | { mode: "branch"; branch: string }
  | { mode: "new"; start: StartPoint; startLabel: string; name?: string }
  | { mode: "detached"; oid: string };

type Mode = "new" | "branch" | "detached";

/** Path separator used by a path (Windows paths use backslashes). */
export function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** `/code/app` + `feature/login` → `/code/app-feature-login`, next to the repository. */
export function defaultWorktreePath(repoPath: string, label: string): string {
  const sep = separatorOf(repoPath);
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut >= 0 ? trimmed.slice(0, cut) : trimmed;
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  const slug = label
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${parent || sep}${parent.endsWith(sep) ? "" : sep}${name}${slug ? `-${slug}` : ""}`;
}

function startKey(start: StartPoint): string {
  return start.kind === "head"
    ? "head"
    : start.kind === "branch"
      ? `b:${start.name}`
      : `c:${start.oid}`;
}

export function WorktreeDialog({
  repo,
  branches,
  preset,
  onSubmit,
  onCancel,
}: {
  repo: RepositoryInfo;
  branches: BranchList | null;
  preset?: WorktreePreset;
  /** Resolves to an error message to show, or null when created. */
  onSubmit: (path: string, target: WorktreeTarget, open: boolean) => Promise<string | null>;
  onCancel: () => void;
}) {
  const ids = { name: useId(), branch: useId(), start: useId(), path: useId() };
  const current = repo.head.kind === "branch" ? repo.head.name : null;
  const [mode, setMode] = useState<Mode>(preset?.mode ?? "new");
  const [name, setName] = useState(preset?.mode === "new" ? (preset.name ?? "") : "");
  const [start, setStart] = useState<StartPoint>(
    preset?.mode === "new" ? preset.start : { kind: "head" },
  );
  const available = (branches?.local ?? []).filter((b) => !b.isCurrent && !b.worktreePath);
  const [branch, setBranch] = useState(
    preset?.mode === "branch" ? preset.branch : (available[0]?.name ?? ""),
  );
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [validation, setValidation] = useState<{ name: string; problem: string | null } | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const label =
    mode === "new"
      ? name
      : mode === "branch"
        ? branch
        : preset?.mode === "detached"
          ? preset.oid.slice(0, 7)
          : "";
  const path = customPath ?? defaultWorktreePath(repo.path, label);

  useEffect(() => {
    if (mode !== "new" || !name) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      gitService
        .checkBranchName(repo.path, name)
        .then((problem) => !cancelled && setValidation({ name, problem }))
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [repo.path, mode, name]);

  const duplicate =
    mode === "new" && branches?.local.some((b) => b.name === name)
      ? `A branch named ${name} already exists. Choose "Existing branch" to check it out.`
      : null;
  const nameProblem =
    mode === "new" && name
      ? (duplicate ?? (validation?.name === name ? validation.problem : null))
      : null;
  const ready =
    !!path.trim() &&
    !busy &&
    (mode === "new"
      ? !!name && validation?.name === name && !nameProblem
      : mode === "branch"
        ? !!branch
        : preset?.mode === "detached");

  const target = (): WorktreeTarget | null => {
    if (mode === "new") return { kind: "newBranch", name, start };
    if (mode === "branch") return { kind: "branch", name: branch };
    if (preset?.mode === "detached")
      return { kind: "detached", start: { kind: "commit", oid: preset.oid } };
    return null;
  };

  const submit = async () => {
    const t = target();
    if (!ready || !t) return;
    setBusy(true);
    setSubmitError(await onSubmit(path.trim(), t, open));
    setBusy(false);
  };

  const browse = async () => {
    const sep = separatorOf(repo.path);
    const leaf = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const parent = await pickFolder("Choose where the worktree folder goes");
    if (parent) setCustomPath(`${parent.replace(/[\\/]+$/, "")}${sep}${leaf}`);
  };

  const startOptions: { key: string; label: string; start: StartPoint }[] = [
    {
      key: "head",
      label: current ? `${current} (current)` : "HEAD (current)",
      start: { kind: "head" },
    },
    ...(preset?.mode === "new" && preset.start.kind === "commit"
      ? [{ key: startKey(preset.start), label: preset.startLabel, start: preset.start }]
      : []),
    ...(branches?.local ?? [])
      .filter((b) => !b.isCurrent)
      .map((b) => ({
        key: `b:${b.name}`,
        label: b.name,
        start: { kind: "branch", name: b.name } as StartPoint,
      })),
    ...(branches?.remote ?? []).map((b) => ({
      key: `b:${b.name}`,
      label: b.name,
      start: { kind: "branch", name: b.name } as StartPoint,
    })),
  ];

  const shown = submitError ?? nameProblem;

  return (
    <Dialog
      size="wide"
      title="New worktree"
      description="A second working folder for this repository, with its own branch checked out. Work on it side by side without stashing or switching."
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={busy}>
            Create worktree
          </Button>
        </>
      }
    >
      <fieldset className="bl-publish bl-worktree-dialog__modes">
        <legend className="bl-field-group__label">Check out</legend>
        <label className="bl-publish__option">
          <input
            type="radio"
            name="wt-mode"
            checked={mode === "new"}
            onChange={() => setMode("new")}
          />
          <span className="bl-publish__text">
            <span className="bl-publish__name">New branch</span>
          </span>
        </label>
        <label className="bl-publish__option">
          <input
            type="radio"
            name="wt-mode"
            checked={mode === "branch"}
            disabled={available.length === 0 && preset?.mode !== "branch"}
            onChange={() => setMode("branch")}
          />
          <span className="bl-publish__text">
            <span className="bl-publish__name">Existing branch</span>
            {available.length === 0 && preset?.mode !== "branch" && (
              <span className="bl-publish__url">Every branch is already checked out somewhere</span>
            )}
          </span>
        </label>
        {preset?.mode === "detached" && (
          <label className="bl-publish__option">
            <input
              type="radio"
              name="wt-mode"
              checked={mode === "detached"}
              onChange={() => setMode("detached")}
            />
            <span className="bl-publish__text">
              <span className="bl-publish__name">
                Commit {preset.oid.slice(0, 7)} without a branch
              </span>
              <span className="bl-publish__url">Detached HEAD, for looking around</span>
            </span>
          </label>
        )}
      </fieldset>

      {mode === "new" && (
        <div className="bl-worktree-dialog__row">
          <div className="bl-field-group">
            <label htmlFor={ids.name} className="bl-field-group__label">
              Branch name
            </label>
            <input
              id={ids.name}
              className="bl-input mono"
              value={name}
              placeholder="feature/login"
              data-autofocus
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!shown}
              aria-describedby={shown ? `${ids.name}-msg` : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setSubmitError(null);
              }}
            />
          </div>
          <div className="bl-field-group">
            <label htmlFor={ids.start} className="bl-field-group__label">
              Starting from
            </label>
            <select
              id={ids.start}
              className="bl-input"
              value={startKey(start)}
              onChange={(e) => {
                const option = startOptions.find((o) => o.key === e.target.value);
                if (option) setStart(option.start);
              }}
            >
              {startOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {mode === "branch" && (
        <div className="bl-field-group">
          <label htmlFor={ids.branch} className="bl-field-group__label">
            Branch
          </label>
          <select
            id={ids.branch}
            className="bl-input"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setSubmitError(null);
            }}
          >
            {(branches?.local ?? [])
              .filter((b) => !b.isCurrent)
              .map((b) => (
                <option key={b.name} value={b.name} disabled={!!b.worktreePath}>
                  {b.name}
                  {b.worktreePath ? " (in another worktree)" : ""}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="bl-field-group">
        <label htmlFor={ids.path} className="bl-field-group__label">
          Folder
        </label>
        <div className="bl-worktree-dialog__path">
          <input
            id={ids.path}
            className="bl-input mono"
            value={path}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setCustomPath(e.target.value);
              setSubmitError(null);
            }}
          />
          <Button
            variant="secondary"
            icon={<FolderOpen size={14} aria-hidden />}
            onClick={() => void browse()}
          >
            Browse…
          </Button>
        </div>
        <p className="text-small text-muted bl-worktree-dialog__hint">
          A new folder outside the repository. It is created for you.
        </p>
      </div>

      {shown && (
        <p id={`${ids.name}-msg`} className="bl-field-group__error" role="alert">
          {shown}
        </p>
      )}

      <label className="bl-checkbox">
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
        <span>Open it in Branchline after creating</span>
      </label>
    </Dialog>
  );
}
