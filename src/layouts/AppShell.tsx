import { useEffect, type ReactNode } from "react";
import { Splitter } from "../components/Splitter";
import { GitConsole } from "../features/console/GitConsole";
import { useGitConsole } from "../features/console/GitConsoleProvider";
import { useRemoteActions } from "../features/remote/RemoteActions";
import type { RepositoryController } from "../features/repository/useRepository";
import { usePersistentFlag } from "../lib/usePersistentFlag";
import { usePersistentNumber } from "../lib/usePersistentNumber";
import { isPrimaryModifier } from "../services/platform";
import type { GitError, GitVersion } from "../types/git";
import { Sidebar, type WorkspaceView } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import "./AppShell.css";

/** The complete window: title bar + toolbar, sidebar, workspace and status bar. */
export function AppShell({
  controller,
  gitVersion,
  onOpen,
  onClone,
  onCreate,
  onSettings,
  onCommands,
  view,
  onView,
  children,
}: {
  controller: RepositoryController;
  gitVersion: GitVersion | GitError | null;
  onOpen: () => void;
  onClone: () => void;
  onCreate: () => void;
  onSettings: () => void;
  onCommands: () => void;
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
  children: ReactNode;
}) {
  const remote = useRemoteActions();
  const gitConsole = useGitConsole();
  const [sidebarWidth, setSidebarWidth] = usePersistentNumber(
    "branchline.layout.sidebarWidth",
    240,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentFlag(
    "branchline.layout.sidebarCollapsed",
    false,
  );
  // Ctrl+B / Cmd+B collapses or expands the sidebar, as in most editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPrimaryModifier(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      setSidebarCollapsed(!sidebarCollapsed);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarCollapsed, setSidebarCollapsed]);
  return (
    <div className="bl-app">
      <TitleBar
        controller={controller}
        onOpen={onOpen}
        onClone={onClone}
        onCreate={onCreate}
        onSettings={onSettings}
        onCommands={onCommands}
        onShowBranches={() => onView("branches")}
      />
      <div className="bl-app__body">
        <Sidebar
          controller={controller}
          onOpen={onOpen}
          width={sidebarWidth}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
          view={view}
          onView={onView}
          resizer={
            <Splitter
              label="Resize sidebar"
              value={sidebarWidth}
              min={180}
              max={420}
              side="left"
              onChange={setSidebarWidth}
            />
          }
        />
        <main className="bl-app__workspace">{children}</main>
      </div>
      {gitConsole.open && <GitConsole />}
      <StatusBar
        consoleOpen={gitConsole.open}
        onToggleConsole={gitConsole.toggle}
        state={controller.state}
        operation={controller.operation}
        network={remote.activity}
        onCancelNetwork={remote.cancel}
        gitVersion={gitVersion}
      />
    </div>
  );
}
