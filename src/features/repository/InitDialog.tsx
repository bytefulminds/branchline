import { FolderOpen } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { pickFolder } from "../../services/dialog";
import { gitService } from "../../services/git";
import type { GitError } from "../../types/git";
import "../worktrees/Worktrees.css";
import "./CreateDialogs.css";

/** Create a new repository in a folder (new, or existing with files). */
export function InitDialog({
  defaultFolder,
  onDone,
  onCancel,
}: {
  defaultFolder: string;
  onDone: (path: string) => void;
  onCancel: () => void;
}) {
  const ids = { folder: useId(), branch: useId() };
  const [folder, setFolder] = useState(defaultFolder);
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!folder.trim() && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await gitService.initRepository(folder.trim(), branch.trim()));
    } catch (e) {
      setError((e as GitError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New repository"
      description="Start tracking a folder with Git. Files already in it stay where they are and show up as new files to commit."
      onCancel={onCancel}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={busy}>
            Create repository
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={ids.folder} className="bl-field-group__label">
          Folder
        </label>
        <div className="bl-worktree-dialog__path">
          <input
            id={ids.folder}
            className="bl-input mono"
            value={folder}
            placeholder="/Users/you/code/new-project"
            spellCheck={false}
            autoComplete="off"
            data-autofocus
            onChange={(e) => {
              setFolder(e.target.value);
              setError(null);
            }}
          />
          <Button
            variant="secondary"
            icon={<FolderOpen size={14} aria-hidden />}
            onClick={() =>
              void pickFolder("Choose the folder for the new repository").then(
                (p) => p && setFolder(p),
              )
            }
          >
            Browse…
          </Button>
        </div>
        <p className="text-small text-muted bl-worktree-dialog__hint">
          An existing folder, or a new one (its parent folder must exist).
        </p>
      </div>
      <div className="bl-field-group">
        <label htmlFor={ids.branch} className="bl-field-group__label">
          First branch
        </label>
        <input
          id={ids.branch}
          className="bl-input mono"
          value={branch}
          placeholder="Git's default"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      {error && (
        <p className="bl-field-group__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
