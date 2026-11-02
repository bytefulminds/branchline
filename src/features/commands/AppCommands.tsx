import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleX,
  Cloud,
  FileCode,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitFork,
  History,
  Info,
  Keyboard,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SkipForward,
  SquareTerminal,
  Tag,
  Terminal,
  Download,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { gitService } from "../../services/git";
import type { BranchInfo } from "../../types/git";
import type { WorkspaceView } from "../../layouts/Sidebar";
import { useBranchActions } from "../branches/BranchActions";
import { requestHistorySearch } from "../history/HistoryView";
import { useIntegrateActions } from "../integrate/IntegrateActions";
import { useRemoteActions } from "../remote/RemoteActions";
import { FILE_MANAGER, useOpenIn } from "../repository/useOpenIn";
import type { RepositoryController } from "../repository/useRepository";
import { useStashActions } from "../stash/StashActions";
import { useTagActions } from "../tags/TagActions";
import { useWorktreeActions } from "../worktrees/WorktreeActions";
import { CommandPalette, type Command } from "./CommandPalette";
import { SHORTCUTS } from "./shortcuts";

const VIEWS: { view: WorkspaceView; title: string; icon: React.ReactNode }[] = [
  { view: "changes", title: "Changes", icon: <FileCode size={16} /> },
  { view: "history", title: "History", icon: <History size={16} /> },
  { view: "branches", title: "Branches", icon: <GitBranch size={16} /> },
  { view: "stashes", title: "Stashes", icon: <Archive size={16} /> },
  { view: "tags", title: "Tags", icon: <Tag size={16} /> },
  { view: "worktrees", title: "Worktrees", icon: <FolderGit2 size={16} /> },
];

export interface AppCommandHandlers {
  onView: (view: WorkspaceView) => void;
  onOpen: () => void;
  onClone: () => void;
  onCreate: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onAbout: () => void;
  onCheckForUpdates: () => void;
  onToggleConsole: () => void;
}

/** The command palette with every action that makes sense right now. */
export function AppCommandPalette({
  controller,
  handlers,
  onClose,
}: {
  controller: RepositoryController;
  handlers: AppCommandHandlers;
  onClose: () => void;
}) {
  const repo = controller.state.status === "ready" ? controller.state.repo : null;
  const busy = controller.operation !== null;
  const branchActions = useBranchActions();
  const remote = useRemoteActions();
  const stash = useStashActions();
  const tags = useTagActions();
  const worktrees = useWorktreeActions();
  const integrate = useIntegrateActions();
  const openIn = useOpenIn();
  const [branches, setBranches] = useState<BranchInfo[]>([]);

  const repoPath = repo?.path ?? null;
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    gitService
      .listBranches(repoPath)
      .then((list) => !cancelled && setBranches(list.local))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const commands = useMemo(() => {
    const list: Command[] = [];
    const add = (c: Command) => list.push(c);
    const needsRepo = repo ? undefined : "Open a repository first";
    const blocked = needsRepo ?? (busy ? "Wait for the current Git operation" : undefined);
    const head = repo?.head;

    if (repo?.operation) {
      const name = {
        merge: "merge",
        rebase: "rebase",
        cherryPick: "cherry-pick",
        revert: "revert",
        bisect: "bisect",
      }[repo.operation];
      if (repo.operation !== "bisect") {
        add({
          id: "op-continue",
          title: `Continue ${name}`,
          group: "In progress",
          icon: <Play size={16} />,
          disabled: blocked,
          run: () => integrate.step("continue"),
        });
        if (repo.operation !== "merge")
          add({
            id: "op-skip",
            title: `Skip this commit (${name})`,
            group: "In progress",
            icon: <SkipForward size={16} />,
            disabled: blocked,
            run: () => integrate.step("skip"),
          });
        add({
          id: "op-abort",
          title: `Abort ${name}…`,
          group: "In progress",
          icon: <CircleX size={16} />,
          disabled: blocked,
          run: () => integrate.step("abort"),
        });
      }
    }

    for (const v of VIEWS)
      add({
        id: `view-${v.view}`,
        title: `Go to ${v.title}`,
        group: "Go to",
        shortcut: SHORTCUTS[v.view],
        icon: v.icon,
        disabled: needsRepo,
        run: () => handlers.onView(v.view),
      });
    add({
      id: "search-history",
      title: "Search commits…",
      group: "History",
      keywords: "find log filter author file",
      shortcut: SHORTCUTS.searchHistory,
      icon: <Search size={16} />,
      disabled: needsRepo,
      run: () => {
        requestHistorySearch();
        handlers.onView("history");
      },
    });

    if (repo) {
      const unstaged = repo.changes.filter((c) => c.worktreeStatus && !c.conflict);
      const staged = repo.changes.filter((c) => c.indexStatus && !c.conflict);
      const paths = (list: typeof repo.changes) =>
        list.flatMap((c) => (c.originalPath ? [c.originalPath, c.path] : [c.path]));
      add({
        id: "stage-all",
        title: "Stage all changes",
        group: "Changes",
        keywords: "add index",
        icon: <Plus size={16} />,
        disabled: blocked ?? (unstaged.length === 0 ? "Nothing to stage" : undefined),
        run: () =>
          void controller.run("Staging", (path) => gitService.stageFiles(path, paths(unstaged))),
      });
      add({
        id: "unstage-all",
        title: "Unstage all changes",
        group: "Changes",
        keywords: "reset index",
        icon: <Minus size={16} />,
        disabled: blocked ?? (staged.length === 0 ? "Nothing is staged" : undefined),
        run: () =>
          void controller.run("Unstaging", (path) => gitService.unstageFiles(path, paths(staged))),
      });
    }

    add({
      id: "fetch",
      title: "Fetch all remotes",
      group: "Remote",
      icon: <RefreshCw size={16} />,
      disabled: blocked,
      run: remote.fetchAll,
    });
    add({
      id: "pull",
      title: "Pull",
      group: "Remote",
      keywords: "update download",
      icon: <ArrowDownToLine size={16} />,
      disabled: blocked,
      run: () => remote.pull(),
    });
    add({
      id: "pull-rebase",
      title: "Pull with rebase",
      group: "Remote",
      icon: <ArrowDownToLine size={16} />,
      disabled: blocked,
      run: () => remote.pull("rebase"),
    });
    add({
      id: "pull-merge",
      title: "Pull with merge",
      group: "Remote",
      icon: <ArrowDownToLine size={16} />,
      disabled: blocked,
      run: () => remote.pull("merge"),
    });
    add({
      id: "push",
      title: "Push",
      group: "Remote",
      keywords: "upload publish",
      icon: <ArrowUpFromLine size={16} />,
      disabled: blocked,
      run: remote.push,
    });
    add({
      id: "force-push",
      title: "Force push (with lease)…",
      group: "Remote",
      icon: <ArrowUpFromLine size={16} />,
      disabled: blocked,
      run: remote.forcePush,
    });
    add({
      id: "add-remote",
      title: "Add remote…",
      group: "Remote",
      icon: <Cloud size={16} />,
      disabled: needsRepo,
      run: remote.addRemote,
    });

    add({
      id: "new-branch",
      title: "New branch…",
      group: "Branch",
      keywords: "create",
      icon: <GitBranchPlus size={16} />,
      disabled: needsRepo,
      run: () =>
        branchActions.create({ kind: "head" }, head?.kind === "branch" ? head.name : "HEAD"),
    });
    for (const b of branches) {
      if (b.isCurrent) continue;
      add({
        id: `switch-${b.name}`,
        title: `Switch to ${b.name}`,
        group: "Branch",
        keywords: `checkout ${b.tipSummary}`,
        icon: <GitBranch size={16} />,
        disabled: blocked,
        run: () => branchActions.switchTo(b.name),
      });
    }

    add({
      id: "stash",
      title: "Stash changes…",
      group: "Stash",
      keywords: "save shelve",
      icon: <Archive size={16} />,
      disabled: blocked ?? (repo && repo.totalChanges === 0 ? "No changes to stash" : undefined),
      run: stash.save,
    });
    add({
      id: "new-tag",
      title: "New tag on the current commit…",
      group: "Tag",
      keywords: "create release version",
      icon: <Tag size={16} />,
      disabled:
        needsRepo ?? (head?.kind === "unborn" ? "Create the first commit first" : undefined),
      run: () => {
        if (head && head.kind !== "unborn")
          tags.create(head.oid, head.kind === "branch" ? head.name : "HEAD");
      },
    });
    add({
      id: "new-worktree",
      title: "New worktree…",
      group: "Worktree",
      keywords: "folder checkout",
      icon: <FolderPlus size={16} />,
      disabled: blocked,
      run: () => worktrees.create(),
    });

    add({
      id: "open-editor",
      title: "Open repository in editor",
      group: "Repository",
      icon: <FileCode size={16} />,
      disabled: needsRepo,
      run: () => repo && openIn.editor(repo.path, null),
    });
    add({
      id: "open-terminal",
      title: "Open in terminal",
      group: "Repository",
      icon: <Terminal size={16} />,
      disabled: needsRepo,
      run: () => repo && openIn.terminal(repo.path),
    });
    add({
      id: "reveal",
      title: `Show in ${FILE_MANAGER}`,
      group: "Repository",
      icon: <FolderOpen size={16} />,
      disabled: needsRepo,
      run: () => repo && openIn.reveal(repo.path, null),
    });
    add({
      id: "refresh",
      title: "Refresh",
      group: "Repository",
      keywords: "reload status",
      shortcut: SHORTCUTS.refresh,
      icon: <RefreshCw size={16} />,
      disabled: needsRepo,
      run: () => void controller.refresh(),
    });
    add({
      id: "open",
      title: "Open repository…",
      group: "Repository",
      shortcut: SHORTCUTS.open,
      icon: <FolderOpen size={16} />,
      run: handlers.onOpen,
    });
    add({
      id: "clone",
      title: "Clone repository…",
      group: "Repository",
      keywords: "download url",
      icon: <GitFork size={16} />,
      run: handlers.onClone,
    });
    add({
      id: "create",
      title: "Create new repository…",
      group: "Repository",
      keywords: "init",
      icon: <FolderPlus size={16} />,
      run: handlers.onCreate,
    });
    for (const r of controller.recent) {
      if (r.path === repo?.path) continue;
      add({
        id: `recent-${r.path}`,
        title: `Open ${r.name}`,
        group: "Recent",
        keywords: r.path,
        icon: <GitCommitHorizontal size={16} />,
        run: () => void controller.open(r.path),
      });
    }

    add({
      id: "settings",
      title: "Settings",
      group: "Branchline",
      keywords: "preferences options",
      shortcut: SHORTCUTS.settings,
      icon: <Settings size={16} />,
      run: handlers.onSettings,
    });
    add({
      id: "shortcuts",
      title: "Keyboard shortcuts",
      group: "Branchline",
      keywords: "keys help",
      shortcut: SHORTCUTS.shortcuts,
      icon: <Keyboard size={16} />,
      run: handlers.onShortcuts,
    });
    add({
      id: "console",
      title: "Git console",
      group: "Branchline",
      keywords: "log output commands hooks debug terminal",
      shortcut: SHORTCUTS.console,
      icon: <SquareTerminal size={16} />,
      run: handlers.onToggleConsole,
    });
    add({
      id: "updates",
      title: "Check for updates",
      group: "Branchline",
      keywords: "version upgrade",
      icon: <Download size={16} />,
      run: handlers.onCheckForUpdates,
    });
    add({
      id: "about",
      title: "About Branchline",
      group: "Branchline",
      keywords: "version license",
      icon: <Info size={16} />,
      run: handlers.onAbout,
    });
    return list;
  }, [
    repo,
    busy,
    branches,
    controller,
    handlers,
    remote,
    branchActions,
    stash,
    tags,
    worktrees,
    integrate,
    openIn,
  ]);

  return <CommandPalette commands={commands} onClose={onClose} />;
}
