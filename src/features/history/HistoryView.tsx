import {
  Check,
  Cherry,
  CircleAlert,
  Copy,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  ListOrdered,
  LogIn,
  Tag,
  Undo2,
  X,
} from "lucide-react";
import { useContextMenu } from "../../components/ContextMenu";
import type { MenuEntry } from "../../components/Menu";
import { useBranchActions } from "../branches/BranchActions";
import { useCallback, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { Splitter } from "../../components/Splitter";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import type { CommitFile, RepositoryInfo } from "../../types/git";
import { CommitDetailsPanel } from "./CommitDetailsPanel";
import { CommitDiffView } from "./CommitDiffView";
import { useTagActions } from "../tags/TagActions";
import { useIntegrateActions } from "../integrate/IntegrateActions";
import { useRefDrop } from "../integrate/refDrag";
import { CommitList, graphColumnWidth, WorkInProgressRow } from "./CommitList";
import { cherryPickProblem, MultiSelectionPanel } from "./MultiSelectionPanel";
import { EMPTY_SELECTION, nextSelection, oldestFirst, single, type SelectMode } from "./selection";
import { useHistory } from "./useHistory";
import "./HistoryView.css";

export function HistoryView({
  repo,
  onShowChanges,
}: {
  repo: RepositoryInfo;
  onShowChanges: () => void;
}) {
  const history = useHistory(repo);
  const branchActions = useBranchActions();
  const showMenu = useContextMenu();
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [openFile, setOpenFile] = useState<{ oid: string; file: CommitFile } | null>(null);
  const [detailsWidth, setDetailsWidth] = usePersistentNumber(
    "branchline.layout.commitDetailsWidth",
    400,
  );
  const { data, loadMore } = history;

  const order = useMemo(() => data?.commits.map((c) => c.oid) ?? [], [data]);
  const select = useCallback(
    (oid: string, mode: SelectMode = "replace") => {
      setSelection((current) =>
        // Nothing chosen yet: the newest commit is the one shown, so ranges start there.
        nextSelection(current.focus || !order[0] ? current : single(order[0]), oid, mode, order),
      );
      setOpenFile(null);
    },
    [order],
  );

  const selected = selection.focus ?? data?.commits[0]?.oid ?? null;
  // Selected commits still in the list (a refresh can remove some), oldest first.
  const picked = useMemo(() => {
    if (!data || selection.oids.size < 2) return [];
    const byOid = new Map(data.commits.map((c) => [c.oid, c]));
    return oldestFirst(selection.oids, order).map((o) => byOid.get(o)!);
  }, [data, order, selection.oids]);
  const mergeOids = useMemo(
    () => new Set(data?.commits.filter((_, i) => data.rows[i]?.isMerge).map((c) => c.oid)),
    [data],
  );
  const clearSelection = useCallback(
    () => setSelection((s) => (s.focus ? single(s.focus) : EMPTY_SELECTION)),
    [],
  );

  const tagActions = useTagActions();
  const integrate = useIntegrateActions();
  const drop = useRefDrop(repo);
  const current = repo.head.kind === "branch" ? repo.head.name : null;
  const busyOp = repo.operation !== null;
  const pickProblem = cherryPickProblem({
    commits: picked,
    mergeOids,
    busy: busyOp,
    unborn: repo.head.kind === "unborn",
  });
  const target = current ?? "the detached HEAD";
  const pickMany = () => {
    integrate.cherryPickMany(picked.map((c) => c.oid));
  };
  const multiMenu = (): MenuEntry[] => [
    {
      id: "cherry-pick-many",
      label: `Cherry-pick ${picked.length} commits onto ${target}…`,
      description: pickProblem ?? "Oldest first",
      icon: <Cherry size={16} />,
      disabled: !!pickProblem,
      onSelect: pickMany,
    },
    { type: "separator", id: "sep-multi" },
    {
      id: "copy-many",
      label: "Copy commit ids",
      icon: <Copy size={16} />,
      onSelect: () =>
        void navigator.clipboard?.writeText(picked.map((c) => c.oid).join("\n")).catch(() => {}),
    },
    {
      id: "clear",
      label: "Keep only this commit",
      icon: <X size={16} />,
      onSelect: clearSelection,
    },
  ];
  const commitMenu = (oid: string): MenuEntry[] => {
    const short = oid.slice(0, 7);
    const localBranches = (data?.refsByOid.get(oid) ?? []).filter((r) => r.kind === "branch");
    const headOid = repo.head.kind === "unborn" ? null : repo.head.oid;
    return [
      ...localBranches.map<MenuEntry>((r) => ({
        id: `switch:${r.name}`,
        label: `Switch to ${r.name}`,
        icon: <Check size={16} />,
        disabled: repo.head.kind === "branch" && repo.head.name === r.name,
        onSelect: () => branchActions.switchTo(r.name),
      })),
      {
        id: "create",
        label: "Create branch here…",
        icon: <GitBranchPlus size={16} />,
        onSelect: () => branchActions.create({ kind: "commit", oid }, `commit ${short}`),
      },
      {
        id: "detach",
        label: "Check out this commit…",
        icon: <LogIn size={16} />,
        disabled: oid === headOid,
        onSelect: () => branchActions.checkoutCommit(oid),
      },
      { type: "separator", id: "sep-integrate" },
      {
        id: "merge",
        label: current ? `Merge into ${current}…` : "Merge into current…",
        icon: <GitMerge size={16} />,
        disabled: oid === headOid || busyOp,
        onSelect: () => integrate.merge({ kind: "commit", oid }, `commit ${short}`),
      },
      {
        id: "rebase",
        label: current ? `Rebase ${current} onto this commit…` : "Rebase onto this commit…",
        icon: <GitPullRequestArrow size={16} />,
        disabled: !current || oid === headOid || busyOp,
        onSelect: () => integrate.rebase({ kind: "commit", oid }, `commit ${short}`),
      },
      {
        id: "interactive",
        label: "Rebase interactively from here…",
        description: "Reorder, reword, squash or drop the commits after this one",
        icon: <ListOrdered size={16} />,
        disabled: !current || oid === headOid || busyOp,
        onSelect: () => integrate.interactive(oid, `commit ${short}`),
      },
      {
        id: "cherry-pick",
        label: "Cherry-pick commit",
        icon: <Cherry size={16} />,
        disabled: oid === headOid || busyOp || repo.head.kind === "unborn",
        onSelect: () => integrate.cherryPick(oid),
      },
      {
        id: "revert",
        label: "Revert commit",
        icon: <Undo2 size={16} />,
        disabled: busyOp || repo.head.kind === "unborn",
        onSelect: () => integrate.revert(oid),
      },
      { type: "separator", id: "sep-tag" },
      {
        id: "tag",
        label: "Create tag here…",
        icon: <Tag size={16} />,
        onSelect: () => tagActions.create(oid, `commit ${short}`),
      },
      { type: "separator", id: "sep" },
      {
        id: "copy",
        label: "Copy commit id",
        icon: <Copy size={16} />,
        onSelect: () => void navigator.clipboard?.writeText(oid).catch(() => {}),
      },
    ];
  };

  let list;
  if (history.error && !data) {
    list = (
      <EmptyState
        role="alert"
        tone="error"
        icon={<CircleAlert size={22} aria-hidden />}
        title="Could not load history"
        description={history.error.detail ?? history.error.message}
      />
    );
  } else if (!data) {
    list = (
      <div className="bl-history__loading" role="status">
        <Spinner size={18} /> Loading history…
      </div>
    );
  } else if (data.commits.length === 0) {
    list = (
      <EmptyState
        icon={<GitCommitHorizontal size={22} aria-hidden />}
        title="No commits yet"
        description="Stage your changes and create the first commit to start the history."
      />
    );
  } else {
    list = (
      <CommitList
        data={data}
        head={repo.head}
        selectedOid={selected}
        selectedOids={selection.oids}
        onSelect={select}
        onClearSelection={clearSelection}
        onNearEnd={loadMore}
        loadingMore={history.loadingMore}
        rowProps={(oid) =>
          drop(oid, {
            kind: "commit",
            oid,
            branches: (data?.refsByOid.get(oid) ?? [])
              .filter((r) => r.kind === "branch")
              .map((r) => r.name),
          })
        }
        onContextMenu={(oid, at) =>
          picked.length > 1 && selection.oids.has(oid)
            ? showMenu(at, multiMenu(), `Actions for ${picked.length} commits`)
            : showMenu(at, commitMenu(oid), `Actions for commit ${oid.slice(0, 7)}`)
        }
      />
    );
  }

  return (
    <div className="bl-history">
      <div
        className="bl-history__main"
        style={{ "--graph-width": graphColumnWidth(data) } as React.CSSProperties}
      >
        {openFile ? (
          <CommitDiffView
            key={`${openFile.oid}:${openFile.file.path}`}
            repoPath={repo.path}
            oid={openFile.oid}
            file={openFile.file}
            onBack={() => setOpenFile(null)}
          />
        ) : (
          <>
            <div className="bl-history__header">
              <h1 className="text-h2">History</h1>
              <span className="text-small text-secondary">
                {data
                  ? `${data.total.toLocaleString()} ${data.total === 1 ? "commit" : "commits"}`
                  : ""}
              </span>
              {history.loading && data && <Spinner size={14} label="Updating history" />}
            </div>
            {repo.totalChanges > 0 && (
              <WorkInProgressRow count={repo.totalChanges} onOpen={onShowChanges} />
            )}
            <div className="bl-history__columns text-small" aria-hidden>
              <span className="bl-history__col-graph">Graph</span>
              <span className="bl-history__col-message">Description</span>
              <span className="bl-history__col-author">Author</span>
              <span className="bl-history__col-date">Date</span>
              <span className="bl-history__col-sha">Commit</span>
            </div>
            {list}
          </>
        )}
      </div>
      {selected && data && (
        <>
          <Splitter
            label="Resize commit details"
            value={detailsWidth}
            min={300}
            max={640}
            side="right"
            onChange={setDetailsWidth}
          />
          <aside className="bl-history__details" style={{ width: detailsWidth }}>
            {picked.length > 1 ? (
              <MultiSelectionPanel
                commits={picked}
                target={target}
                problem={pickProblem}
                onCherryPick={pickMany}
                onSelectCommit={(oid) => select(oid)}
                onClear={clearSelection}
              />
            ) : (
              <CommitDetailsPanel
                key={selected}
                repoPath={repo.path}
                oid={selected}
                refs={data.refsByOid.get(selected)}
                head={repo.head}
                selectedFile={openFile?.oid === selected ? openFile.file.path : null}
                onOpenFile={(file, details) => setOpenFile({ oid: details.oid, file })}
                onSelectCommit={(oid) => select(oid)}
              />
            )}
          </aside>
        </>
      )}
    </div>
  );
}
