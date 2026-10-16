import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, RefreshCcw, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Menu, type MenuEntry } from "../../components/Menu";
import { Spinner } from "../../components/Spinner";
import type { RepositoryInfo } from "../../types/git";
import { useRemoteActions, type NetworkActivity } from "./RemoteActions";
import "./RemoteToolbar.css";

function ToolButton({
  icon,
  label,
  count,
  countLabel,
  running,
  disabled,
  title,
  onClick,
  split,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  countLabel?: string;
  running: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
  split?: boolean;
}) {
  return (
    <button
      type="button"
      className={`bl-tool${split ? " bl-tool--split" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-busy={running || undefined}
      aria-label={count ? `${label} (${countLabel})` : label}
      data-tooltip={title}
    >
      {running ? <Spinner size={14} /> : icon}
      <span className="bl-tool__label">{label}</span>
      {count ? (
        <span className="bl-tool__count" aria-hidden>
          {count.toLocaleString()}
        </span>
      ) : null}
    </button>
  );
}

function MoreButton({
  label,
  entries,
  disabled,
}: {
  label: string;
  entries: MenuEntry[];
  disabled: boolean;
}) {
  return (
    <Menu
      entries={entries}
      align="end"
      minWidth={240}
      trigger={(props) => (
        <button
          type="button"
          className="bl-tool bl-tool--more"
          aria-label={label}
          disabled={disabled}
          {...props}
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
    />
  );
}

/** Fetch, Pull and Push for the title bar, with ahead/behind counts. */
export function RemoteToolbar({ repo, busy }: { repo: RepositoryInfo; busy: boolean }) {
  const actions = useRemoteActions();
  const { remotes, activity } = actions;
  const running = (kind: NetworkActivity["kind"]) => activity?.kind === kind;
  const locked = busy || activity !== null;

  const onBranch = repo.head.kind === "branch";
  const upstream = repo.upstream;
  const tracking = upstream && !upstream.gone ? upstream : null;
  const hasRemotes = remotes.length > 0;

  const fetchTitle = hasRemotes
    ? `Fetch ${remotes.length === 1 ? remotes[0]!.name : "all remotes"}`
    : "No remotes configured";

  const pullTitle = !onBranch
    ? "Not on a branch"
    : !upstream
      ? "This branch has no upstream"
      : upstream.gone
        ? `${upstream.name} no longer exists`
        : tracking!.behind
          ? `Pull ${tracking!.behind} from ${tracking!.name}`
          : `Pull from ${tracking!.name}`;
  const canPull = onBranch && tracking !== null;

  const publish = onBranch && !upstream;
  const pushTitle = !onBranch
    ? "Not on a branch"
    : publish
      ? hasRemotes
        ? "Publish this branch"
        : "No remotes configured"
      : tracking?.ahead
        ? `Push ${tracking.ahead} to ${tracking.name}`
        : `Push to ${upstream!.name}`;
  const canPush = onBranch && (!publish || hasRemotes);

  const pullEntries: MenuEntry[] = [
    {
      id: "ff",
      label: "Pull (fast-forward only)",
      description: "Never creates a merge commit",
      onSelect: () => actions.pull("fastForward"),
    },
    {
      id: "merge",
      label: "Pull with merge",
      description: "Merge the upstream into your branch",
      onSelect: () => actions.pull("merge"),
    },
    {
      id: "rebase",
      label: "Pull with rebase",
      description: "Replay your commits on top of the upstream",
      onSelect: () => actions.pull("rebase"),
    },
  ];
  const pushEntries: MenuEntry[] = [
    {
      id: "push",
      label: publish ? "Publish branch…" : "Push",
      icon: <ArrowUpFromLine size={16} aria-hidden />,
      onSelect: actions.push,
    },
    {
      id: "force",
      label: "Force push…",
      description: "With lease: refused if the remote moved",
      danger: true,
      disabled: !upstream || publish,
      onSelect: actions.forcePush,
    },
  ];

  return (
    <div className="bl-remote-toolbar" role="group" aria-label="Remote">
      <ToolButton
        icon={<RefreshCcw size={15} aria-hidden />}
        label="Fetch"
        title={fetchTitle}
        running={running("fetch")}
        disabled={locked || !hasRemotes}
        onClick={actions.fetchAll}
      />
      <div className="bl-tool-split">
        <ToolButton
          split
          icon={<ArrowDownToLine size={15} aria-hidden />}
          label="Pull"
          count={tracking?.behind}
          countLabel={`${tracking?.behind ?? 0} behind`}
          title={pullTitle}
          running={running("pull")}
          disabled={locked || !canPull}
          onClick={() => actions.pull("fastForward")}
        />
        <MoreButton label="Pull options" entries={pullEntries} disabled={locked || !canPull} />
      </div>
      <div className="bl-tool-split">
        <ToolButton
          split
          icon={
            publish ? <Upload size={15} aria-hidden /> : <ArrowUpFromLine size={15} aria-hidden />
          }
          label={publish ? "Publish" : "Push"}
          count={tracking?.ahead}
          countLabel={`${tracking?.ahead ?? 0} ahead`}
          title={pushTitle}
          running={running("push")}
          disabled={locked || !canPush}
          onClick={actions.push}
        />
        <MoreButton label="Push options" entries={pushEntries} disabled={locked || !canPush} />
      </div>
    </div>
  );
}
