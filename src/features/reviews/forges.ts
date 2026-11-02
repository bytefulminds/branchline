import type { ForgeKind } from "../../types/forge";

export interface ForgeInfo {
  name: string;
  /** What the service calls a change request. */
  noun: string;
  nouns: string;
  defaultUrl: string;
  /** What the token needs, for the help text in Settings. */
  tokenHelp: string;
}

/** Services Branchline can connect to. */
export const FORGES: Record<ForgeKind, ForgeInfo> = {
  gitlab: {
    name: "GitLab",
    noun: "merge request",
    nouns: "merge requests",
    defaultUrl: "https://gitlab.com",
    tokenHelp: "a personal access token with the api scope (or read_api to only read)",
  },
};

/** Shown in Settings as coming later, so people know they are on the way. */
export const PLANNED_FORGES = ["GitHub", "Bitbucket"];

export const forgeInfo = (kind: ForgeKind | undefined): ForgeInfo => FORGES[kind ?? "gitlab"];
