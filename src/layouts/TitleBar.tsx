import {
  ChevronDown,
  FolderGit2,
  FolderOpen,
  GitBranch,
  History,
  RefreshCw,
  X,
} from "lucide-react";
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

export function TitleBar({
  controller,
  onOpen,
}: {
  controller: RepositoryController;
  onOpen: () => void;
}) {
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

      {head && (
        <div className="bl-branch-pill" title={head.title}>
          <GitBranch size={14} aria-hidden />
          <span className={`truncate${head.mono ? " mono" : ""}`}>{head.text}</span>
          {head.qualifier && <span className="bl-branch-pill__qualifier">{head.qualifier}</span>}
        </div>
      )}

      <div className="bl-titlebar__spacer" data-tauri-drag-region />

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
