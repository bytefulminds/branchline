import { FolderOpen } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { pickFolder } from "../../services/dialog";
import { gitService } from "../../services/git";
import type { GitError, RemoteProgress } from "../../types/git";
import { remoteUrlProblem } from "../remote/RemoteDialog";
import { separatorOf } from "../worktrees/WorktreeDialog";
import "../worktrees/Worktrees.css";
import "./CreateDialogs.css";

/** Folder name Git would pick for a clone: the last path part without `.git`. */
export function cloneFolderName(url: string): string {
  const last =
    url
      .trim()
      .replace(/[\\/]+$/, "")
      .split(/[\\/:]/)
      .pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/** Parent folder of a path, keeping its separator style. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}

const ERROR_HINT: Partial<Record<GitError["kind"], string>> = {
  authFailed:
    "Git could not sign in. Branchline does not ask for passwords: use an SSH key with an agent, or a credential helper (macOS Keychain, Git Credential Manager).",
  hostKeyUnverified:
    "This SSH host is not known yet. Connect once from a terminal (for example `ssh -T git@github.com`) to trust it, then try again.",
  remoteNotFound: "Nothing was found at that address. Check it, and whether you have access.",
  networkFailed: "The server could not be reached. Check the address and your connection.",
};

let nextClone = 0;

/** Clone a repository from an address into a new folder, with progress and Cancel. */
export function CloneDialog({
  defaultParent,
  onDone,
  onCancel,
}: {
  /** Folder that new clones go in by default (for example next to the last repository). */
  defaultParent: string;
  onDone: (path: string) => void;
  onCancel: () => void;
}) {
  const ids = { url: useId(), parent: useId(), name: useId() };
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(defaultParent);
  const [customName, setCustomName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RemoteProgress | null>(null);
  const opId = useRef<string | null>(null);

  const name = customName ?? cloneFolderName(url);
  const sep = separatorOf(parent || "/");
  const dest = parent && name ? `${parent.replace(/[\\/]+$/, "")}${sep}${name}` : "";
  const urlProblem = remoteUrlProblem(url.trim());
  const ready = !!url.trim() && !!dest && !urlProblem && !running;

  const start = async () => {
    if (!ready) return;
    const id = `clone-${nextClone++}`;
    opId.current = id;
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const path = await gitService.cloneRepository(url.trim(), dest, id, setProgress);
      onDone(path);
    } catch (e) {
      const err = e as GitError;
      setError(
        err.kind === "cancelled"
          ? "Cancelled. Nothing was kept."
          : `${err.message}${ERROR_HINT[err.kind] ? ` ${ERROR_HINT[err.kind]}` : ""}`,
      );
    } finally {
      opId.current = null;
      setRunning(false);
    }
  };

  const cancel = () => {
    if (running && opId.current) void gitService.cancelRemote(opId.current);
    else onCancel();
  };

  return (
    <Dialog
      size="wide"
      title="Clone repository"
      description="Copy a repository from a server or another folder, with all its history and branches."
      onCancel={cancel}
      onSubmit={() => void start()}
      actions={
        <>
          <Button variant="secondary" onClick={cancel}>
            {running ? "Stop" : "Cancel"}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={running}>
            Clone
          </Button>
        </>
      }
    >
      <div className="bl-field-group">
        <label htmlFor={ids.url} className="bl-field-group__label">
          Address
        </label>
        <input
          id={ids.url}
          className="bl-input mono"
          value={url}
          placeholder="https://github.com/owner/project.git or git@github.com:owner/project.git"
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          disabled={running}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
        />
      </div>
      <div className="bl-worktree-dialog__row">
        <div className="bl-field-group">
          <label htmlFor={ids.parent} className="bl-field-group__label">
            Into folder
          </label>
          <div className="bl-worktree-dialog__path">
            <input
              id={ids.parent}
              className="bl-input mono"
              value={parent}
              placeholder="/Users/you/code"
              spellCheck={false}
              autoComplete="off"
              disabled={running}
              onChange={(e) => setParent(e.target.value)}
            />
            <Button
              variant="secondary"
              icon={<FolderOpen size={14} aria-hidden />}
              disabled={running}
              onClick={() =>
                void pickFolder("Choose where to put the clone").then((p) => p && setParent(p))
              }
            >
              Browse…
            </Button>
          </div>
        </div>
        <div className="bl-field-group">
          <label htmlFor={ids.name} className="bl-field-group__label">
            Folder name
          </label>
          <input
            id={ids.name}
            className="bl-input mono"
            value={name}
            spellCheck={false}
            autoComplete="off"
            disabled={running}
            onChange={(e) => setCustomName(e.target.value)}
          />
        </div>
      </div>
      {dest && <p className="text-small text-muted bl-create__dest mono">{dest}</p>}

      {running && (
        <div className="bl-create__progress" role="status">
          <div className="text-small">
            {progress?.phase ?? "Connecting"}
            {progress?.percent != null && ` ${progress.percent}%`}
            {progress?.detail && <span className="text-muted"> · {progress.detail}</span>}
          </div>
          <div
            className="bl-create__bar"
            role="progressbar"
            aria-label="Clone progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress?.percent ?? undefined}
          >
            <span style={{ width: `${progress?.percent ?? 4}%` }} />
          </div>
        </div>
      )}
      {(error ?? urlProblem) && (
        <p className="bl-field-group__error" role="alert">
          {error ?? urlProblem}
        </p>
      )}
    </Dialog>
  );
}
