import { CircleAlert, FolderOpen, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { displayPath } from "../../lib/format";
import type { GitError } from "../../types/git";
import "./RepositoryStatusViews.css";

export function RepositoryLoading({ path }: { path: string }) {
  return (
    <EmptyState
      role="status"
      tone="accent"
      icon={<Spinner size={22} />}
      title="Opening repository"
      description={<span className="mono">{displayPath(path)}</span>}
    />
  );
}

const ERROR_TITLE: Partial<Record<GitError["kind"], string>> = {
  notARepository: "Not a Git repository",
  pathNotFound: "Folder not found",
  notADirectory: "Not a folder",
  bareRepository: "Bare repository",
  insideGitDir: "Git directory selected",
  unsafeRepository: "Repository not trusted by Git",
  gitNotFound: "Git is not installed",
  gitTooOld: "Git is too old",
  timeout: "Git took too long",
  notDesktop: "Desktop shell required",
};

const ERROR_HINT: Partial<Record<GitError["kind"], ReactNode>> = {
  notARepository: (
    <>
      Choose a folder that contains a Git repository, or initialize one with{" "}
      <code className="mono">git init</code>.
    </>
  ),
  pathNotFound: "The folder may have been moved or deleted.",
  unsafeRepository: (
    <>
      If you trust this repository, run{" "}
      <code className="mono selectable">git config --global --add safe.directory &lt;path&gt;</code>{" "}
      and try again.
    </>
  ),
  timeout: "The repository may be very large or on a slow drive. Try again.",
};

export function RepositoryErrorView({
  path,
  error,
  isRecent,
  onRetry,
  onOpen,
  onForget,
}: {
  path: string;
  error: GitError;
  isRecent: boolean;
  onRetry: () => void;
  onOpen: () => void;
  onForget: () => void;
}) {
  const hint = ERROR_HINT[error.kind];
  return (
    <EmptyState
      role="alert"
      tone="error"
      icon={<CircleAlert size={22} aria-hidden />}
      title={ERROR_TITLE[error.kind] ?? "Could not open repository"}
      description={
        <div className="bl-repo-error">
          <p>{error.message}</p>
          {hint && <p className="text-small">{hint}</p>}
          <p className="mono bl-repo-error__path selectable">{displayPath(path)}</p>
          {error.detail && (
            <details className="bl-repo-error__details">
              <summary>Git output</summary>
              <pre className="mono selectable">{error.detail}</pre>
            </details>
          )}
        </div>
      }
    >
      <Button variant="primary" icon={<RefreshCw size={16} aria-hidden />} onClick={onRetry}>
        Try again
      </Button>
      <Button icon={<FolderOpen size={16} aria-hidden />} onClick={onOpen}>
        Open another folder
      </Button>
      {isRecent && (
        <Button variant="ghost" icon={<X size={16} aria-hidden />} onClick={onForget}>
          Remove from recent
        </Button>
      )}
    </EmptyState>
  );
}
