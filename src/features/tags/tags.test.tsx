import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import {
  installTauriTestEnvironment,
  makeHistory,
  openButton,
  REPO,
  setup,
} from "../../test/harness";
import type { RemoteInfo, RepositoryInfo, TagInfo } from "../../types/git";

installTauriTestEnvironment();

const HEAD = REPO.head.kind === "branch" ? REPO.head.oid : "";
const TAGS: TagInfo[] = [
  {
    name: "v2.0.0",
    target: HEAD,
    isCommit: true,
    annotated: true,
    subject: "Release 2.0",
    tagger: "Ada",
    time: Math.floor(Date.now() / 1000) - 60,
  },
  {
    name: "v1.0.0",
    target: "b".repeat(40),
    isCommit: true,
    annotated: false,
    subject: "Initial release",
    tagger: null,
    time: Math.floor(Date.now() / 1000) - 86400 * 30,
  },
];
const ORIGIN: RemoteInfo = { name: "origin", url: "https://example.com/r.git", pushUrl: null };
const UPSTREAM: RemoteInfo = { name: "upstream", url: "git@example.com:t/r.git", pushUrl: null };
const pushed = (repo: RepositoryInfo = REPO) => ({
  outcome: { updatedRefs: 0, conflicts: false, upToDate: false, target: null, stashKept: false },
  repo,
});

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function openTags(extra: Extra = () => undefined, remotes: RemoteInfo[] = [ORIGIN]) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "list_branches") return { local: [], remote: [] };
    if (cmd === "list_remotes") return remotes;
    if (cmd === "list_tags") return TAGS;
    if (cmd === "check_tag_name")
      return (args.name as string).includes(" ") ? "Tag names cannot contain spaces." : null;
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  await user.keyboard("{Control>}5{/Control}");
  const list = await screen.findByRole("list", { name: "Tags" });
  return { user, calls, list };
}

const row = (list: HTMLElement, name: string) =>
  within(list).getByText(name).closest("li") as HTMLElement;

describe("tags", () => {
  it("lists tags with their kind, target and the one at HEAD", async () => {
    const { list } = await openTags();
    expect(screen.getByRole("button", { name: /^Tags/ })).toHaveTextContent("2");
    const v2 = row(list, "v2.0.0");
    expect(v2).toHaveTextContent("annotated");
    expect(v2).toHaveTextContent("HEAD");
    expect(v2).toHaveTextContent("Release 2.0");
    expect(v2).toHaveTextContent("by Ada");
    const v1 = row(list, "v1.0.0");
    expect(v1).not.toHaveTextContent("annotated");
    expect(v1).toHaveTextContent("bbbbbbb");
    // Only tags away from HEAD offer a checkout.
    expect(within(v2).queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
    expect(within(v1).getByRole("button", { name: "Check out" })).toBeInTheDocument();
  });

  it("creates an annotated tag at HEAD with live validation and pushes it", async () => {
    const { user, calls } = await openTags((cmd) => {
      if (cmd === "create_tag") return REPO;
      if (cmd === "push_tag") return pushed();
    });
    await user.click(screen.getByRole("button", { name: "New tag" }));
    const dialog = await screen.findByRole("dialog", { name: "Create tag" });
    expect(dialog).toHaveTextContent("Tags the tip of main.");
    const name = within(dialog).getByLabelText("Tag name");
    const submit = within(dialog).getByRole("button", { name: "Create tag" });

    await user.type(name, "bad name");
    expect(await within(dialog).findByText("Tag names cannot contain spaces.")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.clear(name);
    await user.type(name, "v3.0.0");
    await user.type(within(dialog).getByLabelText(/Message/), "Release 3");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Push to origin after creating" }),
    );
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_tag")?.args).toEqual({
        repo: REPO.path,
        name: "v3.0.0",
        target: HEAD,
        message: "Release 3",
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "push_tag")?.args).toMatchObject({
        name: "v3.0.0",
        remote: "origin",
        delete: false,
      }),
    );
    expect(await screen.findByText("Pushed v3.0.0 to origin")).toBeInTheDocument();
  });

  it("creates a tag at a commit from the history", async () => {
    const commits = makeHistory(3);
    const { user, calls } = await openTags((cmd) => {
      if (cmd === "log_page") return { commits, hasMore: false, total: 3 };
      if (cmd === "list_refs") return [];
      if (cmd === "commit_details") return undefined;
      if (cmd === "create_tag") return REPO;
    });
    await user.keyboard("{Control>}2{/Control}");
    const history = await screen.findByRole("listbox", { name: "Commits" });
    fireEvent.contextMenu(within(history).getAllByRole("option")[2]!, {
      clientX: 400,
      clientY: 300,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Create tag here…" }));
    const dialog = await screen.findByRole("dialog", { name: "Create tag" });
    expect(dialog).toHaveTextContent(`Tags commit ${commits[2]!.oid.slice(0, 7)}.`);
    await user.type(within(dialog).getByLabelText("Tag name"), "old-release");
    const submit = within(dialog).getByRole("button", { name: "Create tag" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "create_tag")?.args).toMatchObject({
        name: "old-release",
        target: commits[2]!.oid,
        message: "",
      }),
    );
    expect(await screen.findByText("Created tag old-release")).toBeInTheDocument();
  });

  it("deletes a local tag after confirmation", async () => {
    const { user, calls, list } = await openTags((cmd) => {
      if (cmd === "delete_tag") return REPO;
    });
    await user.click(within(row(list, "v1.0.0")).getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete tag v1.0.0?");
    await user.click(within(dialog).getByRole("button", { name: "Delete tag" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "delete_tag")?.args).toEqual({
        repo: REPO.path,
        name: "v1.0.0",
      }),
    );
  });

  it("asks which remote when there are several, and confirms deleting there", async () => {
    const { user, calls, list } = await openTags(
      (cmd) => {
        if (cmd === "push_tag") return pushed();
      },
      [ORIGIN, UPSTREAM],
    );
    await user.click(within(row(list, "v1.0.0")).getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete from remote…" }));
    const picker = await screen.findByRole("dialog", { name: /Delete tag v1.0.0 from a remote/ });
    await user.click(within(picker).getByRole("radio", { name: /upstream/ }));
    await user.click(within(picker).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Delete tag v1.0.0 from upstream?");
    await user.click(within(confirm).getByRole("button", { name: "Delete from remote" }));

    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "push_tag")?.args).toMatchObject({
        name: "v1.0.0",
        remote: "upstream",
        delete: true,
      }),
    );
    expect(await screen.findByText("Deleted v1.0.0 from upstream")).toBeInTheDocument();
  });

  it("explains a tag that already differs on the remote", async () => {
    const { user, list } = await openTags((cmd) => {
      if (cmd === "push_tag")
        return Promise.reject({
          kind: "tagConflict",
          message: "The remote already has a different tag with this name.",
          detail: "! [rejected] v1.0.0 -> v1.0.0 (already exists)",
        });
    });
    await user.click(within(row(list, "v1.0.0")).getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Push tag" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Tag exists on the remote")).toBeInTheDocument();
  });

  it("checks out a tag as a detached HEAD after confirmation", async () => {
    const { user, calls, list } = await openTags((cmd) => {
      if (cmd === "checkout_detached") return REPO;
    });
    await user.click(within(row(list, "v1.0.0")).getByRole("button", { name: "Check out" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Check out" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "checkout_detached")?.args.oid).toBe("b".repeat(40)),
    );
  });
});
