import {
  ChevronDown,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  History,
  ListTree,
  RefreshCw,
  X,
} from "lucide-react";
import { useBranchActions } from "../features/branches/BranchActions";
import { RemoteToolbar } from "../features/remote/RemoteToolbar";
import { StashToolbar } from "../features/stash/StashToolbar";
import { IconButton } from "../components/Button";
import { LogoMark } from "../components/Logo";
import { Menu, type MenuEntry } from "../components/Menu";
import { Spinner } from "../components/Spinner";
import {
  currentRepositoryPath,
  type RepositoryController,
} from "../features/repository/useRepository";
import { headLabel } from "../features/repository/headLabel";
import { displayPath } from "../lib/format";
import { modKeyLabel, platform } from "../services/platform";
import { WindowControls } from "./WindowControls";
import "./TitleBar.css";

/** Most recently active local branches shown in the quick switcher. */
const QUICK_SWITCH_LIMIT = 12;

export function TitleBar({
  controller,
  onOpen,
  onShowBranches,
}: {
  controller: RepositoryController;
  onOpen: () => void;
  onShowBranches: () => void;
}) {
  const branchActions = useBranchActions();
  const { state, recent } = controller;
  const repo = state.status === "ready" ? state.repo : null;
  const busy = state.status === "loading" || (state.status === "ready" && state.refreshing);
  const currentPath = currentRepositoryPath(state);
  const head = repo ? headLabel(repo.head) : null;

  const entries: MenuEntry[] = [
    ...(recent.length
      ? ([{ type: "header", id: "recent-header", label: "Recent repositories" }] as MenuEntry[])
      : []),
    ...recent.map<MenuEntry>((r) => ({
      id: r.path,
      label: r.name,
      description: displayPath(r.path),
      icon: <History size={16} aria-hidden />,
      checked: r.path === currentPath,
      onSelect: () => void controller.open(r.path),
    })),
    ...(recent.length ? ([{ type: "separator", id: "sep" }] as MenuEntry[]) : []),
    {
      id: "open",
      label: "Open repository…",
      icon: <FolderOpen size={16} aria-hidden />,
      shortcut: `${modKeyLabel}O`,
      onSelect: onOpen,
    },
    ...(state.status !== "idle"
      ? [
          {
            id: "close",
            label: "Close repository",
            icon: <X size={16} aria-hidden />,
            onSelect: controller.close,
          } satisfies MenuEntry,
        ]
      : []),
  ];

  const local = [...(branchActions.branches?.local ?? [])]
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.tipTime - a.tipTime)
    .slice(0, QUICK_SWITCH_LIMIT);
  const branchEntries: MenuEntry[] = [
    { type: "header", id: "branches-header", label: "Switch branch" },
    ...local.map<MenuEntry>((b) => ({
      id: `branch:${b.name}`,
      label: b.name,
      description: b.tipSummary,
      icon: <GitBranch size={16} aria-hidden />,
      checked: b.isCurrent,
      onSelect: () => !b.isCurrent && branchActions.switchTo(b.name),
    })),
    ...(local.length === 0
      ? ([{ type: "header", id: "no-branches", label: "No branches yet" }] as MenuEntry[])
      : []),
    { type: "separator", id: "branches-sep" },
    {
      id: "new-branch",
      label: "New branch…",
      icon: <GitBranchPlus size={16} aria-hidden />,
      disabled: repo?.head.kind === "unborn",
      onSelect: () => repo && branchActions.create({ kind: "head" }, head?.text ?? "HEAD"),
    },
    {
      id: "all-branches",
      label: "All branches",
      icon: <ListTree size={16} aria-hidden />,
      shortcut: `${modKeyLabel}3`,
      onSelect: onShowBranches,
    },
  ];

  const selectorLabel =
    repo?.name ??
    (state.status === "loading"
      ? "Opening…"
      : state.status === "error"
        ? "Repository unavailable"
        : "No repository");

  return (
    <header className={`bl-titlebar bl-titlebar--${platform}`} data-tauri-drag-region>
      <div className="bl-titlebar__brand" data-tauri-drag-region>
        <LogoMark size={22} />
        <span className="bl-titlebar__name" data-tauri-drag-region>
          Branchline
        </span>
      </div>

      <div className="bl-titlebar__divider" aria-hidden />

      <Menu
        entries={entries}
        trigger={(props) => (
          <button
            type="button"
            className="bl-repo-selector"
            aria-label={`Repository: ${selectorLabel}`}
            {...props}
          >
            <FolderGit2 size={16} aria-hidden className="bl-repo-selector__icon" />
            <span className="truncate">{selectorLabel}</span>
            <ChevronDown size={14} aria-hidden className="bl-repo-selector__chevron" />
          </button>
        )}
      />

      {head && repo && (
        <Menu
          entries={branchEntries}
          minWidth={280}
          trigger={(props) => (
            <button
              type="button"
              className="bl-branch-pill"
              title={head.title}
              aria-label={`Branch: ${head.text}${head.qualifier ? ` (${head.qualifier})` : ""}. Switch branch`}
              {...props}
            >
              <GitBranch size={14} aria-hidden />
              <span className={`truncate${head.mono ? " mono" : ""}`}>{head.text}</span>
              {head.qualifier && (
                <span className="bl-branch-pill__qualifier">{head.qualifier}</span>
              )}
              <ChevronDown size={12} aria-hidden className="bl-branch-pill__chevron" />
            </button>
          )}
        />
      )}

      <div className="bl-titlebar__spacer" data-tauri-drag-region />

      {repo && <StashToolbar repo={repo} busy={controller.operation !== null} />}
      {repo && <RemoteToolbar repo={repo} busy={controller.operation !== null} />}
      {repo && <div className="bl-titlebar__divider" aria-hidden />}

      {busy && (
        <span className="bl-titlebar__busy">
          <Spinner size={14} label="Working" />
        </span>
      )}
      <IconButton
        label={`Refresh (${modKeyLabel}R)`}
        icon={<RefreshCw size={16} aria-hidden />}
        onClick={() => void controller.refresh()}
        disabled={state.status === "idle" || busy}
      />
      <IconButton
        label={`Open repository (${modKeyLabel}O)`}
        icon={<FolderOpen size={16} aria-hidden />}
        onClick={onOpen}
        data-tooltip-align="end"
      />

      {platform !== "macos" && <WindowControls />}
    </header>
  );
}
