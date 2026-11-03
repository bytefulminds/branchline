import {
  ArrowDownUp,
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  Cloud,
  CloudDownload,
  Copy,
  FolderInput,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  ListOrdered,
  MoreHorizontal,
  Pencil,
  Plus,
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
import { displayPath, plural, relativeTime } from "../../lib/format";
import { readJson, writeJson } from "../../services/storage";
import type { BranchInfo, RemoteInfo, RepositoryInfo } from "../../types/git";
import { useIntegrateActions } from "../integrate/IntegrateActions";
import { refDragProps, useRefDrop } from "../integrate/refDrag";
import { describeUrl } from "../remote/describeUrl";
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

export type BranchSort = "name" | "date";

const SORT_KEY = "branchline.branches.sort";

/** Branches by name (natural order, so `release-9` comes before `release-10`) or by their
 * last commit, newest first; ties keep name order. The current branch always comes first. */
export function sortBranches(list: BranchInfo[], sort: BranchSort): BranchInfo[] {
  const byName = (a: BranchInfo, b: BranchInfo) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...list].sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      (sort === "date" ? b.tipTime - a.tipTime : 0) ||
      byName(a, b),
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
  const [sort, setSortState] = useState<BranchSort>(() =>
    readJson<unknown>(SORT_KEY, "name") === "date" ? "date" : "name",
  );
  const setSort = (next: BranchSort) => {
    setSortState(next);
    writeJson(SORT_KEY, next);
  };
  const { branches } = actions;

  const q = query.trim().toLowerCase();
  const local = useMemo(
    () =>
      sortBranches(
        (branches?.local ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)),
        sort,
      ),
    [branches, q, sort],
  );
  // One group per remote, in the order Git lists them, also for a remote without fetched
  // branches yet. Remote branches whose remote is gone (not fetched since) get their own group.
  const remotes = useMemo(() => {
    const groups = new Map<string, { info: RemoteInfo | null; all: number; list: BranchInfo[] }>();
    for (const r of remote.remotes) groups.set(r.name, { info: r, all: 0, list: [] });
    for (const b of branches?.remote ?? []) {
      const key = b.remote ?? "remote";
      const group = groups.get(key) ?? { info: null, all: 0, list: [] };
      group.all += 1;
      if (!q || b.name.toLowerCase().includes(q)) group.list.push(b);
      groups.set(key, group);
    }
    return [...groups.entries()]
      .filter(([, g]) => !q || g.list.length > 0)
      .map(([name, g]) => ({ name, ...g, list: sortBranches(g.list, sort) }));
  }, [branches, remote.remotes, q, sort]);
  const tracked = (name: string) =>
    (branches?.local ?? []).filter((b) => b.upstream?.startsWith(`${name}/`)).length;

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
    ...(b.isCurrent && !b.remote
      ? [
          {
            id: "rewrite",
            label: "Rewrite history…",
            description: "Squash, reword, reorder or drop the commits of this branch",
            icon: <ListOrdered size={16} />,
            disabled: repo.operation !== null,
            onSelect: () => integrate.rewriteHistory(),
          },
        ]
      : []),
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

  const busy = repo.operation !== null;
  const networkBusy = remote.activity !== null;
  const remoteHeadMenu = (r: RemoteInfo): MenuEntry[] => [
    {
      id: "fetch",
      label: `Fetch ${r.name}`,
      icon: <CloudDownload size={16} />,
      disabled: networkBusy,
      onSelect: () => remote.fetchRemote(r.name),
    },
    {
      id: "edit",
      label: "Edit remote…",
      description: "Rename or change the address",
      icon: <Pencil size={16} />,
      disabled: busy,
      onSelect: () => remote.editRemote(r),
    },
    {
      id: "copy",
      label: "Copy address",
      icon: <Copy size={16} />,
      onSelect: () => void navigator.clipboard?.writeText(r.url).catch(() => {}),
    },
    {
      id: "add",
      label: "Add remote…",
      icon: <Plus size={16} />,
      disabled: busy,
      onSelect: remote.addRemote,
    },
    { type: "separator", id: "sep" },
    {
      id: "remove",
      label: "Remove remote…",
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: busy || networkBusy,
      onSelect: () => remote.removeRemote(r),
    },
  ];

  /** Heading of a remote's group: name, address and counts, with its actions like a row's. */
  const remoteHead = (name: string, info: RemoteInfo | null, count: number, first: boolean) => {
    const entries = info ? remoteHeadMenu(info) : [];
    const n = tracked(name);
    const label = info ? describeUrl(info.url) : "Remote no longer configured";
    return (
      <div
        className="bl-remote-head"
        onContextMenu={(e) => {
          if (!info) return;
          e.preventDefault();
          showMenu({ x: e.clientX, y: e.clientY }, entries, `Actions for remote ${name}`);
        }}
      >
        <h2 className="bl-section-label bl-remote-head__name">
          <Cloud size={12} aria-hidden /> {name}
        </h2>
        <span
          className="bl-remote-head__meta text-small text-muted truncate"
          title={
            info
              ? [info.url, info.pushUrl && `push: ${info.pushUrl}`].filter(Boolean).join("\n")
              : undefined
          }
        >
          {label} · {plural(count, "branch", "branches")}
          {n > 0 && ` · ${n} tracked`}
        </span>
        <span className="bl-remote-head__actions">
          {first && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={remote.addRemote}>
              Add remote
            </Button>
          )}
          {info && (
            <button
              type="button"
              className="bl-row-action"
              aria-label={`More actions for remote ${name}`}
              aria-haspopup="menu"
              onClick={(e) =>
                showMenu(anchorOf(e.currentTarget), entries, `Actions for remote ${name}`)
              }
            >
              <MoreHorizontal size={15} aria-hidden />
            </button>
          )}
        </span>
      </div>
    );
  };

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
        <label className="bl-branches__sort text-small">
          <ArrowDownUp size={14} aria-hidden />
          <span className="visually-hidden">Sort branches</span>
          <select
            className="bl-input"
            value={sort}
            onChange={(e) => setSort(e.target.value === "date" ? "date" : "name")}
          >
            <option value="name">Name</option>
            <option value="date">Last commit</option>
          </select>
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

        {remotes.map((g, i) => (
          <section key={g.name} aria-label={`Remote ${g.name}`}>
            {remoteHead(g.name, g.info, g.all, i === 0)}
            {g.list.length ? (
              <ul className="bl-branch-list" aria-label={`Branches on ${g.name}`}>
                {g.list.map((b) =>
                  row(b, remoteMenu(b), () => actions.checkoutRemote(b.name), true),
                )}
              </ul>
            ) : (
              <p className="bl-branches__empty text-secondary text-small">
                No branches yet. Fetch {g.name} to see them.
              </p>
            )}
          </section>
        ))}
        {remotes.length === 0 && !q && (
          <EmptyState
            icon={<Cloud size={22} aria-hidden />}
            title="No remotes"
            description="Add a remote, such as a repository on GitHub or GitLab, to fetch, pull and push."
          >
            <Button
              variant="secondary"
              icon={<Plus size={16} aria-hidden />}
              disabled={busy}
              onClick={remote.addRemote}
            >
              Add remote
            </Button>
          </EmptyState>
        )}
      </div>
    </section>
  );
}
