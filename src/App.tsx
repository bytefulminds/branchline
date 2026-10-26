import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ToastProvider, useToast } from "./components/Toast";
import { ChangesView } from "./features/changes/ChangesView";
import {
  RepositoryErrorView,
  RepositoryLoading,
} from "./features/repository/RepositoryStatusViews";
import { useRepository } from "./features/repository/useRepository";
import { WelcomeView } from "./features/repository/WelcomeView";
import { CloneDialog, parentOf } from "./features/repository/CloneDialog";
import { SettingsProvider, useSettings } from "./features/settings/SettingsProvider";
import { SettingsView, type SettingsSection } from "./features/settings/SettingsView";
import { InitDialog } from "./features/repository/InitDialog";
import { separatorOf } from "./features/worktrees/WorktreeDialog";
import { BranchActionsProvider } from "./features/branches/BranchActions";
import { BranchesView } from "./features/branches/BranchesView";
import { HistoryView, showFileHistory } from "./features/history/HistoryView";
import { FileHistoryProvider } from "./features/history/fileHistory";
import { IntegrateActionsProvider } from "./features/integrate/IntegrateActions";
import { RemoteActionsProvider } from "./features/remote/RemoteActions";
import { StashActionsProvider } from "./features/stash/StashActions";
import { StashesView } from "./features/stash/StashesView";
import { TagActionsProvider } from "./features/tags/TagActions";
import { RemotesView } from "./features/remote/RemotesView";
import { TagsView } from "./features/tags/TagsView";
import { WorktreeActionsProvider } from "./features/worktrees/WorktreeActions";
import { WorktreesView } from "./features/worktrees/WorktreesView";
import { ContextMenuProvider } from "./components/ContextMenu";
import { AppShell } from "./layouts/AppShell";
import { AppCommandPalette, type AppCommandHandlers } from "./features/commands/AppCommands";
import { GitConsoleProvider, useGitConsole } from "./features/console/GitConsoleProvider";
import { ShortcutsDialog } from "./features/commands/ShortcutsDialog";
import { useUpdates } from "./features/updates/useUpdates";
import { markFirstFrame, runMeasurement } from "./features/measure/measure";
import type { WorkspaceView } from "./layouts/Sidebar";
import { pickRepositoryFolder } from "./services/dialog";
import { gitService } from "./services/git";
import { isPrimaryModifier } from "./services/platform";
import type { GitError, GitVersion } from "./types/git";

const VIEW_KEYS: Record<string, WorkspaceView> = {
  "1": "changes",
  "2": "history",
  "3": "branches",
  "4": "stashes",
  "5": "tags",
  "6": "worktrees",
  "7": "remotes",
};

function Workspace() {
  const toast = useToast();
  const onRefreshError = useCallback(
    (e: GitError) =>
      toast({ tone: "error", title: "Refresh failed", description: e.detail ?? e.message }),
    [toast],
  );
  const { settings, loaded: settingsLoaded } = useSettings();
  const controller = useRepository(onRefreshError, {
    refreshOnFocus: settings.general.refreshOnFocus,
  });
  const gitConsole = useGitConsole();
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [overlay, setOverlay] = useState<"palette" | "shortcuts" | null>(null);
  const [gitVersion, setGitVersion] = useState<GitVersion | GitError | null>(null);
  const [view, setView] = useState<WorkspaceView>("changes");
  const [creating, setCreating] = useState<"clone" | "init" | null>(null);
  const { state, open, refresh } = controller;

  // `branchline <path>` opens that repository on startup; otherwise, when the
  // setting is on, the most recent one.
  const started = useRef(false);
  const lastRecent = controller.recent[0]?.path ?? null;
  const openLast = settings.general.openLastRepository;
  useEffect(() => {
    if (!settingsLoaded || started.current) return;
    started.current = true;
    gitService
      .launchRepositoryPath()
      .then((path) => {
        if (path) void open(path);
        else if (openLast && lastRecent) void open(lastRecent);
      })
      .catch(() => {});
  }, [open, settingsLoaded, openLast, lastRecent]);

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
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (
        isPrimaryModifier(e) &&
        !e.altKey &&
        ((key === "k" && !e.shiftKey) || (key === "p" && e.shiftKey))
      ) {
        e.preventDefault();
        setOverlay((o) => (o === "palette" ? null : "palette"));
      } else if (
        (isPrimaryModifier(e) && !e.altKey && e.key === "/") ||
        (e.key === "?" && !typing)
      ) {
        e.preventDefault();
        setOverlay("shortcuts");
      } else if (isPrimaryModifier(e) && !e.shiftKey && !e.altKey && key === "o") {
        e.preventDefault();
        void openPicker();
      } else if (isPrimaryModifier(e) && !e.shiftKey && !e.altKey && key in VIEW_KEYS) {
        e.preventDefault();
        setView(VIEW_KEYS[key]!);
      } else if (isPrimaryModifier(e) && !e.shiftKey && !e.altKey && key === "j") {
        e.preventDefault();
        gitConsole.toggle();
      } else if (isPrimaryModifier(e) && !e.shiftKey && !e.altKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen("general");
      } else if ((isPrimaryModifier(e) && key === "r") || e.key === "F5") {
        // Also suppresses the webview's own page reload.
        e.preventDefault();
        void refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPicker, refresh, gitConsole]);

  const updates = useUpdates();

  // `--measure-startup=<file>`: time the first frame and a few interactions, then quit.
  const firstFrame = useRef<Promise<number | null> | null>(null);
  firstFrame.current ??= markFirstFrame();
  const measured = useRef(false);
  useEffect(() => {
    if (state.status !== "ready" || measured.current) return;
    measured.current = true;
    void firstFrame.current?.then((ms) => {
      if (ms === null) return;
      void runMeasurement(
        {
          setView,
          openPalette: () => setOverlay("palette"),
          closePalette: () => setOverlay(null),
        },
        ms,
      );
    });
  }, [state.status]);
  const commandHandlers = useMemo<AppCommandHandlers>(
    () => ({
      onView: setView,
      onOpen: () => void openPicker(),
      onClone: () => setCreating("clone"),
      onCreate: () => setCreating("init"),
      onSettings: () => setSettingsOpen("general"),
      onShortcuts: () => setOverlay("shortcuts"),
      onAbout: () => setSettingsOpen("about"),
      onCheckForUpdates: () => void updates.check({ quiet: false }),
      onToggleConsole: gitConsole.toggle,
    }),
    [openPicker, updates, gitConsole.toggle],
  );

  // New clones and repositories go next to the most recent one by default.
  const defaultParent = controller.recent[0] ? parentOf(controller.recent[0].path) : "";

  let content;
  switch (state.status) {
    case "idle":
      content = (
        <WelcomeView
          controller={controller}
          onOpen={openPicker}
          onClone={() => setCreating("clone")}
          onCreate={() => setCreating("init")}
          gitVersion={gitVersion}
        />
      );
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
        ) : view === "remotes" ? (
          <RemotesView busy={controller.operation !== null} />
        ) : view === "worktrees" ? (
          <WorktreesView repo={state.repo} busy={controller.operation !== null} />
        ) : view === "tags" ? (
          <TagsView key={state.repo.path} repo={state.repo} busy={controller.operation !== null} />
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
          <IntegrateActionsProvider
            repo={state.status === "ready" ? state.repo : null}
            controller={controller}
            onShowChanges={() => setView("changes")}
          >
            <TagActionsProvider
              repo={state.status === "ready" ? state.repo : null}
              controller={controller}
            >
              <WorktreeActionsProvider
                repo={state.status === "ready" ? state.repo : null}
                controller={controller}
              >
                <AppShell
                  controller={controller}
                  gitVersion={gitVersion}
                  onOpen={openPicker}
                  onClone={() => setCreating("clone")}
                  onCreate={() => setCreating("init")}
                  onSettings={() => setSettingsOpen("general")}
                  onCommands={() => setOverlay("palette")}
                  view={view}
                  onView={setView}
                >
                  <FileHistoryProvider
                    value={
                      state.status === "ready"
                        ? (path: string) => {
                            showFileHistory(state.repo.path, path);
                            setView("history");
                          }
                        : null
                    }
                  >
                    {content}
                  </FileHistoryProvider>
                </AppShell>
                {overlay === "palette" && (
                  <AppCommandPalette
                    controller={controller}
                    handlers={commandHandlers}
                    onClose={() => setOverlay(null)}
                  />
                )}
                {overlay === "shortcuts" && <ShortcutsDialog onClose={() => setOverlay(null)} />}
                {settingsOpen && (
                  <SettingsView
                    repoPath={state.status === "ready" ? state.repo.path : null}
                    repoName={state.status === "ready" ? state.repo.name : ""}
                    initialSection={settingsOpen}
                    onClose={() => setSettingsOpen(null)}
                    onCheckForUpdates={() => void updates.check({ quiet: false })}
                  />
                )}
                {creating === "clone" && (
                  <CloneDialog
                    defaultParent={defaultParent}
                    onCancel={() => setCreating(null)}
                    onDone={(path) => {
                      setCreating(null);
                      toast({ tone: "success", title: "Cloned", description: path });
                      void open(path);
                    }}
                  />
                )}
                {creating === "init" && (
                  <InitDialog
                    defaultFolder={
                      defaultParent ? `${defaultParent}${separatorOf(defaultParent)}` : ""
                    }
                    onCancel={() => setCreating(null)}
                    onDone={(path) => {
                      setCreating(null);
                      toast({ tone: "success", title: "Created a repository", description: path });
                      void open(path);
                    }}
                  />
                )}
              </WorktreeActionsProvider>
            </TagActionsProvider>
          </IntegrateActionsProvider>
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
          <SettingsProvider>
            <GitConsoleProvider>
              <Workspace />
            </GitConsoleProvider>
          </SettingsProvider>
        </ContextMenuProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
