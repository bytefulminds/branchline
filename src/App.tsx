import { useCallback, useEffect, useState } from "react";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ToastProvider, useToast } from "./components/Toast";
import { ChangesView } from "./features/changes/ChangesView";
import {
  RepositoryErrorView,
  RepositoryLoading,
} from "./features/repository/RepositoryStatusViews";
import { useRepository } from "./features/repository/useRepository";
import { WelcomeView } from "./features/repository/WelcomeView";
import { BranchActionsProvider } from "./features/branches/BranchActions";
import { BranchesView } from "./features/branches/BranchesView";
import { HistoryView } from "./features/history/HistoryView";
import { RemoteActionsProvider } from "./features/remote/RemoteActions";
import { StashActionsProvider } from "./features/stash/StashActions";
import { StashesView } from "./features/stash/StashesView";
import { ContextMenuProvider } from "./components/ContextMenu";
import { AppShell } from "./layouts/AppShell";
import type { WorkspaceView } from "./layouts/Sidebar";
import { pickRepositoryFolder } from "./services/dialog";
import { gitService } from "./services/git";
import { isPrimaryModifier } from "./services/platform";
import type { GitError, GitVersion } from "./types/git";

function Workspace() {
  const toast = useToast();
  const onRefreshError = useCallback(
    (e: GitError) =>
      toast({ tone: "error", title: "Refresh failed", description: e.detail ?? e.message }),
    [toast],
  );
  const controller = useRepository(onRefreshError);
  const [gitVersion, setGitVersion] = useState<GitVersion | GitError | null>(null);
  const [view, setView] = useState<WorkspaceView>("changes");
  const { state, open, refresh } = controller;

  // `branchline <path>` opens that repository on startup.
  useEffect(() => {
    gitService
      .launchRepositoryPath()
      .then((path) => {
        if (path) void open(path);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    gitService
      .version()
      .then(setGitVersion)
      .catch((e: GitError) => setGitVersion(e.kind === "notDesktop" ? null : e));
  }, []);

  const openPicker = useCallback(async () => {
    try {
      const path = await pickRepositoryFolder();
      if (path) await open(path);
    } catch (e) {
      toast({ tone: "error", title: "Could not open the folder picker", description: String(e) });
    }
  }, [open, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (isPrimaryModifier(e) && !e.shiftKey && !e.altKey && key === "o") {
        e.preventDefault();
        void openPicker();
      } else if (
        isPrimaryModifier(e) &&
        !e.shiftKey &&
        !e.altKey &&
        (key === "1" || key === "2" || key === "3" || key === "4")
      ) {
        e.preventDefault();
        setView(
          key === "1" ? "changes" : key === "2" ? "history" : key === "3" ? "branches" : "stashes",
        );
      } else if ((isPrimaryModifier(e) && key === "r") || e.key === "F5") {
        // Also suppresses the webview's own page reload.
        e.preventDefault();
        void refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPicker, refresh]);

  let content;
  switch (state.status) {
    case "idle":
      content = <WelcomeView controller={controller} onOpen={openPicker} gitVersion={gitVersion} />;
      break;
    case "loading":
      content = <RepositoryLoading path={state.path} />;
      break;
    case "error":
      content = (
        <RepositoryErrorView
          path={state.path}
          error={state.error}
          isRecent={controller.recent.some((r) => r.path === state.path)}
          onRetry={() => void refresh()}
          onOpen={openPicker}
          onForget={() => {
            controller.forgetRecent(state.path);
            controller.close();
          }}
        />
      );
      break;
    case "ready":
      content =
        view === "history" ? (
          <HistoryView
            key={state.repo.path}
            repo={state.repo}
            onShowChanges={() => setView("changes")}
          />
        ) : view === "branches" ? (
          <BranchesView key={state.repo.path} repo={state.repo} />
        ) : view === "stashes" ? (
          <StashesView
            key={state.repo.path}
            repo={state.repo}
            busy={controller.operation !== null}
          />
        ) : (
          <ChangesView key={state.repo.path} repo={state.repo} controller={controller} />
        );
      break;
  }

  return (
    <BranchActionsProvider
      repo={state.status === "ready" ? state.repo : null}
      controller={controller}
    >
      <RemoteActionsProvider
        repo={state.status === "ready" ? state.repo : null}
        controller={controller}
        onShowChanges={() => setView("changes")}
      >
        <StashActionsProvider
          repo={state.status === "ready" ? state.repo : null}
          controller={controller}
          onShowChanges={() => setView("changes")}
        >
          <AppShell
            controller={controller}
            gitVersion={gitVersion}
            onOpen={openPicker}
            view={view}
            onView={setView}
          >
            {content}
          </AppShell>
        </StashActionsProvider>
      </RemoteActionsProvider>
    </BranchActionsProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <ContextMenuProvider>
          <Workspace />
        </ContextMenuProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
