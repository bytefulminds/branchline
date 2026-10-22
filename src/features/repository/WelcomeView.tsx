import { CircleAlert, CloudDownload, FolderOpen, FolderPlus, History, X } from "lucide-react";
import { Button, IconButton } from "../../components/Button";
import { LogoMark } from "../../components/Logo";
import { displayPath, relativeTime } from "../../lib/format";
import { modKeyLabel } from "../../services/platform";
import type { GitError, GitVersion } from "../../types/git";
import type { RepositoryController } from "./useRepository";
import "./WelcomeView.css";

export function WelcomeView({
  controller,
  onOpen,
  onClone,
  onCreate,
  gitVersion,
}: {
  controller: RepositoryController;
  onOpen: () => void;
  onClone: () => void;
  onCreate: () => void;
  gitVersion: GitVersion | GitError | null;
}) {
  const gitProblem = gitVersion && "kind" in gitVersion ? gitVersion : null;
  return (
    <div className="bl-welcome">
      <div className="bl-welcome__hero">
        <LogoMark size={64} title="Branchline" />
        <h1 className="text-h1">Branchline</h1>
        <p className="bl-welcome__tagline">See the flow of your code.</p>
      </div>

      {gitProblem && (
        <div className="bl-welcome__alert" role="alert">
          <CircleAlert size={18} aria-hidden />
          <div>
            <div className="text-h3">Git is not available</div>
            <div className="text-secondary">{gitProblem.message}</div>
          </div>
        </div>
      )}

      <div className="bl-welcome__actions">
        <Button
          variant="primary"
          icon={<FolderOpen size={16} aria-hidden />}
          shortcut={`${modKeyLabel}O`}
          onClick={onOpen}
        >
          Open repository
        </Button>
        <Button icon={<CloudDownload size={16} aria-hidden />} onClick={onClone}>
          Clone…
        </Button>
        <Button icon={<FolderPlus size={16} aria-hidden />} onClick={onCreate}>
          New repository…
        </Button>
      </div>

      <section className="bl-welcome__recent" aria-labelledby="welcome-recent">
        <h2 id="welcome-recent" className="bl-welcome__heading">
          Recent repositories
        </h2>
        {controller.recent.length === 0 ? (
          <p className="bl-welcome__empty text-secondary">
            Repositories you open appear here for quick access.
          </p>
        ) : (
          <ul className="bl-welcome__list">
            {controller.recent.map((r) => (
              <li key={r.path} className="bl-welcome__row">
                <button
                  type="button"
                  className="bl-welcome__repo"
                  onClick={() => void controller.open(r.path)}
                >
                  <History size={16} aria-hidden className="bl-welcome__repo-icon" />
                  <span className="bl-welcome__repo-text">
                    <span className="truncate bl-welcome__repo-name">{r.name}</span>
                    <span className="truncate text-small text-muted">{displayPath(r.path)}</span>
                  </span>
                  <span className="text-small text-muted bl-welcome__repo-time">
                    {relativeTime(r.lastOpened)}
                  </span>
                </button>
                <IconButton
                  size="sm"
                  label={`Remove ${r.name} from recent`}
                  icon={<X size={14} aria-hidden />}
                  onClick={() => controller.forgetRecent(r.path)}
                  className="bl-welcome__remove"
                  data-tooltip-align="end"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
