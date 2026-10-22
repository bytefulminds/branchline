import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  Cloud,
  FolderInput,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { anchorOf, useContextMenu } from "../../components/ContextMenu";
import { EmptyState } from "../../components/EmptyState";
import type { MenuEntry } from "../../components/Menu";
import { Spinner } from "../../components/Spinner";
import { displayPath, relativeTime } from "../../lib/format";
import type { BranchInfo, RepositoryInfo } from "../../types/git";
import { useIntegrateActions } from "../integrate/IntegrateActions";
import { refDragProps, useRefDrop } from "../integrate/refDrag";
import { useRemoteActions } from "../remote/RemoteActions";
import { useWorktreeActions } from "../worktrees/WorktreeActions";
import { useBranchActions } from "./BranchActions";
import "./BranchesView.css";

function Tracking({ branch }: { branch: BranchInfo }) {
  if (!branch.upstream) return <span className="text-muted">No upstream</span>;
  if (branch.upstreamGone)
    return (
      <span className="bl-branch__gone" title={`${branch.upstream} no longer exists`}>
        <Unplug size={12} aria-hidden /> {branch.upstream} gone
      </span>
    );
  return (
    <span
      className="bl-branch__tracking"
      title={`${branch.ahead} ahead, ${branch.behind} behind ${branch.upstream}`}
    >
      <span className="mono">{branch.upstream}</span>
      {branch.ahead > 0 && (
        <span className="bl-branch__count">
          <ArrowUp size={11} aria-hidden />
          <span aria-label={`${branch.ahead} ahead`}>{branch.ahead}</span>
        </span>
      )}
      {branch.behind > 0 && (
        <span className="bl-branch__count">
          <ArrowDown size={11} aria-hidden />
          <span aria-label={`${branch.behind} behind`}>{branch.behind}</span>
        </span>
      )}
    </span>
  );
}

export function BranchesView({ repo }: { repo: RepositoryInfo }) {
  const actions = useBranchActions();
  const worktrees = useWorktreeActions();
  const remote = useRemoteActions();
  const integrate = useIntegrateActions();
  const drop = useRefDrop(repo);
  const showMenu = useContextMenu();
  const [query, setQuery] = useState("");
  const { branches } = actions;

  const q = query.trim().toLowerCase();
  const local = useMemo(
    () => (branches?.local ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)),
    [branches, q],
  );
  const remotes = useMemo(() => {
    const groups = new Map<string, BranchInfo[]>();
    for (const b of branches?.remote ?? []) {
      if (q && !b.name.toLowerCase().includes(q)) continue;
      const key = b.remote ?? "remote";
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    return [...groups.entries()];
  }, [branches, q]);

  const current = repo.head.kind === "branch" ? repo.head.name : null;
  const integrateEntries = (b: BranchInfo): MenuEntry[] => [
    {
      id: "merge",
      label: current ? `Merge into ${current}…` : "Merge into current…",
      icon: <GitMerge size={16} />,
      disabled: b.isCurrent || repo.head.kind === "unborn" || repo.operation !== null,
      onSelect: () => integrate.merge({ kind: "branch", name: b.name }, b.name),
    },
    {
      id: "rebase",
      label: current ? `Rebase ${current} onto this…` : "Rebase onto this…",
      icon: <GitPullRequestArrow size={16} />,
      disabled: b.isCurrent || !current || repo.operation !== null,
      onSelect: () => integrate.rebase({ kind: "branch", name: b.name }, b.name),
    },
  ];
  const localMenu = (b: BranchInfo): MenuEntry[] => [
    b.worktreePath
      ? {
          id: "open-worktree",
          label: "Open its worktree",
          description: displayPath(b.worktreePath),
          icon: <FolderInput size={16} />,
          onSelect: () => worktrees.open(b.worktreePath!),
        }
      : {
          id: "switch",
          label: "Switch to branch",
          icon: <Check size={16} />,
          disabled: b.isCurrent,
          onSelect: () => actions.switchTo(b.name),
        },
    {
      id: "worktree",
      label: "Open in new worktree…",
      description: "Work on it in a second folder",
      icon: <FolderPlus size={16} />,
      disabled: b.isCurrent || !!b.worktreePath,
      onSelect: () => worktrees.create({ mode: "branch", branch: b.name }),
    },
    {
      id: "create",
      label: "Create branch from here…",
      icon: <GitBranchPlus size={16} />,
      onSelect: () => actions.create({ kind: "branch", name: b.name }, b.name),
    },
    ...integrateEntries(b),
    { type: "separator", id: "sep-integrate" },
    {
      id: "push",
      label: b.upstream ? `Push to ${b.upstream}` : "Publish branch…",
      icon: <ArrowUpFromLine size={16} />,
      disabled: remote.activity !== null || (!b.upstream && remote.remotes.length === 0),
      onSelect: () => remote.pushBranch(b.name, b.upstream),
    },
    {
      id: "rename",
      label: "Rename…",
      icon: <Pencil size={16} />,
      onSelect: () => actions.rename(b.name),
    },
    { type: "separator", id: "sep" },
    {
      id: "delete",
      label: "Delete…",
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: b.isCurrent || !!b.worktreePath,
      onSelect: () => actions.remove(b.name),
    },
  ];
  const remoteMenu = (b: BranchInfo): MenuEntry[] => [
    {
      id: "checkout",
      label: "Check out as local branch",
      icon: <Check size={16} />,
      onSelect: () => actions.checkoutRemote(b.name),
    },
    {
      id: "create",
      label: "Create branch from here…",
      icon: <GitBranchPlus size={16} />,
      onSelect: () => actions.create({ kind: "branch", name: b.name }, b.name),
    },
    {
      id: "worktree",
      label: "Check out in new worktree…",
      icon: <FolderPlus size={16} />,
      onSelect: () =>
        worktrees.create({
          mode: "new",
          start: { kind: "branch", name: b.name },
          startLabel: b.name,
          name: b.name.slice((b.remote?.length ?? 0) + 1),
        }),
    },
    { type: "separator", id: "sep" },
    ...integrateEntries(b),
  ];

  const row = (b: BranchInfo, entries: MenuEntry[], primary: () => void, remote: boolean) => (
    <li
      key={b.name}
      className={`bl-branch${b.isCurrent ? " bl-branch--current" : ""}`}
      {...refDragProps({ name: b.name, remote })}
      {...(remote ? {} : drop(`branch:${b.name}`, { kind: "branch", name: b.name }))}
      onDoubleClick={b.worktreePath ? () => worktrees.open(b.worktreePath!) : primary}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu({ x: e.clientX, y: e.clientY }, entries, `Actions for ${b.name}`);
      }}
    >
      <span className="bl-branch__icon" aria-hidden>
        {remote ? <Cloud size={15} /> : b.isCurrent ? <Check size={15} /> : <GitBranch size={15} />}
      </span>
      <span className="bl-branch__main">
        <span className="bl-branch__name">
          <span className="truncate">
            {remote ? b.name.slice((b.remote?.length ?? 0) + 1) : b.name}
          </span>
          {b.isCurrent && <span className="bl-branch__badge">Current</span>}
          {b.worktreePath && (
            <span className="bl-tag-kind" title={`Checked out in ${b.worktreePath}`}>
              worktree
            </span>
          )}
        </span>
        <span className="bl-branch__meta text-small">
          {!remote && <Tracking branch={b} />}
          <span className="truncate text-secondary">{b.tipSummary}</span>
        </span>
      </span>
      <time
        className="bl-branch__time text-small text-muted"
        title={new Date(b.tipTime * 1000).toLocaleString()}
      >
        {relativeTime(b.tipTime * 1000)}
      </time>
      <span className="bl-branch__actions">
        {b.worktreePath ? (
          <Button size="sm" variant="secondary" onClick={() => worktrees.open(b.worktreePath!)}>
            Open worktree
          </Button>
        ) : (
          !b.isCurrent && (
            <Button size="sm" variant="secondary" onClick={primary}>
              {remote ? "Check out" : "Switch"}
            </Button>
          )
        )}
        <button
          type="button"
          className="bl-row-action"
          aria-label={`More actions for ${b.name}`}
          aria-haspopup="menu"
          onClick={(e) => showMenu(anchorOf(e.currentTarget), entries, `Actions for ${b.name}`)}
        >
          <MoreHorizontal size={15} aria-hidden />
        </button>
      </span>
    </li>
  );

  if (!branches) {
    return (
      <div className="bl-history__loading" role="status">
        <Spinner size={18} /> Loading branches…
      </div>
    );
  }

  const headLabel =
    repo.head.kind === "branch"
      ? repo.head.name
      : repo.head.kind === "detached"
        ? `commit ${repo.head.oid.slice(0, 7)}`
        : repo.head.name;

  return (
    <section className="bl-branches" aria-label="Branches">
      <div className="bl-branches__header">
        <div className="bl-branches__title">
          <h1 className="text-h2">Branches</h1>
          <span className="text-small text-secondary">
            {branches.local.length} local · {branches.remote.length} remote
          </span>
        </div>
        <label className="bl-search bl-branches__search">
          <Search size={14} aria-hidden className="bl-search__icon" />
          <span className="visually-hidden">Filter branches</span>
          <input
            type="search"
            placeholder="Filter branches"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="bl-search__clear"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
            >
              <X size={12} aria-hidden />
            </button>
          )}
        </label>
        <Button
          variant="primary"
          icon={<GitBranchPlus size={16} aria-hidden />}
          disabled={repo.head.kind === "unborn"}
          title={
            repo.head.kind === "unborn" ? "Create the first commit before branching" : undefined
          }
          onClick={() => actions.create({ kind: "head" }, headLabel)}
        >
          New branch
        </Button>
      </div>

      <div className="bl-branches__body">
        {repo.head.kind === "detached" && (
          <div className="bl-banner bl-banner--warning" role="status">
            <GitBranch size={16} aria-hidden />
            <span>
              <strong>Detached HEAD</strong> at{" "}
              <span className="mono">{repo.head.oid.slice(0, 7)}</span>. Create a branch to keep new
              commits.
            </span>
          </div>
        )}
        <h2 className="bl-section-label bl-branches__group">Local</h2>
        {local.length ? (
          <ul className="bl-branch-list" aria-label="Local branches">
            {local.map((b) => row(b, localMenu(b), () => actions.switchTo(b.name), false))}
          </ul>
        ) : (
          <p className="bl-branches__empty text-secondary text-small">
            {q
              ? "No local branches match."
              : "No branches yet. Create the first commit to start one."}
          </p>
        )}

        {remotes.map(([remote, list]) => (
          <div key={remote}>
            <h2 className="bl-section-label bl-branches__group">
              <Cloud size={12} aria-hidden /> {remote}
            </h2>
            <ul className="bl-branch-list" aria-label={`Branches on ${remote}`}>
              {list.map((b) => row(b, remoteMenu(b), () => actions.checkoutRemote(b.name), true))}
            </ul>
          </div>
        ))}
        {branches.remote.length === 0 && !q && (
          <EmptyState
            title="No remote branches"
            description="Add a remote and fetch to see its branches here."
          />
        )}
      </div>
    </section>
  );
}
