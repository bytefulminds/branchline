import type { ReactNode } from "react";
import { Splitter } from "../components/Splitter";
import type { RepositoryController } from "../features/repository/useRepository";
import { usePersistentNumber } from "../lib/usePersistentNumber";
import type { GitError, GitVersion } from "../types/git";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import "./AppShell.css";

/** The complete window: title bar + toolbar, sidebar, workspace and status bar. */
export function AppShell({
  controller,
  gitVersion,
  onOpen,
  children,
}: {
  controller: RepositoryController;
  gitVersion: GitVersion | GitError | null;
  onOpen: () => void;
  children: ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = usePersistentNumber(
    "branchline.layout.sidebarWidth",
    240,
  );
  return (
    <div className="bl-app">
      <TitleBar controller={controller} onOpen={onOpen} />
      <div className="bl-app__body">
        <Sidebar controller={controller} onOpen={onOpen} width={sidebarWidth} />
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
        gitVersion={gitVersion}
      />
    </div>
  );
}
