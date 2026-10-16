import { useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { gitService } from "../../services/git";
import type { BranchList } from "../../types/git";

export interface BranchNameDialogProps {
  mode: "create" | "rename";
  repoPath: string;
  branches: BranchList | null;
  initialName?: string;
  /** Human description of where a new branch starts ("main", "commit a1b2c3d"). */
  startLabel?: string;
  /** Resolves to an error message to show, or null on success. */
  onSubmit: (name: string, checkout: boolean) => Promise<string | null>;
  onCancel: () => void;
}

const DEBOUNCE_MS = 150;

export function BranchNameDialog({
  mode,
  repoPath,
  branches,
  initialName = "",
  startLabel,
  onSubmit,
  onCancel,
}: BranchNameDialogProps) {
  const inputId = useId();
  const [name, setName] = useState(initialName);
  const [checkout, setCheckout] = useState(true);
  const [validation, setValidation] = useState<{ name: string; problem: string | null } | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name;
  const duplicate =
    trimmed !== initialName && branches?.local.some((b) => b.name === trimmed)
      ? `A branch named ${trimmed} already exists.`
      : null;

  // Ask Git whether the name is valid, debounced while typing.
  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      gitService
        .checkBranchName(repoPath, trimmed)
        .then((problem) => !cancelled && setValidation({ name: trimmed, problem }))
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [repoPath, trimmed]);

  const problem = !trimmed
    ? null
    : (duplicate ?? (validation?.name === trimmed ? validation.problem : null));
  const unchanged = mode === "rename" && trimmed === initialName;
  const canSubmit = !!trimmed && !problem && !unchanged && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(await onSubmit(trimmed, checkout));
    setBusy(false);
  };

  const message = submitError ?? problem;

  return (
    <Dialog
      title={mode === "create" ? "Create branch" : `Rename ${initialName}`}
      description={mode === "create" && startLabel ? <>Starts at {startLabel}.</> : undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={busy}>
            {mode === "create" ? "Create branch" : "Rename"}
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={inputId} className="bl-field-group__label">
          Branch name
        </label>
        <input
          id={inputId}
          className="bl-input mono"
          value={name}
          placeholder="feature/my-change"
          onChange={(e) => {
            setName(e.target.value);
            setSubmitError(null);
          }}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!message}
          aria-describedby={message ? `${inputId}-msg` : undefined}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
        {message && (
          <p id={`${inputId}-msg`} className="bl-field-group__error" role="alert">
            {message}
          </p>
        )}
      </div>
      {mode === "create" && (
        <label className="bl-checkbox">
          <input
            type="checkbox"
            checked={checkout}
            onChange={(e) => setCheckout(e.target.checked)}
          />
          <span>Switch to the new branch</span>
        </label>
      )}
    </Dialog>
  );
}
