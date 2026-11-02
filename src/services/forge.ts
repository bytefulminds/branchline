import type { Account, ForgeKind, RequestFilter, ReviewList, ReviewSource } from "../types/forge";
import { call } from "./git";

/** Accounts on hosting services (GitLab now). Tokens stay in the Rust backend. */
export const forgeService = {
  accounts: () => call<Account[]>("forge_accounts"),
  connect: (kind: ForgeKind, url: string, token: string) =>
    call<Account>("connect_account", { kind, url, token }),
  disconnect: (kind: ForgeKind, url: string) => call<void>("disconnect_account", { kind, url }),
  reviewSource: (repo: string) => call<ReviewSource | null>("review_source", { repo }),
  reviewRequests: (repo: string, allProjects: boolean, filter: RequestFilter) =>
    call<ReviewList>("review_requests", { repo, allProjects, filter }),
  /** Open a page of a connected server (a merge request) in the browser. */
  openPage: (url: string) => call<void>("open_forge_page", { url }),
  /** Open the service's page for making a token, with name and scope filled in. */
  openTokenPage: (kind: ForgeKind, url: string) => call<void>("open_token_page", { kind, url }),
};
