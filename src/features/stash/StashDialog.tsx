import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { plural } from "../../lib/format";

/** Message and options for a new stash. */
export function StashDialog({
  changedFiles,
  untrackedFiles,
  onSubmit,
  onCancel,
}: {
  changedFiles: number;
  untrackedFiles: number;
  /** Resolves to an error message to show, or null on success. */
  onSubmit: (message: string, includeUntracked: boolean) => Promise<string | null>;
  onCancel: () => void;
}) {
  const inputId = useId();
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const problem = await onSubmit(message, includeUntracked);
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <Dialog
      title="Stash changes"
      description={`${plural(changedFiles, "changed file")} are put aside and the working tree is cleaned. Bring them back later with Apply or Pop.`}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy}>
            Stash
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={inputId} className="bl-field-group__label">
          Message <span className="text-muted">(optional)</span>
        </label>
        <input
          id={inputId}
          className="bl-input"
          value={message}
          placeholder="What are these changes?"
          onChange={(e) => setMessage(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <label className="bl-checkbox">
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(e) => setIncludeUntracked(e.target.checked)}
        />
        <span>
          Include untracked files
          {untrackedFiles > 0 && <span className="text-muted"> ({untrackedFiles})</span>}
        </span>
      </label>
      {error && (
        <p className="bl-field-group__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
