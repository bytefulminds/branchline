import type {
  Account,
  ForgeKind,
  RequestDetail,
  RequestFilter,
  ReviewList,
  ReviewSource,
} from "../types/forge";
import type { FileDiff, RemoteProgress } from "../types/git";
import { call, progressChannel } from "./git";

/** Accounts on hosting services (GitLab and Bitbucket Cloud). Tokens stay in the Rust
 * backend. */
export const forgeService = {
  accounts: () => call<Account[]>("forge_accounts"),
  /** `login` is the email address Bitbucket signs in with; GitLab does not use it. */
  connect: (kind: ForgeKind, url: string, token: string, login?: string) =>
    call<Account>("connect_account", { kind, url, token, login: login ?? null }),
  disconnect: (kind: ForgeKind, url: string) => call<void>("disconnect_account", { kind, url }),
  reviewSource: (repo: string) => call<ReviewSource | null>("review_source", { repo }),
  reviewRequests: (repo: string, allProjects: boolean, filter: RequestFilter) =>
    call<ReviewList>("review_requests", { repo, allProjects, filter }),
  /** Open a merge request of the repository's project for reading: its details and
   * threads, and its commits fetched into the repository. Cancel with
   * `gitService.cancelRemote(opId)`. */
  openMergeRequest: (
    repo: string,
    projectId: number,
    iid: number,
    opId: string,
    onProgress: (p: RemoteProgress) => void,
  ) =>
    call<RequestDetail>("open_merge_request", {
      repo,
      projectId,
      iid,
      opId,
      onProgress: progressChannel(onProgress),
    }),
  /** Diff of one file between a merge request's base and head. */
  rangeFileDiff: (
    repo: string,
    base: string,
    head: string,
    path: string,
    originalPath: string | null,
    force = false,
  ) => call<FileDiff>("range_file_diff", { repo, base, head, path, originalPath, force }),
  /** Open a page of a connected server (a merge request) in the browser. */
  openPage: (url: string) => call<void>("open_forge_page", { url }),
  /** Open the service's page for making a token, with name and scope filled in. */
  openTokenPage: (kind: ForgeKind, url: string) => call<void>("open_token_page", { kind, url }),
};
