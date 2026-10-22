/**
 * Syntax highlighting for diffs.
 *
 * The grammars (highlight.js through lowlight) load on first use, so they do not slow
 * down startup. Each hunk is highlighted as two whole blocks of code, the old version
 * (unchanged and removed lines) and the new version (unchanged and added lines), so
 * strings and comments that span lines are colored correctly within a hunk.
 */
import { useEffect, useState } from "react";
import type { FileDiff } from "../../types/git";

/** A piece of a line with the highlight.js class that colors it (empty: plain text). */
export interface SyntaxToken {
  text: string;
  className: string;
}

/** Tokens per hunk and line; `null` for a line that was not highlighted. */
export type DiffSyntax = (SyntaxToken[] | null)[][];

/** Diffs larger than this are shown without colors, to stay responsive. */
export const SYNTAX_LIMITS = { characters: 400_000, lineLength: 2_000 };

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  pyi: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  plist: "xml",
  csproj: "xml",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  graphql: "graphql",
  gql: "graphql",
  mk: "makefile",
  m: "objectivec",
  mm: "objectivec",
  vb: "vbnet",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
};

/** The grammar for a file, from its name or extension; null when there is none. */
export function languageFor(path: string): string | null {
  const name = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

type Lowlight = ReturnType<(typeof import("lowlight"))["createLowlight"]>;
let loading: Promise<Lowlight> | null = null;

/** Loads the grammars once; later calls share the same promise. */
export function loadHighlighter(): Promise<Lowlight> {
  loading ??= Promise.all([
    import("lowlight"),
    import("highlight.js/lib/languages/dockerfile"),
  ]).then(([{ createLowlight, common }, dockerfile]) => {
    const lowlight = createLowlight(common);
    lowlight.register("dockerfile", dockerfile.default);
    return lowlight;
  });
  return loading;
}

interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  properties?: { className?: string[] | string };
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** Flatten a highlighted tree into lines of tokens (the innermost class wins). */
export function toLines(root: { children: HastNode[] }): SyntaxToken[][] {
  const lines: SyntaxToken[][] = [[]];
  const walk = (nodes: HastNode[], className: string) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const parts = (node as HastText).value.split("\n");
        parts.forEach((text, i) => {
          if (i > 0) lines.push([]);
          if (text) lines[lines.length - 1]!.push({ text, className });
        });
      } else if (node.type === "element") {
        const el = node as HastElement;
        const cls = el.properties?.className;
        const own = Array.isArray(cls) ? cls.join(" ") : (cls ?? "");
        walk(el.children, own || className);
      } else if ("children" in node && node.children) {
        walk(node.children, className);
      }
    }
  };
  walk(root.children, "");
  return lines;
}

/** Whether a diff is small enough to color. */
export function canHighlight(diff: FileDiff): boolean {
  let total = 0;
  for (const h of diff.hunks)
    for (const l of h.lines) {
      if (l.content.length > SYNTAX_LIMITS.lineLength) return false;
      total += l.content.length + 1;
      if (total > SYNTAX_LIMITS.characters) return false;
    }
  return true;
}

/** Highlight every hunk of `diff` with `language`. */
export function highlightDiff(diff: FileDiff, language: string, lowlight: Lowlight): DiffSyntax {
  return diff.hunks.map((hunk) => {
    const side = (keep: (kind: string) => boolean) => {
      const index: number[] = [];
      const text: string[] = [];
      hunk.lines.forEach((l, i) => {
        if (keep(l.kind)) {
          index.push(i);
          text.push(l.content);
        }
      });
      const lines = text.length
        ? toLines(lowlight.highlight(language, text.join("\n")) as { children: HastNode[] })
        : [];
      return { index, lines };
    };
    const result: (SyntaxToken[] | null)[] = hunk.lines.map(() => null);
    for (const { index, lines } of [side((k) => k !== "add"), side((k) => k !== "delete")])
      index.forEach((lineIndex, n) => {
        // Unchanged lines appear on both sides; the new side (second) wins.
        result[lineIndex] = lines[n] ?? null;
      });
    return result;
  });
}

/**
 * Colors for a diff, once the grammars are loaded. `null` while loading, when turned off,
 * for unknown languages and for very large diffs.
 */
export function useDiffSyntax(
  diff: FileDiff | null,
  path: string,
  enabled: boolean,
): DiffSyntax | null {
  const [result, setResult] = useState<{ diff: FileDiff; syntax: DiffSyntax } | null>(null);
  const language = enabled ? languageFor(path) : null;
  useEffect(() => {
    if (!diff || !language || diff.isBinary || !canHighlight(diff)) return;
    let cancelled = false;
    loadHighlighter()
      .then((lowlight) => {
        if (cancelled || !lowlight.registered(language)) return;
        setResult({ diff, syntax: highlightDiff(diff, language, lowlight) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [diff, language]);
  return language && result?.diff === diff ? result.syntax : null;
}
