import {
  Cloud,
  CloudDownload,
  Copy,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "../../components/Button";
import { anchorOf, useContextMenu } from "../../components/ContextMenu";
import { EmptyState } from "../../components/EmptyState";
import type { MenuEntry } from "../../components/Menu";
import { plural } from "../../lib/format";
import type { RemoteInfo } from "../../types/git";
import { useBranchActions } from "../branches/BranchActions";
import { useRemoteActions } from "./RemoteActions";
import "../branches/BranchesView.css";
import "./Remotes.css";

/** Host and path of an address, for a compact label ("github.com · you/project"). */
export function describeUrl(url: string): string {
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  if (scp) return `${scp[1]} · ${scp[2]!.replace(/\.git$/, "")}`;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (m) return `${m[1]} · ${m[2]!.replace(/\.git$/, "")}`;
  return url;
}

export function RemotesView({ busy }: { busy: boolean }) {
  const remote = useRemoteActions();
  const { branches } = useBranchActions();
  const showMenu = useContextMenu();
  const networkBusy = remote.activity !== null;
  const tracking = (name: string) =>
    (branches?.local ?? []).filter((b) => b.upstream?.startsWith(`${name}/`)).length;
  const remoteBranches = (name: string) =>
    (branches?.remote ?? []).filter((b) => b.remote === name).length;

  const menu = (r: RemoteInfo): MenuEntry[] => [
    {
      id: "fetch",
      label: `Fetch ${r.name}`,
      icon: <CloudDownload size={16} />,
      disabled: networkBusy || busy,
      onSelect: () => remote.fetchRemote(r.name),
    },
    {
      id: "edit",
      label: "Edit…",
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
    { type: "separator", id: "sep" },
    {
      id: "remove",
      label: "Remove…",
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: busy || networkBusy,
      onSelect: () => remote.removeRemote(r),
    },
  ];

  return (
    <section className="bl-branches" aria-label="Remotes">
      <div className="bl-branches__header">
        <div className="bl-branches__title">
          <h1 className="text-h2">Remotes</h1>
          <span className="text-small text-secondary">
            {remote.remotes.length ? plural(remote.remotes.length, "remote") : ""}
          </span>
        </div>
        {remote.remotes.length > 1 && (
          <Button
            variant="ghost"
            icon={<CloudDownload size={16} aria-hidden />}
            disabled={networkBusy || busy}
            onClick={remote.fetchAll}
          >
            Fetch all
          </Button>
        )}
        <Button
          variant="primary"
          icon={<Plus size={16} aria-hidden />}
          disabled={busy}
          onClick={remote.addRemote}
        >
          Add remote
        </Button>
      </div>
      <div className="bl-branches__body">
        {remote.remotes.length === 0 ? (
          <EmptyState
            icon={<Cloud size={22} aria-hidden />}
            title="No remotes"
            description="Add a remote, such as a repository on GitHub or GitLab, to fetch, pull and push."
          />
        ) : (
          <ul className="bl-branch-list" aria-label="Remotes">
            {remote.remotes.map((r) => {
              const entries = menu(r);
              const n = remoteBranches(r.name);
              const t = tracking(r.name);
              return (
                <li
                  key={r.name}
                  className="bl-branch bl-remote"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showMenu({ x: e.clientX, y: e.clientY }, entries, `Actions for ${r.name}`);
                  }}
                >
                  <span className="bl-branch__icon" aria-hidden>
                    <Cloud size={15} />
                  </span>
                  <span className="bl-branch__main">
                    <span className="bl-branch__name">
                      <span className="truncate">{r.name}</span>
                      {describeUrl(r.url) !== r.url && (
                        <span className="text-secondary truncate bl-remote__host">
                          {describeUrl(r.url)}
                        </span>
                      )}
                    </span>
                    <span className="bl-branch__meta text-small">
                      <span className="mono text-muted truncate" title={r.url}>
                        {r.url}
                      </span>
                      {r.pushUrl && (
                        <span className="mono text-muted truncate" title={r.pushUrl}>
                          push: {r.pushUrl}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="bl-branch__time text-small text-muted bl-remote__counts">
                    <GitBranch size={12} aria-hidden />
                    {plural(n, "branch", "branches")}
                    {t > 0 && <span> · {t} tracked</span>}
                  </span>
                  <span className="bl-branch__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={networkBusy || busy}
                      onClick={() => remote.fetchRemote(r.name)}
                    >
                      Fetch
                    </Button>
                    <button
                      type="button"
                      className="bl-row-action"
                      aria-label={`More actions for ${r.name}`}
                      aria-haspopup="menu"
                      onClick={(e) =>
                        showMenu(anchorOf(e.currentTarget), entries, `Actions for ${r.name}`)
                      }
                    >
                      <MoreHorizontal size={15} aria-hidden />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
