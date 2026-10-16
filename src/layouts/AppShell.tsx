import type { ReactNode } from "react";
import { Splitter } from "../components/Splitter";
import { useRemoteActions } from "../features/remote/RemoteActions";
import type { RepositoryController } from "../features/repository/useRepository";
import { usePersistentNumber } from "../lib/usePersistentNumber";
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
  view,
  onView,
  children,
}: {
  controller: RepositoryController;
  gitVersion: GitVersion | GitError | null;
  onOpen: () => void;
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
  children: ReactNode;
}) {
  const remote = useRemoteActions();
  const [sidebarWidth, setSidebarWidth] = usePersistentNumber(
    "branchline.layout.sidebarWidth",
    240,
  );
  return (
    <div className="bl-app">
      <TitleBar controller={controller} onOpen={onOpen} onShowBranches={() => onView("branches")} />
      <div className="bl-app__body">
        <Sidebar
          controller={controller}
          onOpen={onOpen}
          width={sidebarWidth}
          view={view}
          onView={onView}
        />
        <Splitter
          label="Resize sidebar"
          value={sidebarWidth}
          min={180}
          max={420}
          side="left"
          onChange={setSidebarWidth}
        />
        <main className="bl-app__workspace">{children}</main>
      </div>
      <StatusBar
        state={controller.state}
        operation={controller.operation}
        network={remote.activity}
        onCancelNetwork={remote.cancel}
        gitVersion={gitVersion}
      />
    </div>
  );
}
