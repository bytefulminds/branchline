import { useCallback, useEffect, useState } from "react";
import { ToastProvider, useToast } from "./components/Toast";
import { ChangesView } from "./features/changes/ChangesView";
import {
  RepositoryErrorView,
  RepositoryLoading,
} from "./features/repository/RepositoryStatusViews";
import { useRepository } from "./features/repository/useRepository";
import { WelcomeView } from "./features/repository/WelcomeView";
import { AppShell } from "./layouts/AppShell";
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
      content = <ChangesView key={state.repo.path} repo={state.repo} />;
      break;
  }

  return (
    <AppShell controller={controller} gitVersion={gitVersion} onOpen={openPicker}>
      {content}
    </AppShell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Workspace />
    </ToastProvider>
  );
}
