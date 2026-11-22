import type { ChangeEntry } from "./changeModel";

/** One line of a file tree: a folder, or a file inside the folders above it. */
export type TreeLine =
  | {
      type: "folder";
      /** Full folder path ("src/utils"); unique within its list. */
      path: string;
      /** What is shown: one folder, or a chain of single folders ("src/utils"). */
      name: string;
      depth: number;
      /** Every file below this folder, at any depth. */
      entries: ChangeEntry[];
    }
  | { type: "file"; entry: ChangeEntry; depth: number };

interface Node {
  folders: Map<string, Node>;
  files: ChangeEntry[];
}

const newNode = (): Node => ({ folders: new Map(), files: [] });

function allFiles(node: Node): ChangeEntry[] {
  return [...[...node.folders.values()].flatMap(allFiles), ...node.files];
}

/**
 * Lay out a list of changed files as a tree: folders first (sorted by name), then files.
 * A folder that only holds one other folder is shown together with it ("src/utils"), as in
 * most editors. Folders in `collapsed` hide what is below them.
 */
export function fileTree(entries: ChangeEntry[], collapsed: ReadonlySet<string>): TreeLine[] {
  const root = newNode();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      let next = node.folders.get(part);
      if (!next) {
        next = newNode();
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(entry);
  }

  const lines: TreeLine[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    const folders = [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, child] of folders) {
      let shown = name;
      let inner = child;
      // Join a chain of folders that each hold only one folder.
      while (inner.files.length === 0 && inner.folders.size === 1) {
        const [nextName, next] = [...inner.folders.entries()][0]!;
        shown = `${shown}/${nextName}`;
        inner = next;
      }
      const path = prefix ? `${prefix}/${shown}` : shown;
      lines.push({ type: "folder", path, name: shown, depth, entries: allFiles(inner) });
      if (!collapsed.has(path)) walk(inner, path, depth + 1);
    }
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of files) lines.push({ type: "file", entry, depth });
  };
  walk(root, "", 0);
  return lines;
}

/** The files of the folder that holds `entry`, in the same list; empty for a top-level file. */
export function folderOf(entry: ChangeEntry, list: ChangeEntry[]): ChangeEntry[] {
  const slash = entry.path.lastIndexOf("/");
  if (slash < 0) return [];
  const dir = entry.path.slice(0, slash + 1);
  return list.filter((e) => e.path.startsWith(dir));
}
