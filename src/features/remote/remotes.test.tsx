import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { RemoteInfo } from "../../types/git";
import { cloneFolderName, parentOf } from "../repository/CloneDialog";
import { remoteNameProblem, remoteUrlProblem } from "./RemoteDialog";
import { describeUrl } from "./describeUrl";

installTauriTestEnvironment();

const ORIGIN: RemoteInfo = {
  name: "origin",
  url: "git@github.com:acme/demo.git",
  pushUrl: null,
};
const MIRROR: RemoteInfo = {
  name: "mirror",
  url: "https://***@gitlab.com/acme/demo.git",
  pushUrl: null,
};

type Extra = (cmd: string, args: Record<string, unknown>) => unknown;

async function open(extra: Extra = () => undefined, remotes: RemoteInfo[] = [ORIGIN, MIRROR]) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    const answer = extra(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return { ...REPO, path: (args.path as string) ?? REPO.path };
    if (cmd === "list_remotes") return remotes;
    if (cmd === "list_branches")
      return {
        local: [],
        remote: [
          {
            name: "origin/main",
            remote: "origin",
            oid: "a".repeat(40),
            isCurrent: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            upstreamGone: false,
            tipTime: 1,
            tipSummary: "x",
          },
        ],
      };
  });
  render(<App />);
  await user.click(openButton());
  await screen.findByRole("heading", { name: "Changes" });
  return { user, calls };
}

describe("remote helpers", () => {
  it("describes addresses and checks names", () => {
    expect(describeUrl("git@github.com:acme/demo.git")).toBe("github.com · acme/demo");
    expect(describeUrl("https://***@gitlab.com:8443/a/b.git")).toBe("gitlab.com · a/b");
    expect(describeUrl("/srv/git/demo.git")).toBe("/srv/git/demo.git");
    expect(remoteNameProblem("up stream", [])).toMatch(/spaces/);
    expect(remoteNameProblem("-x", [])).toMatch(/dash/);
    expect(remoteNameProblem("origin", ["origin"])).toMatch(/already exists/);
    expect(remoteNameProblem("origin", ["origin"], "origin")).toBeNull();
    expect(remoteUrlProblem("https://me:tok@host/x.git")).toMatch(/credential helper/);
    expect(remoteUrlProblem("https://me@host/x.git")).toBeNull();
    expect(cloneFolderName("git@github.com:acme/demo.git")).toBe("demo");
    expect(cloneFolderName("https://example.com/a/b/")).toBe("b");
    expect(parentOf("/Users/dev/code/app")).toBe("/Users/dev/code");
    expect(parentOf("C:\\code\\app")).toBe("C:\\code");
  });
});

/** Opens Branches and returns the heading row of a remote's group. */
async function remoteHead(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.keyboard("{Control>}3{/Control}");
  const group = await screen.findByRole("region", { name: `Remote ${name}` });
  return { group, head: within(group).getByRole("heading", { name }).parentElement! };
}

describe("remotes in the Branches view", () => {
  it("shows each remote with its address and fetches one from its menu", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "fetch_remote")
        return { outcome: { updatedRefs: 2, upToDate: false }, repo: REPO };
    });
    const origin = await remoteHead(user, "origin");
    expect(origin.head).toHaveTextContent("github.com · acme/demo · 1 branch");
    expect(
      within(origin.group).getByRole("list", { name: "Branches on origin" }),
    ).toBeInTheDocument();
    const mirror = await remoteHead(user, "mirror");
    expect(mirror.head).toHaveTextContent("gitlab.com · acme/demo · 0 branches");
    expect(mirror.group).toHaveTextContent("No branches yet. Fetch mirror to see them.");
    // "Add remote" sits on the first remote's heading only.
    expect(within(origin.head).getByRole("button", { name: "Add remote" })).toBeInTheDocument();
    expect(within(mirror.head).queryByRole("button", { name: "Add remote" })).toBeNull();
    await user.click(
      within(mirror.head).getByRole("button", { name: "More actions for remote mirror" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Fetch mirror/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "fetch_remote")?.args.remote).toBe("mirror"),
    );
    expect(await screen.findByText("Fetched mirror")).toBeInTheDocument();
  });

  it("has no Remotes view any more", async () => {
    const { user } = await open();
    expect(screen.queryByRole("button", { name: /^Remotes/ })).toBeNull();
    await user.keyboard("{Control>}7{/Control}");
    expect(screen.getByRole("heading", { name: "Changes", level: 1 })).toBeInTheDocument();
  });

  it("adds a remote and fetches it", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "add_remote") return null;
      if (cmd === "fetch_remote")
        return { outcome: { updatedRefs: 0, upToDate: true }, repo: REPO };
      if (cmd === "list_branches") return { local: [], remote: [] };
    }, []);
    await user.keyboard("{Control>}3{/Control}");
    expect(await screen.findByRole("heading", { name: "No remotes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add remote" }));
    const dialog = await screen.findByRole("dialog", { name: "Add remote" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("origin");
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    await user.type(
      within(dialog).getByLabelText("Address"),
      "https://user:secret@github.com/acme/demo.git",
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent("credential helper");
    expect(within(dialog).getByRole("button", { name: "Add remote" })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("Address"));
    await user.type(within(dialog).getByLabelText("Address"), "https://github.com/acme/demo.git");
    await user.click(within(dialog).getByRole("button", { name: "Add remote" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "add_remote")?.args).toEqual({
        repo: REPO.path,
        name: "origin",
        url: "https://github.com/acme/demo.git",
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "fetch_remote")?.args.remote).toBe("origin"),
    );
  });

  it("adds a second remote from the heading", async () => {
    const { user } = await open(undefined, [ORIGIN]);
    const { head } = await remoteHead(user, "origin");
    await user.click(within(head).getByRole("button", { name: "Add remote" }));
    const dialog = await screen.findByRole("dialog", { name: "Add remote" });
    // origin is taken: the name starts empty, with the usual name for a fork's original as hint.
    expect(within(dialog).getByLabelText("Name")).toHaveValue("");
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "upstream");
  });

  it("renames a remote and keeps a hidden token", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "edit_remote") return null;
    });
    const { head } = await remoteHead(user, "mirror");
    await user.click(within(head).getByRole("button", { name: "More actions for remote mirror" }));
    await user.click(await screen.findByRole("menuitem", { name: /Edit remote/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit remote mirror" });
    expect(dialog).toHaveTextContent("Leave it as it is to keep it.");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "gitlab");
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "edit_remote")?.args).toEqual({
        repo: REPO.path,
        name: "mirror",
        newName: "gitlab",
        url: MIRROR.url,
        pushUrl: "",
      }),
    );
  });

  it("removes a remote after confirmation, from a right-click on its heading", async () => {
    const { user, calls } = await open((cmd) => {
      if (cmd === "remove_remote") return null;
    });
    const { head } = await remoteHead(user, "origin");
    await user.pointer({ keys: "[MouseRight]", target: head });
    await user.click(await screen.findByRole("menuitem", { name: /Remove remote/ }));
    const ask = await screen.findByRole("alertdialog", { name: "Remove remote origin?" });
    expect(ask).toHaveTextContent("Nothing changes on the server");
    await user.click(within(ask).getByRole("button", { name: "Remove remote" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "remove_remote")?.args.name).toBe("origin"),
    );
  });
});

describe("clone and new repository", () => {
  it("clones from the welcome screen and opens the result", async () => {
    const user = userEvent.setup();
    const calls = setup((cmd, args) => {
      if (cmd === "clone_repository") return "/Users/dev/projects/demo";
      if (cmd === "inspect_repository") return { ...REPO, path: args.path as string };
      if (cmd === "list_remotes") return [];
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Clone…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clone repository" });
    await user.type(within(dialog).getByLabelText("Address"), "git@github.com:acme/demo.git");
    expect(within(dialog).getByLabelText("Folder name")).toHaveValue("demo");
    await user.type(within(dialog).getByLabelText("Into folder"), "/Users/dev/projects");
    await user.click(within(dialog).getByRole("button", { name: "Clone" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "clone_repository")?.args).toMatchObject({
        url: "git@github.com:acme/demo.git",
        dest: "/Users/dev/projects/demo",
      }),
    );
    await waitFor(() => expect(calls.some((c) => c.cmd === "inspect_repository")).toBe(true));
  });

  it("explains a failed sign-in", async () => {
    const user = userEvent.setup();
    setup((cmd) => {
      if (cmd === "clone_repository")
        return Promise.reject({
          kind: "authFailed",
          message: "Git could not sign in to the remote.",
          detail: null,
        });
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Clone…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clone repository" });
    await user.type(within(dialog).getByLabelText("Address"), "https://example.com/x.git");
    await user.type(within(dialog).getByLabelText("Into folder"), "/tmp");
    await user.click(within(dialog).getByRole("button", { name: "Clone" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("credential helper");
  });

  it("creates a repository", async () => {
    const user = userEvent.setup();
    const calls = setup((cmd, args) => {
      if (cmd === "init_repository") return "/Users/dev/new";
      if (cmd === "inspect_repository") return { ...REPO, path: args.path as string };
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "New repository…" }));
    const dialog = await screen.findByRole("dialog", { name: "New repository" });
    await user.type(within(dialog).getByLabelText("Folder"), "/Users/dev/new");
    await user.click(within(dialog).getByRole("button", { name: "Create repository" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "init_repository")?.args).toEqual({
        path: "/Users/dev/new",
        branch: "main",
      }),
    );
  });
});
