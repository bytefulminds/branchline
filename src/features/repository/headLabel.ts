import type { HeadState, RepoOperation } from "../../types/git";

export interface HeadLabel {
  text: string;
  qualifier?: string;
  mono: boolean;
  title: string;
}

export function headLabel(head: HeadState): HeadLabel {
  switch (head.kind) {
    case "branch":
      return { text: head.name, mono: false, title: `On branch ${head.name}` };
    case "detached":
      return {
        text: head.oid.slice(0, 7),
        qualifier: "detached",
        mono: true,
        title: `HEAD is detached at ${head.oid}`,
      };
    case "unborn":
      return {
        text: head.name,
        qualifier: "no commits yet",
        mono: false,
        title: `Branch ${head.name} has no commits yet`,
      };
  }
}

export const OPERATION_LABEL: Record<RepoOperation, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  cherryPick: "Cherry-pick in progress",
  revert: "Revert in progress",
  bisect: "Bisect in progress",
};
