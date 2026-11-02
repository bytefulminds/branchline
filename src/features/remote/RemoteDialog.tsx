import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { RemoteInfo } from "../../types/git";

/** Quick checks before Git sees the values; the backend checks everything again. */
export function remoteNameProblem(name: string, existing: string[], current?: string) {
  if (!name) return null;
  if (/\s/.test(name)) return "Remote names cannot contain spaces.";
  if (/^[-.]/.test(name)) return "Remote names cannot start with a dash or a dot.";
  if (name !== current && existing.includes(name)) return `A remote named ${name} already exists.`;
  return null;
}

export function remoteUrlProblem(url: string) {
  if (!url) return null;
  if (url !== url.trim()) return "Remove the spaces at the start or end.";
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url))
    return "Leave the password or token out of the address; Git asks your credential helper for it.";
  return null;
}

/** Add a remote, or rename one and change its addresses. */
export function RemoteDialog({
  remote,
  existing,
  onSubmit,
  onCancel,
}: {
  /** The remote being edited, or null to add one. */
  remote: RemoteInfo | null;
  existing: string[];
  /** Resolves to an error message to show, or null when saved. */
  onSubmit: (values: {
    name: string;
    url: string;
    pushUrl: string;
    fetch: boolean;
  }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const ids = { name: useId(), url: useId(), push: useId() };
  const [name, setName] = useState(remote?.name ?? (existing.includes("origin") ? "" : "origin"));
  const [url, setUrl] = useState(remote?.url ?? "");
  const [pushUrl, setPushUrl] = useState(remote?.pushUrl ?? "");
  const [fetch, setFetch] = useState(!remote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameProblem = remoteNameProblem(name, existing, remote?.name);
  const urlProblem = remoteUrlProblem(url) ?? (pushUrl ? remoteUrlProblem(pushUrl) : null);
  const unchanged =
    !!remote && name === remote.name && url === remote.url && pushUrl === (remote.pushUrl ?? "");
  const ready = !!name && !!url && !nameProblem && !urlProblem && !unchanged && !busy;
  const redacted = !!remote && (remote.url.includes("***") || !!remote.pushUrl?.includes("***"));
  const shown = error ?? nameProblem ?? urlProblem;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(await onSubmit({ name, url, pushUrl, fetch }));
    setBusy(false);
  };

  return (
    <Dialog
      title={remote ? `Edit remote ${remote.name}` : "Add remote"}
      description={
        remote
          ? undefined
          : "A remote is another copy of this repository, usually on a server such as GitHub or GitLab, that you fetch from and push to."
      }
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={busy}>
            {remote ? "Save" : "Add remote"}
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={ids.name} className="bl-field-group__label">
          Name
        </label>
        <input
          id={ids.name}
          className="bl-input mono"
          value={name}
          placeholder={existing.includes("origin") ? "upstream" : "origin"}
          spellCheck={false}
          autoComplete="off"
          data-autofocus={remote ? undefined : true}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </div>
      <div className="bl-field-group">
        <label htmlFor={ids.url} className="bl-field-group__label">
          Address
        </label>
        <input
          id={ids.url}
          className="bl-input mono"
          value={url}
          placeholder="https://github.com/you/project.git or git@github.com:you/project.git"
          spellCheck={false}
          autoComplete="off"
          data-autofocus={remote ? true : undefined}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
        />
      </div>
      {remote && (
        <div className="bl-field-group">
          <label htmlFor={ids.push} className="bl-field-group__label">
            Push address <span className="text-muted">(optional, when pushing goes elsewhere)</span>
          </label>
          <input
            id={ids.push}
            className="bl-input mono"
            value={pushUrl}
            placeholder="Same as the address"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setPushUrl(e.target.value);
              setError(null);
            }}
          />
        </div>
      )}
      {redacted && (
        <p className="text-small text-muted">
          *** hides a user name or token stored in the address. Leave it as it is to keep it.
        </p>
      )}
      {shown && (
        <p className="bl-field-group__error" role="alert">
          {shown}
        </p>
      )}
      {!remote && (
        <label className="bl-checkbox">
          <input type="checkbox" checked={fetch} onChange={(e) => setFetch(e.target.checked)} />
          <span>Fetch its branches after adding</span>
        </label>
      )}
    </Dialog>
  );
}
