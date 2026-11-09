import type { Access, ForgeKind, MergeRequest } from "../../types/forge";

export interface ForgeInfo {
  name: string;
  /** What the service calls a change request. */
  noun: string;
  nouns: string;
  defaultUrl: string;
  /** Only this address works (Bitbucket Cloud), so Settings does not ask for one. */
  fixedUrl: boolean;
  /** What a request number is written with: `!12` on GitLab, `#12` on Bitbucket. */
  ref: string;
  /** The token's name on the service. */
  tokenName: string;
  /** What the token needs, for the help text in Settings. */
  tokenHelp: string;
  tokenPlaceholder: string;
  /** The service signs in with an email address as well as the token. */
  needsEmail: boolean;
  /** What the token may do, as shown with a connected account. */
  access: Record<Access, string>;
}

/** Services Branchline can connect to. */
export const FORGES: Record<ForgeKind, ForgeInfo> = {
  gitlab: {
    name: "GitLab",
    noun: "merge request",
    nouns: "merge requests",
    defaultUrl: "https://gitlab.com",
    fixedUrl: false,
    ref: "!",
    tokenName: "Personal access token",
    tokenHelp: "a personal access token with the api scope (or read_api to only read)",
    tokenPlaceholder: "glpat-…",
    needsEmail: false,
    access: {
      write: "Can read merge requests, comment and approve",
      read: "Can read merge requests (read_api); commenting and approving need the api scope",
      unknown: "Connected (this server version does not say what the token may do)",
    },
  },
  bitbucket: {
    name: "Bitbucket",
    noun: "pull request",
    nouns: "pull requests",
    defaultUrl: "https://bitbucket.org",
    fixedUrl: true,
    ref: "#",
    tokenName: "API token",
    tokenHelp:
      "an API token with scopes for Bitbucket, with read:user, read:pullrequest and read:repository (add write:pullrequest to comment and approve later)",
    tokenPlaceholder: "ATATT…",
    needsEmail: true,
    access: {
      write: "Can read pull requests, comment and approve",
      read: "Can read pull requests",
      unknown: "Connected",
    },
  },
};

/** Shown in Settings as coming later, so people know they are on the way. */
export const PLANNED_FORGES = ["GitHub"];

export const forgeInfo = (kind: ForgeKind | undefined): ForgeInfo => FORGES[kind ?? "gitlab"];

/** The title without GitLab's draft prefix ("Draft:", "[Draft]", "(Draft)", "WIP:"), which
 * the Draft badge already shows. */
export function displayTitle(mr: Pick<MergeRequest, "title" | "draft">): string {
  if (!mr.draft) return mr.title;
  const t = mr.title.replace(/^\s*(\[draft\]|\(draft\)|draft:|draft\s*-|wip:|\[wip\])\s*/i, "");
  return t ? t[0]!.toUpperCase() + t.slice(1) : mr.title;
}
