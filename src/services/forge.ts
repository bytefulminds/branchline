import type { Account, ReviewList, ReviewSource } from "../types/forge";
import { call } from "./git";

/** Accounts on GitLab (later other services). Tokens stay in the Rust backend. */
export const forgeService = {
  accounts: () => call<Account[]>("forge_accounts"),
  connectGitlab: (url: string, token: string) => call<Account>("connect_gitlab", { url, token }),
  disconnect: (url: string) => call<void>("disconnect_account", { url }),
  reviewSource: (repo: string) => call<ReviewSource | null>("review_source", { repo }),
  reviewRequests: (repo: string, allProjects: boolean) =>
    call<ReviewList>("review_requests", { repo, allProjects }),
  /** Open a page of a connected server (a merge request) in the browser. */
  openPage: (url: string) => call<void>("open_forge_page", { url }),
  /** Open GitLab's page for making a personal access token, name and scope filled in. */
  openTokenPage: (url: string) => call<void>("open_gitlab_token_page", { url }),
};
