import { useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { gitService } from "../../services/git";

const DEBOUNCE_MS = 150;

/** Name, optional message and "push after creating" for a new tag. */
export function TagDialog({
  repoPath,
  targetLabel,
  pushRemote,
  onSubmit,
  onCancel,
}: {
  repoPath: string;
  /** Where the tag goes ("main", "commit a1b2c3d"). */
  targetLabel: string;
  /** Remote to offer pushing to ("origin"), "a remote" when there are several, or null. */
  pushRemote: string | null;
  /** Resolves to an error message to show, or null on success. */
  onSubmit: (name: string, message: string, push: boolean) => Promise<string | null>;
  onCancel: () => void;
}) {
  const nameId = useId();
  const messageId = useId();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(false);
  const [validation, setValidation] = useState<{ name: string; problem: string | null } | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      gitService
        .checkTagName(repoPath, name)
        .then((problem) => !cancelled && setValidation({ name, problem }))
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [repoPath, name]);

  const problem = name && validation?.name === name ? validation.problem : null;
  const checked = !!name && validation?.name === name;
  const canSubmit = !!name && checked && !problem && !busy;
  const shown = submitError ?? problem;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(await onSubmit(name, message, push));
    setBusy(false);
  };

  return (
    <Dialog
      title="Create tag"
      description={<>Tags {targetLabel}.</>}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={busy}>
            Create tag
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={nameId} className="bl-field-group__label">
          Tag name
        </label>
        <input
          id={nameId}
          className="bl-input mono"
          value={name}
          placeholder="v1.2.0"
          onChange={(e) => {
            setName(e.target.value);
            setSubmitError(null);
          }}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!shown}
          aria-describedby={shown ? `${nameId}-msg` : undefined}
          autoFocus
        />
        {shown && (
          <p id={`${nameId}-msg`} className="bl-field-group__error" role="alert">
            {shown}
          </p>
        )}
      </div>
      <div className="bl-field-group">
        <label htmlFor={messageId} className="bl-field-group__label">
          Message <span className="text-muted">(optional, creates an annotated tag)</span>
        </label>
        <textarea
          id={messageId}
          className="bl-input bl-input--multiline"
          rows={3}
          value={message}
          placeholder="Release notes or a short description"
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      {pushRemote && (
        <label className="bl-checkbox">
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
          <span>Push to {pushRemote} after creating</span>
        </label>
      )}
    </Dialog>
  );
}
