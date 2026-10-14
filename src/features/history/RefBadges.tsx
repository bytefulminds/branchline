import { Cloud, GitBranch, Tag } from "lucide-react";
import type { HeadState, RefInfo } from "../../types/git";

const ICON = { branch: GitBranch, remote: Cloud, tag: Tag } as const;
const ORDER = { branch: 0, remote: 1, tag: 2 } as const;

/** Branch, remote and tag labels for one commit. The checked-out branch comes first. */
export function RefBadges({
  refs,
  head,
  isHeadCommit,
  max = 3,
}: {
  refs: RefInfo[] | undefined;
  head: HeadState;
  isHeadCommit: boolean;
  max?: number;
}) {
  const current = head.kind === "branch" ? head.name : null;
  const sorted = [...(refs ?? [])].sort(
    (a, b) =>
      Number(b.name === current && b.kind === "branch") -
        Number(a.name === current && a.kind === "branch") || ORDER[a.kind] - ORDER[b.kind],
  );
  const shown = sorted.slice(0, max);
  const hidden = sorted.length - shown.length;
  const detached = isHeadCommit && head.kind === "detached";
  if (shown.length === 0 && !detached) return null;
  return (
    <span className="bl-refs">
      {detached && <span className="bl-ref bl-ref--head">HEAD</span>}
      {shown.map((r) => {
        const Icon = ICON[r.kind];
        const isCurrent = r.kind === "branch" && r.name === current;
        return (
          <span
            key={`${r.kind}:${r.name}`}
            className={`bl-ref bl-ref--${r.kind}${isCurrent ? " bl-ref--current" : ""}`}
            title={`${r.kind === "remote" ? "Remote branch" : r.kind === "tag" ? "Tag" : isCurrent ? "Current branch" : "Branch"} ${r.name}`}
          >
            <Icon size={11} aria-hidden />
            <span className="truncate">{r.name}</span>
          </span>
        );
      })}
      {hidden > 0 && (
        <span
          className="bl-ref bl-ref--more"
          title={sorted
            .slice(max)
            .map((r) => r.name)
            .join(", ")}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}
