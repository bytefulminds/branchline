import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";
import { diffFor, installTauriTestEnvironment, openButton, REPO, setup } from "../../test/harness";
import type { DiffArea, DiffLine, FileDiff } from "../../types/git";
import { splitRows } from "./diffModel";
import { highlightDiff, languageFor, loadHighlighter } from "./syntax";

installTauriTestEnvironment();

const line = (
  kind: DiffLine["kind"],
  content: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine => ({
  kind,
  content,
  oldLine,
  newLine,
  noNewline: false,
  crlf: false,
});

/** A TypeScript change: one line replaced, one added, with a comment spanning two lines. */
function tsDiff(args: { path: string; area: DiffArea }): FileDiff {
  const base = diffFor(args);
  return {
    ...base,
    hunks: [
      {
        ...base.hunks[0]!,
        lines: [
          line("context", "/* first", 1, 1),
          line("context", "   second */", 2, 2),
          line("delete", 'const name = "old";', 3, null),
          line("add", 'const name = "new";', null, 3),
          line("add", "export default name;", null, 4),
        ],
      },
    ],
  };
}

async function openDiff(settings: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const calls = setup((cmd, args) => {
    if (cmd === "plugin:dialog|open") return REPO.path;
    if (cmd === "inspect_repository") return REPO;
    if (cmd === "get_settings") return { editor: settings };
    if (cmd === "file_diff") return tsDiff(args as { path: string; area: DiffArea });
    return undefined;
  });
  render(<App />);
  await user.click(openButton());
  await user.click(await screen.findByText("app.ts"));
  await screen.findByRole("region", { name: "Changes in src/app.ts" });
  return { user, calls };
}

describe("diff layout", () => {
  it("switches to side by side, pairs lines and saves the choice", async () => {
    const { user, calls } = await openDiff();
    expect(screen.getByRole("button", { name: "One column" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Side by side" }));
    const left = await screen.findByLabelText("Old version");
    const right = screen.getByLabelText("New version");
    expect(left).toHaveTextContent('const name = "old";');
    expect(left).not.toHaveTextContent('"new"');
    expect(right).toHaveTextContent('const name = "new";');
    expect(right).toHaveTextContent("export default name;");
    // The added line without a removed partner leaves an empty row on the left.
    expect(left.querySelectorAll(".bl-diff-row--empty")).toHaveLength(1);
    expect(
      calls.some(
        (c) =>
          c.cmd === "save_settings" &&
          (c.args.value as { editor: { diffLayout: string } }).editor.diffLayout === "split",
      ),
    ).toBe(true);
  });

  it("selects lines for staging on either side", async () => {
    const { user } = await openDiff({ diffLayout: "split" });
    const left = await screen.findByLabelText("Old version");
    const right = screen.getByLabelText("New version");
    // Syntax colors split the text into pieces, so find rows by their whole text.
    const row = (column: HTMLElement, text: string) =>
      [...column.querySelectorAll<HTMLElement>(".bl-diff-row")].find((r) =>
        r.textContent?.includes(text),
      )!;
    await user.click(row(left, '"old"'));
    await user.click(row(right, "export default name;"));
    expect(screen.getByText("2 lines selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stage lines" })).toBeEnabled();
  });

  it("colors code by language and leaves it plain when turned off", async () => {
    await openDiff();
    const region = screen.getByRole("region", { name: "Changes in src/app.ts" });
    // Grammars load lazily, then the keyword gets its color class.
    const keyword = await within(region).findAllByText("const", { selector: ".hljs-keyword" });
    expect(keyword.length).toBeGreaterThan(0);
    // The comment that starts on the line above is still a comment on the second line.
    expect(within(region).getByText("second */", { exact: false })).toHaveClass("hljs-comment");
  });

  it("shows plain text with syntax highlighting off", async () => {
    await openDiff({ syntaxHighlighting: false });
    await loadHighlighter();
    const region = screen.getByRole("region", { name: "Changes in src/app.ts" });
    expect(region.querySelector("[class^='hljs-']")).toBeNull();
  });
});

describe("syntax", () => {
  it("picks grammars from names and extensions", () => {
    expect(languageFor("src/App.tsx")).toBe("typescript");
    expect(languageFor("lib/main.RS")).toBe("rust");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("build/Makefile")).toBe("makefile");
    expect(languageFor(".zshrc")).toBe("bash");
    expect(languageFor("LICENSE")).toBeNull();
    expect(languageFor("notes.unknown")).toBeNull();
  });

  it("highlights each side of a hunk as a whole and maps tokens back to lines", async () => {
    const lowlight = await loadHighlighter();
    const diff = tsDiff({ path: "a.ts", area: "unstaged" });
    const syntax = highlightDiff(diff, "typescript", lowlight);
    const lines = diff.hunks[0]!.lines;
    syntax[0]!.forEach((tokens, i) =>
      expect(tokens!.map((t) => t.text).join("")).toBe(lines[i]!.content),
    );
    expect(syntax[0]![2]!.find((t) => t.text === '"old"')?.className).toBe("hljs-string");
    expect(splitRows(diff).filter((r) => r.type === "pair")).toHaveLength(4);
  });
});

describe("keyboard line selection", () => {
  it("moves between changed lines with the arrows and selects with Space", async () => {
    const { user } = await openDiff();
    const diff = screen.getByRole("region", { name: "Changes in src/app.ts" });
    const body = within(diff).getByLabelText("Diff");
    expect(body).toHaveAccessibleDescription(/Arrow keys move between changed lines/);
    body.focus();
    await user.keyboard("{ArrowDown}");
    // The first changed line, skipping the unchanged ones above it.
    expect(screen.getByText(/^Removed line 3:/)).toHaveTextContent(
      'const name = "old";, not selected',
    );
    await user.keyboard(" ");
    expect(screen.getByText("1 line selected")).toBeInTheDocument();
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(screen.getByText("3 lines selected")).toBeInTheDocument();
    expect(screen.getByText(/^Added line 4:/)).toHaveTextContent("selected");
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/lines? selected/)).toBeNull();
  });
});
