import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { RemoteInfo } from "../../types/git";
import "./PublishDialog.css";

/** Choose the remote for a branch that has no upstream yet. */
export function PublishDialog({
  branch,
  remotes,
  onSubmit,
  onCancel,
}: {
  branch: string;
  remotes: RemoteInfo[];
  onSubmit: (remote: string) => void;
  onCancel: () => void;
}) {
  const [remote, setRemote] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "",
  );
  return (
    <Dialog
      title={`Publish ${branch}`}
      description="The branch is pushed and the remote branch becomes its upstream, so later pulls and pushes go there."
      onCancel={onCancel}
      onSubmit={() => remote && onSubmit(remote)}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!remote}>
            Publish
          </Button>
        </>
      }
    >
      <fieldset className="bl-publish">
        <legend className="visually-hidden">Remote</legend>
        {remotes.map((r) => (
          <label key={r.name} className="bl-publish__option">
            <input
              type="radio"
              name="remote"
              value={r.name}
              checked={remote === r.name}
              onChange={() => setRemote(r.name)}
            />
            <span className="bl-publish__text">
              <span className="bl-publish__name">{r.name}</span>
              <span className="bl-publish__url mono truncate" title={r.pushUrl ?? r.url}>
                {r.pushUrl ?? r.url}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
