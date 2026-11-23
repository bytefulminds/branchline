import {
  Check,
  Cherry,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  FolderPlus,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  ListOrdered,
  LogIn,
  Route,
  PanelRightClose,
  PanelRightOpen,
  Tag,
  SearchX,
  Trash2,
  Pencil,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { useContextMenu } from "../../components/ContextMenu";
import type { MenuEntry } from "../../components/Menu";
import { useBranchActions } from "../branches/BranchActions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { isPrimaryModifier } from "../../services/platform";
import type { LogFilter } from "../../types/git";
import { activeFilterCount, HistoryFilterBar, HistorySearch } from "./HistoryFilters";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { Splitter } from "../../components/Splitter";
import { usePersistentFlag } from "../../lib/usePersistentFlag";
import { usePersistentNumber } from "../../lib/usePersistentNumber";
import type { CommitFile, RepositoryInfo } from "../../types/git";
import { CommitDetailsPanel } from "./CommitDetailsPanel";
import { CommitDiffView } from "./CommitDiffView";
import { useTagActions } from "../tags/TagActions";
import { useIntegrateActions } from "../integrate/IntegrateActions";
import { useSelfReview } from "../quest/useSelfReview";
import { useRefDrop } from "../integrate/refDrag";
import { useWorktreeActions } from "../worktrees/WorktreeActions";
import { CommitList, graphColumnWidth, WorkInProgressRow } from "./CommitList";
import { cherryPickProblem, MultiSelectionPanel } from "./MultiSelectionPanel";
import { EMPTY_SELECTION, nextSelection, oldestFirst, single, type SelectMode } from "./selection";
import { EMPTY_FILTER, isFiltering, useHistory, type HistoryData } from "./useHistory";
import { TRUNK_SEGMENT } from "./graph";
import { MergedFoldedIcon, MergedShownIcon } from "./graphIcons";
import "./HistoryView.css";

const NO_OIDS: ReadonlySet<string> = new Set();

/** A name for a followed branch segment: a branch at its tip, or the merge that merged it. */
export function followedName(data: HistoryData, segment: number, current: string | null): string {
  const index = data.rows.findIndex((r) => r.segment === segment);
  if (index < 0) return "this branch";
  const row = data.rows[index]!;
  const refs = (data.refsByOid.get(data.commits[index]!.oid) ?? []).filter((r) => r.kind !== "tag");
  const local = refs.filter((r) => r.kind === "branch");
  const named =
    local.find((r) => r.name === current) ?? local[0] ?? refs.find((r) => r.kind === "remote");
  if (named) return named.name;
  if (row.mergedBy) {
    const merge = data.commits.find((c) => c.oid === row.mergedBy);
    const from = merge?.summary.match(
      /^Merge (?:branch|remote-tracking branch) '([^']+)'|^Merge pull request #\d+ from \S+?\/(\S+)/,
    );
    const name = from?.[1] ?? from?.[2];
    return name ? `${name} (merged)` : "a merged branch";
  }
  return segment === TRUNK_SEGMENT ? "the default branch" : "a branch without a name";
}

/** Search and filters per repository, kept while switching views. */
const savedFilters = new Map<string, { filter: LogFilter; open: boolean }>();

let searchRequested = false;
const searchListeners = new Set<() => void>();

/** Focus the History search box: now if History is shown, otherwise when it opens. */
export function requestHistorySearch() {
  if (searchListeners.size) searchListeners.forEach((focus) => focus());
  else searchRequested = true;
}

/** Make History open filtered to this file or folder (the next time it is shown). */
export function showFileHistory(repoPath: string, path: string) {
  savedFilters.set(repoPath, { filter: { ...EMPTY_FILTER, path }, open: true });
}

/** A commit to select and scroll to the next time History opens, per repository. */
const pendingReveal = new Map<string, string>();

/** Make History open on this commit, selected and in view, with any search cleared. */
export function showCommitInHistory(repoPath: string, oid: string) {
  const open = savedFilters.get(repoPath)?.open ?? false;
  savedFilters.set(repoPath, { filter: EMPTY_FILTER, open });
  pendingReveal.set(repoPath, oid);
}

/** Test helper: forget searches. */
export function resetHistoryFilters() {
  savedFilters.clear();
  pendingReveal.clear();
}

/** The columns after Description, which can be resized and hidden. */
const COLUMNS = [
  { id: "author", label: "Author", initial: 160, min: 80, max: 360 },
  { id: "date", label: "Date", initial: 110, min: 64, max: 220 },
  { id: "sha", label: "Commit", initial: 72, min: 60, max: 160 },
] as const;
type ColumnId = (typeof COLUMNS)[number]["id"];

/** Room the description keeps before other columns make way in a narrow window. */
const MIN_DESCRIPTION = 180;
/** Gaps and padding of a row: 4 column gaps of 12px and 20px padding. */
const ROW_CHROME = 68;

/**
 * Widths and visibility of the History columns, remembered per device. In a list narrower
 * than `listWidth` needs, Commit, then Date, then Author make way for the description
 * (without changing what was chosen).
 */
/** Narrowest graph column: the width of its "Graph" label, about three lanes. */
export const GRAPH_MIN = 48;

function useHistoryColumns(listWidth: number | null, graphFit: number) {
  // 0 means "fit all lanes"; a set width never exceeds what the lanes need.
  const [graphSet, setGraphSet] = usePersistentNumber("branchline.history.graphWidth", 0);
  const graphMax = Math.max(graphFit, GRAPH_MIN);
  const graphWidth = graphSet > 0 ? Math.min(Math.max(graphSet, GRAPH_MIN), graphMax) : graphMax;
  const setGraphWidth = (v: number) => setGraphSet(v >= graphMax ? 0 : Math.max(v, GRAPH_MIN));
  const [author, setAuthor] = usePersistentNumber("branchline.history.authorWidth", 160);
  const [date, setDate] = usePersistentNumber("branchline.history.dateWidth", 110);
  const [sha, setSha] = usePersistentNumber("branchline.history.shaWidth", 72);
  const [hideAuthor, setHideAuthor] = usePersistentFlag("branchline.history.hideAuthor", false);
  const [hideDate, setHideDate] = usePersistentFlag("branchline.history.hideDate", false);
  const [hideSha, setHideSha] = usePersistentFlag("branchline.history.hideSha", false);
  const width: Record<ColumnId, number> = { author, date, sha };
  const chosen: Record<ColumnId, boolean> = { author: hideAuthor, date: hideDate, sha: hideSha };
  const hidden = { ...chosen };
  if (listWidth !== null) {
    const used = () =>
      graphWidth + ROW_CHROME + COLUMNS.reduce((n, c) => n + (hidden[c.id] ? 0 : width[c.id]), 0);
    for (const id of ["sha", "date", "author"] as const) {
      if (listWidth - used() >= MIN_DESCRIPTION) break;
      hidden[id] = true;
    }
  }
  const setWidth = (id: ColumnId, v: number) =>
    ({ author: setAuthor, date: setDate, sha: setSha })[id](v);
  const setHidden = (id: ColumnId, v: boolean) =>
    ({ author: setHideAuthor, date: setHideDate, sha: setHideSha })[id](v);
  const template = [
    "var(--graph-width, 34px)",
    "minmax(0, 1fr)",
    ...COLUMNS.filter((c) => !hidden[c.id]).map((c) => `${width[c.id]}px`),
  ].join(" ");
  const menu: MenuEntry[] = [
    { type: "header", id: "columns", label: "Columns" },
    ...COLUMNS.map<MenuEntry>((c) => ({
      id: `column-${c.id}`,
      label: c.label,
      checked: !chosen[c.id],
      toggle: true,
      description:
        hidden[c.id] && !chosen[c.id] ? "Hidden for now: the window is too narrow" : undefined,
      onSelect: () => setHidden(c.id, !chosen[c.id]),
    })),
    { type: "separator", id: "sep-columns" },
    {
      id: "column-reset",
      label: "Reset columns",
      onSelect: () => {
        setGraphSet(0);
        COLUMNS.forEach((c) => {
          setWidth(c.id, c.initial);
          setHidden(c.id, false);
        });
      },
    },
  ];
  return {
    graph: {
      width: graphWidth,
      max: graphMax,
      clipped: graphWidth < graphFit,
      set: setGraphWidth,
      fit: () => setGraphSet(0),
    },
    width,
    hidden,
    setWidth,
    template,
    menu,
    classes: COLUMNS.filter((c) => hidden[c.id]).map((c) => `bl-history--no-${c.id}`),
  };
}

export function HistoryView({
  repo,
  onShowChanges,
}: {
  repo: RepositoryInfo;
  onShowChanges: () => void;
}) {
  const saved = savedFilters.get(repo.path);
  // Read once: the commit that "Show in History" asked for.
  const [shownCommit] = useState(() => {
    const oid = pendingReveal.get(repo.path) ?? null;
    pendingReveal.delete(repo.path);
    return oid;
  });
  const [filter, setFilter] = useState<LogFilter>(saved?.filter ?? EMPTY_FILTER);
  const [filtersOpen, setFiltersOpen] = useState(saved?.open ?? false);
  useEffect(() => {
    savedFilters.set(repo.path, { filter, open: filtersOpen });
  }, [repo.path, filter, filtersOpen]);
  // Typing only searches once it pauses; clearing everything applies at once.
  const debounced = useDebouncedValue(filter, 300);
  const applied = isFiltering(filter) ? debounced : EMPTY_FILTER;
  const [collapseMerged, setCollapseMerged] = usePersistentFlag(
    "branchline.history.collapseMerged",
    false,
  );
  // Merges whose side branch is shown although merged branches are collapsed.
  const [expanded, setExpanded] = useState<{ path: string; oids: ReadonlySet<string> }>({
    path: repo.path,
    oids: new Set(),
  });
  const expandedOids = expanded.path === repo.path ? expanded.oids : NO_OIDS;
  const toggleFold = useCallback(
    (oid: string) =>
      setExpanded((e) => {
        const oids = new Set(e.path === repo.path ? e.oids : []);
        if (!oids.delete(oid)) oids.add(oid);
        return { path: repo.path, oids };
      }),
    [repo.path],
  );
  const folding = collapseMerged && !isFiltering(applied);
  const view = useMemo(
    () => ({ collapse: folding, expanded: expandedOids }),
    [folding, expandedOids],
  );
  const history = useHistory(repo, applied, view);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f" && isPrimaryModifier(e) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    // After the command palette closes and gives focus back.
    const focusSearch = () =>
      window.setTimeout(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }, 0);
    searchListeners.add(focusSearch);
    if (searchRequested) {
      searchRequested = false;
      focusSearch();
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      searchListeners.delete(focusSearch);
    };
  }, []);
  const branchActions = useBranchActions();
  const showMenu = useContextMenu();
  const [selection, setSelection] = useState(() =>
    shownCommit ? single(shownCommit) : EMPTY_SELECTION,
  );
  const [openFile, setOpenFile] = useState<{ oid: string; file: CommitFile } | null>(null);
  const [detailsWidth, setDetailsWidth] = usePersistentNumber(
    "branchline.layout.commitDetailsWidth",
    400,
  );
  const [detailsOpen, setDetailsOpen] = usePersistentFlag(
    "branchline.layout.commitDetailsOpen",
    true,
  );
  const mainRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = mainRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setListWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { data, loadMore } = history;
  // A new search starts with nothing selected (the first result is shown).
  const appliedKey = JSON.stringify(applied);
  const [selectionFor, setSelectionFor] = useState(appliedKey);
  // A commit to show in the middle of the list once it is loaded.
  const [reveal, setReveal] = useState<string | null>(shownCommit);
  if (selectionFor !== appliedKey) {
    setSelectionFor(appliedKey);
    // Clearing the search keeps the commit picked from the results, among its neighbours.
    const keep = !isFiltering(applied) ? selection.focus : null;
    setSelection(keep ? single(keep) : EMPTY_SELECTION);
    setReveal(keep);
    setOpenFile(null);
  }
  const clearReveal = useCallback(() => setReveal(null), []);
  // Hidden in a collapsed merged branch: open the merges around it.
  const revealIn = reveal && data && !data.filtered ? data.hiddenBy.get(reveal) : undefined;
  if (revealIn && revealIn.some((m) => !expandedOids.has(m))) {
    setExpanded({ path: repo.path, oids: new Set([...expandedOids, ...revealIn]) });
  }
  const { loadThrough } = history;
  useEffect(() => {
    if (!reveal || !data || data.filtered) return;
    if (data.commits.some((c) => c.oid === reveal)) return; // the list scrolls to it
    if (data.hiddenBy.has(reveal)) return; // opened above
    let stale = false;
    void loadThrough(reveal).then((found) => {
      if (!found && !stale) setReveal(null);
    });
    return () => {
      stale = true;
    };
  }, [reveal, data, loadThrough]);

  // The followed branch; segment ids belong to one layout, so it ends when that changes.
  const layoutKey = `${data?.key}|${folding}|${[...expandedOids].join(",")}`;
  const [followed, setFollowed] = useState<{ key: string; segment: number } | null>(null);
  const follow = followed?.key === layoutKey ? followed.segment : null;
  const setFollow = useCallback(
    (segment: number | null) => setFollowed(segment === null ? null : { key: layoutKey, segment }),
    [layoutKey],
  );
  const followCount = useMemo(
    () => (follow === null || !data ? 0 : data.rows.filter((r) => r.segment === follow).length),
    [data, follow],
  );

  const order = useMemo(() => data?.commits.map((c) => c.oid) ?? [], [data]);
  // Commits reachable from HEAD among those loaded: the ones "Drop commit" can remove.
  const headOid = repo.head.kind === "unborn" ? null : repo.head.oid;
  const onCurrentBranch = useCallback(
    (oid: string) => {
      if (!data || !headOid) return false;
      const byOid = new Map(data.commits.map((c) => [c.oid, c]));
      const seen = new Set<string>();
      const todo = [headOid];
      while (todo.length) {
        const o = todo.pop()!;
        if (o === oid) return true;
        if (seen.has(o)) continue;
        seen.add(o);
        todo.push(...(byOid.get(o)?.parents ?? []));
      }
      return false;
    },
    [data, headOid],
  );
  const select = useCallback(
    (oid: string, mode: SelectMode = "replace") => {
      setSelection((current) =>
        // Nothing chosen yet: the newest commit is the one shown, so ranges start there.
        nextSelection(current.focus || !order[0] ? current : single(order[0]), oid, mode, order),
      );
      setOpenFile(null);
    },
    [order],
  );

  const selected = selection.focus ?? data?.commits[0]?.oid ?? null;
  // Selected commits still in the list (a refresh can remove some), oldest first.
  const picked = useMemo(() => {
    if (!data || selection.oids.size < 2) return [];
    const byOid = new Map(data.commits.map((c) => [c.oid, c]));
    return oldestFirst(selection.oids, order).map((o) => byOid.get(o)!);
  }, [data, order, selection.oids]);
  const mergeOids = useMemo(
    () => new Set(data?.commits.filter((_, i) => data.rows[i]?.isMerge).map((c) => c.oid)),
    [data],
  );
  const clearSelection = useCallback(
    () => setSelection((s) => (s.focus ? single(s.focus) : EMPTY_SELECTION)),
    [],
  );

  const tagActions = useTagActions();
  const integrate = useIntegrateActions();
  const reviewBranch = useSelfReview(repo);
  const worktrees = useWorktreeActions();
  const drop = useRefDrop(repo);
  const current = repo.head.kind === "branch" ? repo.head.name : null;
  const busyOp = repo.operation !== null;
  const pickProblem = cherryPickProblem({
    commits: picked,
    mergeOids,
    busy: busyOp,
    unborn: repo.head.kind === "unborn",
  });
  const target = current ?? "the detached HEAD";
  const pickMany = () => {
    integrate.cherryPickMany(picked.map((c) => c.oid));
  };
  /** Drop all selected commits of the current branch at once. */
  const dropManyEntry = (): MenuEntry => {
    const problem = picked.map((c) => rewriteProblem(c.oid)).find((p) => p !== null) ?? null;
    const oldest = picked[0];
    return {
      id: "drop-many",
      label: `Drop ${picked.length} commits…`,
      description: problem ?? `Remove them from ${current}, keep the commits after them`,
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: !!problem || busyOp,
      onSelect: () =>
        integrate.dropCommits(
          picked.map((c) => c.oid),
          oldest!.parents[0]!,
        ),
    };
  };
  const multiMenu = (): MenuEntry[] => [
    {
      id: "cherry-pick-many",
      label: `Cherry-pick ${picked.length} commits onto ${target}…`,
      description: pickProblem ?? "Oldest first",
      icon: <Cherry size={16} />,
      disabled: !!pickProblem,
      onSelect: pickMany,
    },
    dropManyEntry(),
    { type: "separator", id: "sep-multi" },
    {
      id: "copy-many",
      label: "Copy commit ids",
      icon: <Copy size={16} />,
      onSelect: () =>
        void navigator.clipboard?.writeText(picked.map((c) => c.oid).join("\n")).catch(() => {}),
    },
    {
      id: "clear",
      label: "Keep only this commit",
      icon: <X size={16} />,
      onSelect: clearSelection,
    },
  ];
  /** Why a commit cannot be rewritten (edited, moved or dropped) on its own, or null. */
  const rewriteProblem = (oid: string) => {
    const commit = data?.commits.find((c) => c.oid === oid);
    return !current
      ? "Switch to a branch first"
      : !commit || !onCurrentBranch(oid)
        ? `Not a commit of ${current}`
        : commit.parents.length === 0
          ? "The first commit cannot be changed here"
          : commit.parents.length > 1
            ? "Merge commits cannot be changed here"
            : null;
  };

  /** Edit the message, move up or down, drop: one commit of the current branch, without the plan. */
  const rewriteEntries = (oid: string): MenuEntry[] => {
    const commit = data?.commits.find((c) => c.oid === oid);
    const why = rewriteProblem(oid);
    const parent = commit && data?.commits.find((c) => c.oid === commit.parents[0]);
    const downWhy =
      why ??
      (!parent
        ? "The commit before it is not loaded"
        : parent.parents.length !== 1
          ? "The commit before it cannot be moved"
          : null);
    const upWhy = why ?? (oid === headOid ? `It is the newest commit of ${current}` : null);
    return [
      {
        id: "reword",
        label: "Edit commit message…",
        description: why ?? undefined,
        icon: <Pencil size={16} />,
        disabled: !!why || busyOp,
        onSelect: () => integrate.reword(oid, commit!.parents[0]!),
      },
      {
        id: "move-up",
        label: "Move commit up",
        description: upWhy ?? "Swap it with the newer commit above it",
        icon: <ArrowUp size={16} />,
        disabled: !!upWhy || busyOp,
        onSelect: () => integrate.move(oid, "up", commit!.parents[0]!),
      },
      {
        id: "move-down",
        label: "Move commit down",
        description: downWhy ?? "Swap it with the older commit below it",
        icon: <ArrowDown size={16} />,
        disabled: !!downWhy || busyOp,
        onSelect: () => integrate.move(oid, "down", parent!.parents[0]!),
      },
      {
        id: "drop",
        label: "Drop commit…",
        description: why ?? `Remove it from ${current}, keep the commits after it`,
        icon: <Trash2 size={16} />,
        danger: true,
        disabled: !!why || busyOp,
        onSelect: () => integrate.dropCommits([oid], commit!.parents[0]!),
      },
    ];
  };

  /** Reset the current branch to this commit, soft, mixed or hard. */
  const resetEntry = (oid: string): MenuEntry => {
    const target = current ?? "HEAD";
    return {
      type: "submenu",
      id: "reset",
      label: `Reset ${target} to this commit`,
      icon: <RotateCcw size={16} />,
      disabled: busyOp || repo.head.kind === "unborn",
      entries: [
        {
          id: "reset-soft",
          label: "Soft",
          description: "Keep the changes staged",
          onSelect: () => integrate.resetTo(oid, "soft"),
        },
        {
          id: "reset-mixed",
          label: "Mixed",
          description: "Keep the changes, unstaged",
          onSelect: () => integrate.resetTo(oid, "mixed"),
        },
        {
          id: "reset-hard",
          label: "Hard",
          description: "Discard all changes",
          danger: true,
          onSelect: () => integrate.resetTo(oid, "hard"),
        },
      ],
    };
  };

  const commitMenu = (oid: string): MenuEntry[] => {
    const short = oid.slice(0, 7);
    const localBranches = (data?.refsByOid.get(oid) ?? []).filter((r) => r.kind === "branch");
    const headOid = repo.head.kind === "unborn" ? null : repo.head.oid;
    const index = data ? data.commits.findIndex((c) => c.oid === oid) : -1;
    const segment = index >= 0 && data && !data.filtered ? data.rows[index]!.segment : null;
    const fold = folding ? data?.folds.get(oid) : undefined;
    const graphEntries: MenuEntry[] = [
      ...(segment !== null
        ? [
            {
              id: "follow",
              label: follow === segment ? "Stop following this branch" : "Follow this branch",
              description: follow === segment ? undefined : "Highlight its commits in the graph",
              icon: <Route size={16} />,
              onSelect: () => setFollow(follow === segment ? null : segment),
            },
          ]
        : []),
      ...(fold
        ? [
            {
              id: "fold",
              label: fold.expanded
                ? "Hide the merged commits"
                : `Show the ${fold.count.toLocaleString()} merged ${fold.count === 1 ? "commit" : "commits"}`,
              icon: fold.expanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />,
              onSelect: () => toggleFold(oid),
            },
          ]
        : []),
    ];
    return [
      ...graphEntries,
      ...(graphEntries.length ? [{ type: "separator" as const, id: "sep-graph" }] : []),
      ...localBranches.map<MenuEntry>((r) => ({
        id: `switch:${r.name}`,
        label: `Switch to ${r.name}`,
        icon: <Check size={16} />,
        disabled: repo.head.kind === "branch" && repo.head.name === r.name,
        onSelect: () => branchActions.switchTo(r.name),
      })),
      {
        id: "create",
        label: "Create branch here…",
        icon: <GitBranchPlus size={16} />,
        onSelect: () => branchActions.create({ kind: "commit", oid }, `commit ${short}`),
      },
      {
        id: "worktree",
        label: "Create worktree here…",
        description: "A second folder starting at this commit",
        icon: <FolderPlus size={16} />,
        disabled: busyOp,
        onSelect: () =>
          worktrees.create({
            mode: "new",
            start: { kind: "commit", oid },
            startLabel: `commit ${short}`,
          }),
      },
      {
        id: "detach",
        label: "Check out this commit…",
        icon: <LogIn size={16} />,
        disabled: oid === headOid,
        onSelect: () => branchActions.checkoutCommit(oid),
      },
      { type: "separator", id: "sep-integrate" },
      {
        id: "merge",
        label: current ? `Merge into ${current}…` : "Merge into current…",
        icon: <GitMerge size={16} />,
        disabled: oid === headOid || busyOp,
        onSelect: () => integrate.merge({ kind: "commit", oid }, `commit ${short}`),
      },
      {
        id: "rebase",
        label: current ? `Rebase ${current} onto this commit…` : "Rebase onto this commit…",
        icon: <GitPullRequestArrow size={16} />,
        disabled: !current || oid === headOid || busyOp,
        onSelect: () => integrate.rebase({ kind: "commit", oid }, `commit ${short}`),
      },
      ...(oid === headOid && current && reviewBranch
        ? [
            {
              id: "self-review",
              label: `Review ${current} with AI…`,
              description: "A review quest on this branch's own commits",
              icon: <Sparkles size={16} />,
              disabled: busyOp,
              onSelect: reviewBranch,
            },
          ]
        : []),
      ...(oid === headOid && current
        ? [
            {
              id: "rewrite",
              label: `Rewrite history of ${current}…`,
              description: "Squash, reword, reorder or drop the commits of this branch",
              icon: <ListOrdered size={16} />,
              disabled: busyOp,
              onSelect: () => integrate.rewriteHistory(),
            },
          ]
        : []),
      ...(oid === headOid
        ? []
        : [
            {
              id: "interactive",
              label: "Rebase interactively from here…",
              description: "Reorder, reword, squash or drop the commits after this one",
              icon: <ListOrdered size={16} />,
              disabled: !current || busyOp,
              onSelect: () => integrate.interactive(oid, `commit ${short}`),
            },
          ]),
      {
        id: "cherry-pick",
        label: "Cherry-pick commit",
        icon: <Cherry size={16} />,
        disabled: oid === headOid || busyOp || repo.head.kind === "unborn",
        onSelect: () => integrate.cherryPick(oid),
      },
      {
        id: "revert",
        label: "Revert commit",
        icon: <Undo2 size={16} />,
        disabled: busyOp || repo.head.kind === "unborn",
        onSelect: () => integrate.revert(oid),
      },
      resetEntry(oid),
      { type: "separator", id: "sep-rewrite" },
      ...rewriteEntries(oid),
      { type: "separator", id: "sep-tag" },
      {
        id: "tag",
        label: "Create tag here…",
        icon: <Tag size={16} />,
        onSelect: () => tagActions.create(oid, `commit ${short}`),
      },
      { type: "separator", id: "sep" },
      {
        id: "copy",
        label: "Copy commit id",
        icon: <Copy size={16} />,
        onSelect: () => void navigator.clipboard?.writeText(oid).catch(() => {}),
      },
    ];
  };

  let list;
  if (history.error && !data) {
    list = (
      <EmptyState
        role="alert"
        tone="error"
        icon={<CircleAlert size={22} aria-hidden />}
        title="Could not load history"
        description={history.error.detail ?? history.error.message}
      />
    );
  } else if (!data) {
    list = (
      <div className="bl-history__loading" role="status">
        <Spinner size={18} /> Loading history…
      </div>
    );
  } else if (data.commits.length === 0 && data.filtered) {
    list = (
      <EmptyState
        icon={<SearchX size={22} aria-hidden />}
        title="No matching commits"
        description="Try other words or fewer filters."
      >
        <Button size="sm" onClick={() => setFilter(EMPTY_FILTER)}>
          Clear search and filters
        </Button>
      </EmptyState>
    );
  } else if (data.commits.length === 0) {
    list = (
      <EmptyState
        icon={<GitCommitHorizontal size={22} aria-hidden />}
        title="No commits yet"
        description="Stage your changes and create the first commit to start the history."
      />
    );
  } else {
    list = (
      <CommitList
        data={data}
        head={repo.head}
        selectedOid={selected}
        selectedOids={selection.oids}
        onSelect={select}
        onClearSelection={clearSelection}
        onNearEnd={loadMore}
        loadingMore={history.loadingMore}
        highlight={data.filtered ? applied.text : ""}
        follow={follow}
        onFollow={data.filtered ? undefined : setFollow}
        showFolds={folding}
        onToggleFold={toggleFold}
        revealOid={data.filtered ? null : reveal}
        onRevealed={clearReveal}
        rowProps={(oid) =>
          drop(oid, {
            kind: "commit",
            oid,
            branches: (data?.refsByOid.get(oid) ?? [])
              .filter((r) => r.kind === "branch")
              .map((r) => r.name),
          })
        }
        onContextMenu={(oid, at) =>
          picked.length > 1 && selection.oids.has(oid)
            ? showMenu(at, multiMenu(), `Actions for ${picked.length} commits`)
            : showMenu(at, commitMenu(oid), `Actions for commit ${oid.slice(0, 7)}`)
        }
      />
    );
  }

  const columns = useHistoryColumns(listWidth, parseInt(graphColumnWidth(data), 10));

  return (
    <div className="bl-history">
      <div
        ref={mainRef}
        className={[
          "bl-history__main",
          ...columns.classes,
          columns.graph.clipped ? "bl-history--graph-clipped" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={
          {
            "--graph-width": `${columns.graph.width}px`,
            "--history-columns": columns.template,
          } as React.CSSProperties
        }
      >
        {openFile ? (
          <CommitDiffView
            key={`${openFile.oid}:${openFile.file.path}`}
            repoPath={repo.path}
            oid={openFile.oid}
            file={openFile.file}
            onBack={() => setOpenFile(null)}
            onShowHistory={(path) => {
              setFilter({ ...EMPTY_FILTER, path });
              setFiltersOpen(true);
              setOpenFile(null);
            }}
          />
        ) : (
          <>
            <div className="bl-history__header">
              <h1 className="text-h2">History</h1>
              <span className="text-small text-secondary bl-history__count" aria-live="polite">
                {data
                  ? `${data.total.toLocaleString()} ${data.filtered ? "matching " : ""}${
                      data.total === 1 ? "commit" : "commits"
                    }`
                  : ""}
              </span>
              {history.loading && data && <Spinner size={14} label="Updating history" />}
              <HistorySearch
                ref={searchRef}
                value={filter.text}
                onChange={(text) => setFilter((f) => ({ ...f, text }))}
                filtersOpen={filtersOpen}
                filterCount={activeFilterCount(filter)}
                onToggleFilters={() => setFiltersOpen((o) => !o)}
              />
              <IconButton
                label={collapseMerged ? "Show merged branches" : "Collapse merged branches"}
                // The icon shows the current state: branches shown, or folded with more to show.
                icon={collapseMerged ? <MergedFoldedIcon /> : <MergedShownIcon />}
                aria-pressed={collapseMerged}
                disabled={isFiltering(applied)}
                onClick={() => setCollapseMerged(!collapseMerged)}
              />
              <IconButton
                label={detailsOpen ? "Hide commit details" : "Show commit details"}
                icon={
                  detailsOpen ? (
                    <PanelRightClose size={16} aria-hidden />
                  ) : (
                    <PanelRightOpen size={16} aria-hidden />
                  )
                }
                aria-pressed={detailsOpen}
                onClick={() => setDetailsOpen(!detailsOpen)}
                data-tooltip-align="end"
              />
            </div>
            {filtersOpen && (
              <HistoryFilterBar
                filter={filter}
                onChange={setFilter}
                error={data ? history.error : null}
              />
            )}
            {!filtersOpen && data && history.error && (
              <p className="bl-history__filter-error bl-history__filter-error--bar" role="alert">
                <CircleAlert size={14} aria-hidden />
                {history.error.message}
              </p>
            )}
            {follow !== null && data && (
              <div className="bl-history__follow" role="status">
                <Route size={14} aria-hidden />
                <span className="truncate">
                  Following <strong>{followedName(data, follow, current)}</strong>
                  <span className="text-muted">
                    {" "}
                    · {followCount.toLocaleString()} {followCount === 1 ? "commit" : "commits"}
                    {data.hasMore ? " loaded" : ""}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setFollow(null)}>
                  Stop following
                </Button>
              </div>
            )}
            {repo.totalChanges > 0 && (
              <WorkInProgressRow count={repo.totalChanges} onOpen={onShowChanges} />
            )}
            <div
              className="bl-history__columns text-small"
              onContextMenu={(e) => {
                e.preventDefault();
                showMenu({ x: e.clientX, y: e.clientY }, columns.menu, "Columns");
              }}
            >
              <span className="bl-history__col bl-history__col-graph">
                <span className="truncate" aria-hidden>
                  Graph
                </span>
                {columns.graph.max > GRAPH_MIN && (
                  <span className="bl-history__col-resize bl-history__col-resize--end">
                    <Splitter
                      label="Resize the Graph column"
                      value={columns.graph.width}
                      min={GRAPH_MIN}
                      max={columns.graph.max}
                      side="left"
                      onChange={columns.graph.set}
                      onReset={columns.graph.fit}
                    />
                  </span>
                )}
              </span>
              <span className="bl-history__col-message" aria-hidden>
                Description
              </span>
              {COLUMNS.filter((c) => !columns.hidden[c.id]).map((c) => (
                <span key={c.id} className={`bl-history__col bl-history__col-${c.id}`}>
                  <span className="bl-history__col-resize">
                    <Splitter
                      label={`Resize the ${c.label} column`}
                      value={columns.width[c.id]}
                      min={c.min}
                      max={c.max}
                      side="right"
                      onChange={(v) => columns.setWidth(c.id, v)}
                      onReset={() => columns.setWidth(c.id, c.initial)}
                    />
                  </span>
                  <span className="truncate" aria-hidden>
                    {c.label}
                  </span>
                </span>
              ))}
            </div>
            {list}
          </>
        )}
      </div>
      {selected && data && detailsOpen && (
        <>
          <Splitter
            label="Resize commit details"
            value={detailsWidth}
            min={260}
            max={640}
            side="right"
            onChange={setDetailsWidth}
            onReset={() => setDetailsWidth(400)}
          />
          <aside className="bl-history__details" style={{ width: detailsWidth }}>
            {picked.length > 1 ? (
              <MultiSelectionPanel
                commits={picked}
                target={target}
                problem={pickProblem}
                onCherryPick={pickMany}
                onSelectCommit={(oid) => select(oid)}
                onClear={clearSelection}
              />
            ) : (
              <CommitDetailsPanel
                key={selected}
                repoPath={repo.path}
                oid={selected}
                refs={data.refsByOid.get(selected)}
                head={repo.head}
                selectedFile={openFile?.oid === selected ? openFile.file.path : null}
                onOpenFile={(file, details) => setOpenFile({ oid: details.oid, file })}
                onSelectCommit={(oid) => select(oid)}
              />
            )}
          </aside>
        </>
      )}
    </div>
  );
}
