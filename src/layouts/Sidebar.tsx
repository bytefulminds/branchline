import {
  Archive,
  FileDiff,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import { Count } from "../components/Badge";
import {
  currentRepositoryPath,
  type RepositoryController,
} from "../features/repository/useRepository";
import { useReviews } from "../features/reviews/ReviewsProvider";
import { useTagActions } from "../features/tags/TagActions";
import { useWorktreeActions } from "../features/worktrees/WorktreeActions";
import { displayPath } from "../lib/format";
import { modKeyLabel } from "../services/platform";
import { trackedChangeCount } from "../features/changes/changeModel";
import "./Sidebar.css";

export type WorkspaceView =
  "changes" | "history" | "branches" | "stashes" | "tags" | "worktrees" | "reviews";

const MAX_SIDEBAR_RECENT = 6;

function NavItem({
  icon,
  label,
  active,
  disabled,
  count,
  countTone,
  extra,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  count?: number;
  countTone?: "accent" | "error" | "neutral";
  /** A second, quieter count after the first, such as untracked files. */
  extra?: { value: number; label: string };
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
        title={title ?? label}
        onClick={disabled ? undefined : onClick}
      >
        <span className="bl-nav-item__icon">{icon}</span>
        <span className="bl-nav-item__label truncate">{label}</span>
        {count !== undefined && <Count value={count} tone={countTone} />}
        {extra && extra.value > 0 && (
          <span className="bl-count bl-count--neutral bl-count--extra" title={extra.label}>
            +{extra.value.toLocaleString()}
            <span className="visually-hidden"> {extra.label}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/** Width of the collapsed sidebar: icons only. */
export const COLLAPSED_SIDEBAR_WIDTH = 52;

export function Sidebar({
  controller,
  onOpen,
  width,
  collapsed = false,
  onToggleCollapsed,
  view,
  onView,
  resizer,
}: {
  controller: RepositoryController;
  onOpen: () => void;
  width: number;
  /** Icons only, to make room for the workspace. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
  /** The divider that resizes the sidebar, kept inside its landmark. */
  resizer?: React.ReactNode;
}) {
  const { state, recent } = controller;
  const repo = state.status === "ready" ? state.repo : null;
  const currentPath = currentRepositoryPath(state);
  const conflicts = repo?.changes.filter((c) => c.conflict).length ?? 0;
  // Untracked files are left out: the Changes view lists them in a group of their own.
  const changed = repo ? trackedChangeCount(repo.changes) : 0;
  const untracked = repo?.changes.filter((c) => c.worktreeStatus === "untracked").length ?? 0;
  const { tags } = useTagActions();
  const { worktrees } = useWorktreeActions();
  const reviews = useReviews();
  const reviewCount = reviews.toReview || undefined;

  return (
    <nav className="bl-sidebar-frame" aria-label="Repository navigation">
      <div
        className={`bl-sidebar${collapsed ? " bl-sidebar--collapsed" : ""}`}
        style={{ width: collapsed ? COLLAPSED_SIDEBAR_WIDTH : width }}
      >
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
            {(collapsed ? [] : recent.slice(0, MAX_SIDEBAR_RECENT)).map((r) => (
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
                count={changed}
                extra={
                  untracked > 0
                    ? {
                        value: untracked,
                        label: untracked === 1 ? "untracked file" : "untracked files",
                      }
                    : undefined
                }
                countTone={conflicts > 0 ? "error" : changed > 0 ? "accent" : "neutral"}
              />
              <NavItem
                icon={<GitCommitHorizontal size={16} />}
                label="History"
                title={`History (${modKeyLabel}2)`}
                active={view === "history"}
                onClick={() => onView("history")}
              />
              <NavItem
                icon={<GitBranch size={16} />}
                label="Branches"
                title={`Branches (${modKeyLabel}3)`}
                active={view === "branches"}
                onClick={() => onView("branches")}
              />
              <NavItem
                icon={<Archive size={16} />}
                label="Stashes"
                title={`Stashes (${modKeyLabel}4)`}
                active={view === "stashes"}
                onClick={() => onView("stashes")}
                count={repo.stashCount || undefined}
              />
              <NavItem
                icon={<Tag size={16} />}
                label="Tags"
                title={`Tags (${modKeyLabel}5)`}
                active={view === "tags"}
                onClick={() => onView("tags")}
                count={tags?.length || undefined}
              />
              <NavItem
                icon={<FolderTree size={16} />}
                label="Worktrees"
                title={`Worktrees (${modKeyLabel}6)`}
                active={view === "worktrees"}
                onClick={() => onView("worktrees")}
                count={worktrees && worktrees.length > 1 ? worktrees.length : undefined}
              />
              {reviews.available && (
                <NavItem
                  icon={<GitPullRequest size={16} />}
                  label="Reviews"
                  title={`Merge requests to review (${modKeyLabel}7)`}
                  active={view === "reviews"}
                  onClick={() => onView("reviews")}
                  count={reviewCount}
                />
              )}
            </ul>
          </section>
        )}
        {onToggleCollapsed && (
          <div className="bl-sidebar__footer">
            <button
              type="button"
              className="bl-nav-item bl-sidebar__collapse"
              title={`${collapsed ? "Expand" : "Collapse"} sidebar (${modKeyLabel}B)`}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              <span className="bl-nav-item__icon" aria-hidden>
                {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </span>
              <span className="bl-nav-item__label truncate">
                {collapsed ? "Expand sidebar" : "Collapse sidebar"}
              </span>
            </button>
          </div>
        )}
      </div>
      {!collapsed && resizer}
    </nav>
  );
}
