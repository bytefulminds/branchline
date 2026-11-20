import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";

/** A new message for one commit: summary and description, like the commit box. */
export function RewordDialog({
  short,
  message,
  note,
  onSubmit,
  onCancel,
}: {
  /** Short commit id, for the title. */
  short: string;
  /** The current message, to start from. */
  message: string;
  /** Extra line under the title, for example about a force push. */
  note?: string;
  /** Resolves to an error message to show, or null when done. */
  onSubmit: (message: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const summaryId = useId();
  const bodyId = useId();
  const [first, ...rest] = message.split("\n");
  const [summary, setSummary] = useState(first ?? "");
  const [body, setBody] = useState(rest.join("\n").replace(/^\n+/, ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = body.trim() ? `${summary.trim()}\n\n${body.trim()}` : summary.trim();
  const changed = text !== message.trim();
  const canSubmit = !!summary.trim() && changed && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(await onSubmit(text));
    setBusy(false);
  };

  return (
    <Dialog
      title={`Edit the message of ${short}`}
      description={
        note ?? "The commits after it are applied again unchanged; only this message is replaced."
      }
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={busy}>
            Save message
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={summaryId} className="bl-field-group__label">
          Summary
        </label>
        <input
          id={summaryId}
          className="bl-input"
          value={summary}
          onChange={(e) => {
            setSummary(e.target.value);
            setError(null);
          }}
          autoComplete="off"
          aria-invalid={!!error}
          aria-describedby={error ? `${summaryId}-msg` : undefined}
          data-autofocus
        />
        {error && (
          <p id={`${summaryId}-msg`} className="bl-field-group__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="bl-field-group">
        <label htmlFor={bodyId} className="bl-field-group__label">
          Description <span className="text-muted">(optional)</span>
        </label>
        <textarea
          id={bodyId}
          className="bl-input bl-input--multiline"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
    </Dialog>
  );
}
