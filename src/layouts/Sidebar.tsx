import {
  Archive,
  Cloud,
  FileDiff,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  History,
  Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import { Count } from "../components/Badge";
import {
  currentRepositoryPath,
  type RepositoryController,
} from "../features/repository/useRepository";
import { displayPath } from "../lib/format";
import { modKeyLabel } from "../services/platform";
import "./Sidebar.css";

export type WorkspaceView = "changes" | "history";

const MAX_SIDEBAR_RECENT = 6;

function NavItem({
  icon,
  label,
  active,
  disabled,
  count,
  countTone,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  count?: number;
  countTone?: "accent" | "error" | "neutral";
  title?: string;
  onClick?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="bl-nav-item"
        aria-current={active ? "page" : undefined}
        aria-disabled={disabled || undefined}
        title={title}
        onClick={disabled ? undefined : onClick}
      >
        <span className="bl-nav-item__icon">{icon}</span>
        <span className="bl-nav-item__label truncate">{label}</span>
        {count !== undefined && <Count value={count} tone={countTone} />}
      </button>
    </li>
  );
}

/** Repository areas planned for later milestones. Shown disabled, never with fake data. */
const UPCOMING: { label: string; icon: ReactNode }[] = [
  { label: "Branches", icon: <GitBranch size={16} /> },
  { label: "Tags", icon: <Tag size={16} /> },
  { label: "Remotes", icon: <Cloud size={16} /> },
  { label: "Stashes", icon: <Archive size={16} /> },
  { label: "Worktrees", icon: <FolderTree size={16} /> },
];

export function Sidebar({
  controller,
  onOpen,
  width,
  view,
  onView,
}: {
  controller: RepositoryController;
  onOpen: () => void;
  width: number;
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
}) {
  const { state, recent } = controller;
  const repo = state.status === "ready" ? state.repo : null;
  const currentPath = currentRepositoryPath(state);
  const conflicts = repo?.changes.filter((c) => c.conflict).length ?? 0;

  return (
    <nav className="bl-sidebar" style={{ width }} aria-label="Repository navigation">
      <section className="bl-sidebar__section" aria-labelledby="sb-repos">
        <h2 id="sb-repos" className="bl-sidebar__heading">
          Repositories
        </h2>
        <ul className="bl-sidebar__list">
          <NavItem
            icon={<FolderOpen size={16} />}
            label="Open repository…"
            title={`Open repository (${modKeyLabel}O)`}
            onClick={onOpen}
          />
          {recent.slice(0, MAX_SIDEBAR_RECENT).map((r) => (
            <NavItem
              key={r.path}
              icon={<History size={16} />}
              label={r.name}
              title={displayPath(r.path)}
              active={r.path === currentPath}
              onClick={() => void controller.open(r.path)}
            />
          ))}
        </ul>
      </section>

      {repo && (
        <section className="bl-sidebar__section" aria-labelledby="sb-current">
          <h2 id="sb-current" className="bl-sidebar__heading truncate" title={repo.path}>
            {repo.name}
          </h2>
          <ul className="bl-sidebar__list">
            <NavItem
              icon={<FileDiff size={16} />}
              label="Changes"
              title={`Changes (${modKeyLabel}1)`}
              active={view === "changes"}
              onClick={() => onView("changes")}
              count={repo.totalChanges}
              countTone={conflicts > 0 ? "error" : repo.totalChanges > 0 ? "accent" : "neutral"}
            />
            <NavItem
              icon={<GitCommitHorizontal size={16} />}
              label="History"
              title={`History (${modKeyLabel}2)`}
              active={view === "history"}
              onClick={() => onView("history")}
            />
            {UPCOMING.map((item) => (
              <NavItem
                key={item.label}
                icon={item.icon}
                label={item.label}
                disabled
                title={`${item.label}: planned for a later milestone`}
              />
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
