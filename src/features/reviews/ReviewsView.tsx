import {
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button, IconButton } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { plural, relativeTime } from "../../lib/format";
import { forgeService } from "../../services/forge";
import type { MergeRequest } from "../../types/forge";
import { Avatar } from "../history/Avatar";
import { useReviews } from "./ReviewsProvider";
import "../branches/BranchesView.css";
import "./ReviewsView.css";

const PIPELINE: Record<string, { label: string; icon: React.ReactNode; tone: string }> = {
  success: { label: "Pipeline passed", icon: <CircleCheck size={14} />, tone: "success" },
  failed: { label: "Pipeline failed", icon: <CircleX size={14} />, tone: "error" },
  running: { label: "Pipeline running", icon: <LoaderCircle size={14} />, tone: "info" },
  pending: { label: "Pipeline pending", icon: <CircleDashed size={14} />, tone: "muted" },
  created: { label: "Pipeline pending", icon: <CircleDashed size={14} />, tone: "muted" },
  canceled: { label: "Pipeline canceled", icon: <CircleDashed size={14} />, tone: "muted" },
  skipped: { label: "Pipeline skipped", icon: <CircleDashed size={14} />, tone: "muted" },
  manual: {
    label: "Pipeline waits for a manual job",
    icon: <CircleDashed size={14} />,
    tone: "muted",
  },
};

function PipelineStatus({ status }: { status: string | null }) {
  if (!status) return null;
  const p = PIPELINE[status] ?? {
    label: `Pipeline ${status}`,
    icon: <CircleDashed size={14} />,
    tone: "muted",
  };
  return (
    <span className={`bl-review__pipeline bl-review__pipeline--${p.tone}`} title={p.label}>
      <span aria-hidden>{p.icon}</span>
      <span className="visually-hidden">{p.label}</span>
    </span>
  );
}

function open(url: string) {
  void forgeService.openPage(url).catch(() => {});
}

/** The title without GitLab's draft prefix ("Draft:", "[Draft]", "(Draft)", "WIP:"), which
 * the Draft badge already shows. */
export function displayTitle(mr: Pick<MergeRequest, "title" | "draft">): string {
  if (!mr.draft) return mr.title;
  const t = mr.title.replace(/^\s*(\[draft\]|\(draft\)|draft:|draft\s*-|wip:|\[wip\])\s*/i, "");
  return t ? t[0]!.toUpperCase() + t.slice(1) : mr.title;
}

function Row({ mr, showProject }: { mr: MergeRequest; showProject: boolean }) {
  const updated = Date.parse(mr.updatedAt);
  return (
    <li className="bl-branch bl-review" onDoubleClick={() => open(mr.webUrl)}>
      <span className="bl-branch__icon" aria-hidden>
        <GitPullRequest size={15} />
      </span>
      <span className="bl-branch__main">
        <span className="bl-branch__name">
          <span className="truncate" title={mr.title}>
            {displayTitle(mr)}
          </span>
          {mr.draft && <span className="bl-tag-kind">Draft</span>}
          {mr.approvedByYou && <span className="bl-review__approved">Approved by you</span>}
          {mr.hasConflicts && (
            <span className="bl-review__conflicts" title="Has merge conflicts">
              <TriangleAlert size={12} aria-hidden /> Conflicts
            </span>
          )}
        </span>
        <span className="bl-branch__meta text-small text-secondary">
          <span className="mono text-muted">
            {showProject ? mr.projectPath : ""}!{mr.iid}
          </span>
          <span className="bl-review__author">
            <Avatar name={mr.author.name} email={mr.author.username} size={16} />
            {mr.author.name}
          </span>
          <span className="mono truncate" title={`${mr.sourceBranch} into ${mr.targetBranch}`}>
            {mr.sourceBranch} → {mr.targetBranch}
          </span>
        </span>
      </span>
      <span className="bl-review__status text-small text-muted">
        <PipelineStatus status={mr.pipeline} />
        {mr.comments > 0 && (
          <span className="bl-review__comments" title={plural(mr.comments, "comment")}>
            <MessageSquare size={13} aria-hidden />
            <span className="visually-hidden">Comments: </span>
            {mr.comments}
          </span>
        )}
      </span>
      <time
        className="bl-branch__time text-small text-muted"
        dateTime={mr.updatedAt}
        title={Number.isNaN(updated) ? undefined : `Updated ${new Date(updated).toLocaleString()}`}
      >
        {Number.isNaN(updated) ? "" : relativeTime(updated)}
      </time>
      <span className="bl-branch__actions">
        <Button
          size="sm"
          variant="secondary"
          icon={<ExternalLink size={13} aria-hidden />}
          onClick={() => open(mr.webUrl)}
        >
          Open
        </Button>
      </span>
    </li>
  );
}

/** Merge requests on GitLab where you are a reviewer, for this project or all projects. */
export function ReviewsView() {
  const { source, list, allProjects, setAllProjects, refresh } = useReviews();
  const data = list.status === "ready" ? list.list : list.status === "idle" ? null : list.previous;
  const loading = list.status === "loading";
  const items = data?.items ?? [];

  return (
    <section className="bl-branches" aria-label="Reviews">
      <div className="bl-branches__header">
        <div className="bl-branches__title">
          <h1 className="text-h2">Reviews</h1>
          <span className="text-small text-secondary truncate">
            {data
              ? `${plural(items.length, "merge request")} waiting for you${
                  data.truncated ? " (newest shown)" : ""
                }`
              : ""}
          </span>
        </div>
        <label className="bl-branches__sort text-small">
          <span className="visually-hidden">Show merge requests from</span>
          <select
            className="bl-input"
            value={allProjects ? "all" : "project"}
            onChange={(e) => setAllProjects(e.target.value === "all")}
          >
            <option value="project">{source ? source.project : "This project"}</option>
            <option value="all">All projects on {source?.host ?? "GitLab"}</option>
          </select>
        </label>
        <IconButton
          label="Refresh reviews"
          icon={loading ? <Spinner size={14} /> : <RefreshCw size={15} aria-hidden />}
          disabled={loading}
          onClick={refresh}
          data-tooltip-align="end"
        />
      </div>

      <div className="bl-branches__body">
        {list.status === "error" && (
          <div className="bl-banner bl-banner--error" role="alert">
            <TriangleAlert size={16} aria-hidden />
            <span>{list.error.message}</span>
          </div>
        )}
        {!data && loading ? (
          <div className="bl-history__loading" role="status">
            <Spinner size={18} /> Loading merge requests…
          </div>
        ) : data && items.length === 0 ? (
          <EmptyState
            icon={<CircleCheck size={22} aria-hidden />}
            tone="success"
            title="Nothing to review"
            description={
              allProjects
                ? `No open merge requests on ${data.account.host} have you as a reviewer.`
                : `No open merge requests in ${data.project} have you as a reviewer.`
            }
          />
        ) : (
          data && (
            <ul className="bl-branch-list bl-reviews__list" aria-label="Merge requests to review">
              {items.map((mr) => (
                <Row key={`${mr.projectId}!${mr.iid}`} mr={mr} showProject={allProjects} />
              ))}
            </ul>
          )
        )}
        {data && (
          <p className="bl-reviews__note text-small text-muted">
            Signed in as {data.account.name} (@{data.account.username}) on {data.account.host}.
            Double-click a merge request to open it on GitLab; reviewing it in Branchline comes
            next.
          </p>
        )}
      </div>
    </section>
  );
}
