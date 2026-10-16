import {
  Check,
  Cherry,
  CircleAlert,
  Copy,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  LogIn,
  Tag,
  Undo2,
} from "lucide-react";
import { useContextMenu } from "../../components/ContextMenu";
import type { MenuEntry } from "../../components/Menu";
import { useBranchActions } from "../branches/BranchActions";
import { useCallback, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { Splitter } from "../../components/Splitter";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import type { CommitFile, RepositoryInfo } from "../../types/git";
import { CommitDetailsPanel } from "./CommitDetailsPanel";
import { CommitDiffView } from "./CommitDiffView";
import { useTagActions } from "../tags/TagActions";
import { useIntegrateActions } from "../integrate/IntegrateActions";
import { CommitList, graphColumnWidth, WorkInProgressRow } from "./CommitList";
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
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ oid: string; file: CommitFile } | null>(null);
  const [detailsWidth, setDetailsWidth] = usePersistentNumber(
    "branchline.layout.commitDetailsWidth",
    400,
  );
  const { data, loadMore } = history;

  const select = useCallback((oid: string) => {
    setSelectedOid(oid);
    setOpenFile(null);
  }, []);

  const selected = selectedOid ?? data?.commits[0]?.oid ?? null;

  const tagActions = useTagActions();
  const integrate = useIntegrateActions();
  const current = repo.head.kind === "branch" ? repo.head.name : null;
  const busyOp = repo.operation !== null;
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
        onSelect={select}
        onNearEnd={loadMore}
        loadingMore={history.loadingMore}
        onContextMenu={(oid, at) =>
          showMenu(at, commitMenu(oid), `Actions for commit ${oid.slice(0, 7)}`)
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
            <CommitDetailsPanel
              key={selected}
              repoPath={repo.path}
              oid={selected}
              refs={data.refsByOid.get(selected)}
              head={repo.head}
              selectedFile={openFile?.oid === selected ? openFile.file.path : null}
              onOpenFile={(file, details) => setOpenFile({ oid: details.oid, file })}
              onSelectCommit={select}
            />
          </aside>
        </>
      )}
    </div>
  );
}
