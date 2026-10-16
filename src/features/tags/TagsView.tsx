import {
  ArrowUpFromLine,
  Check,
  CloudOff,
  Copy,
  GitBranchPlus,
  MoreHorizontal,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { anchorOf, useContextMenu } from "../../components/ContextMenu";
import { EmptyState } from "../../components/EmptyState";
import type { MenuEntry } from "../../components/Menu";
import { Spinner } from "../../components/Spinner";
import { plural, relativeTime } from "../../lib/format";
import type { RepositoryInfo, TagInfo } from "../../types/git";
import { useBranchActions } from "../branches/BranchActions";
import { useRemoteActions } from "../remote/RemoteActions";
import { useTagActions } from "./TagActions";
import "../branches/BranchesView.css";

export function TagsView({ repo, busy }: { repo: RepositoryInfo; busy: boolean }) {
  const { tags, create, remove } = useTagActions();
  const branches = useBranchActions();
  const remote = useRemoteActions();
  const showMenu = useContextMenu();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (tags ?? []).filter(
        (t) => !q || t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q),
      ),
    [tags, q],
  );
  const headOid = repo.head.kind === "unborn" ? null : repo.head.oid;
  const networkBusy = remote.activity !== null;
  const noRemote = remote.remotes.length === 0;

  const menu = (t: TagInfo): MenuEntry[] => [
    {
      id: "checkout",
      label: "Check out",
      description: "Detached HEAD at the tagged commit",
      icon: <Check size={16} />,
      disabled: !t.isCommit || busy || t.target === headOid,
      onSelect: () => branches.checkoutCommit(t.target),
    },
    {
      id: "branch",
      label: "Create branch from tag…",
      icon: <GitBranchPlus size={16} />,
      disabled: !t.isCommit || busy,
      onSelect: () => branches.create({ kind: "commit", oid: t.target }, `tag ${t.name}`),
    },
    { type: "separator", id: "sep-remote" },
    {
      id: "push",
      label: "Push tag",
      icon: <ArrowUpFromLine size={16} />,
      disabled: noRemote || networkBusy || busy,
      onSelect: () => remote.pushTag(t.name),
    },
    {
      id: "delete-remote",
      label: "Delete from remote…",
      icon: <CloudOff size={16} />,
      danger: true,
      disabled: noRemote || networkBusy || busy,
      onSelect: () => remote.deleteRemoteTag(t.name),
    },
    { type: "separator", id: "sep" },
    {
      id: "copy",
      label: "Copy tag name",
      icon: <Copy size={16} />,
      onSelect: () => void navigator.clipboard?.writeText(t.name).catch(() => {}),
    },
    {
      id: "delete",
      label: "Delete…",
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: busy,
      onSelect: () => remove(t),
    },
  ];

  if (!tags) {
    return (
      <div className="bl-history__loading" role="status">
        <Spinner size={18} /> Loading tags…
      </div>
    );
  }

  const headLabel =
    repo.head.kind === "branch"
      ? `the tip of ${repo.head.name}`
      : repo.head.kind === "detached"
        ? `commit ${repo.head.oid.slice(0, 7)}`
        : "";

  return (
    <section className="bl-branches" aria-label="Tags">
      <div className="bl-branches__header">
        <div className="bl-branches__title">
          <h1 className="text-h2">Tags</h1>
          <span className="text-small text-secondary">
            {tags.length ? plural(tags.length, "tag") : ""}
          </span>
        </div>
        {tags.length > 0 && (
          <label className="bl-search bl-branches__search">
            <Search size={14} aria-hidden className="bl-search__icon" />
            <span className="visually-hidden">Filter tags</span>
            <input
              type="search"
              placeholder="Filter tags"
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
        )}
        <Button
          variant="primary"
          icon={<Tag size={16} aria-hidden />}
          disabled={!headOid || busy}
          title={!headOid ? "Create the first commit before tagging" : undefined}
          onClick={() => headOid && create(headOid, headLabel)}
        >
          New tag
        </Button>
      </div>

      <div className="bl-branches__body">
        {tags.length === 0 ? (
          <EmptyState
            icon={<Tag size={22} aria-hidden />}
            title="No tags"
            description="Tags mark important commits, such as releases. Create one here or from a commit in History."
          />
        ) : shown.length === 0 ? (
          <p className="bl-branches__empty text-secondary text-small">No tags match.</p>
        ) : (
          <ul className="bl-branch-list" aria-label="Tags">
            {shown.map((t) => {
              const entries = menu(t);
              const atHead = t.target === headOid;
              return (
                <li
                  key={t.name}
                  className={`bl-branch${atHead ? " bl-branch--current" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showMenu({ x: e.clientX, y: e.clientY }, entries, `Actions for tag ${t.name}`);
                  }}
                >
                  <span className="bl-branch__icon" aria-hidden>
                    <Tag size={15} />
                  </span>
                  <span className="bl-branch__main">
                    <span className="bl-branch__name">
                      <span className="truncate">{t.name}</span>
                      {t.annotated && <span className="bl-tag-kind">annotated</span>}
                      {atHead && <span className="bl-branch__badge">HEAD</span>}
                    </span>
                    <span className="bl-branch__meta text-small">
                      <span className="mono text-muted">{t.target.slice(0, 7)}</span>
                      <span className="truncate text-secondary">{t.subject}</span>
                      {t.tagger && <span className="text-muted truncate">by {t.tagger}</span>}
                    </span>
                  </span>
                  <time
                    className="bl-branch__time text-small text-muted"
                    title={t.time ? new Date(t.time * 1000).toLocaleString() : undefined}
                  >
                    {t.time ? relativeTime(t.time * 1000) : ""}
                  </time>
                  <span className="bl-branch__actions">
                    {t.isCommit && !atHead && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => branches.checkoutCommit(t.target)}
                      >
                        Check out
                      </Button>
                    )}
                    <button
                      type="button"
                      className="bl-row-action"
                      aria-label={`More actions for tag ${t.name}`}
                      aria-haspopup="menu"
                      onClick={(e) =>
                        showMenu(anchorOf(e.currentTarget), entries, `Actions for tag ${t.name}`)
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
