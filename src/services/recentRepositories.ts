import { readJson, writeJson } from "./storage";

export interface RecentRepository {
  path: string;
  name: string;
  lastOpened: number;
}

const KEY = "branchline.recentRepositories.v1";
export const MAX_RECENT = 10;

function isRecent(value: unknown): value is RecentRepository {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" && typeof v.name === "string" && typeof v.lastOpened === "number"
  );
}

export function loadRecent(): RecentRepository[] {
  const raw = readJson<unknown>(KEY, []);
  return Array.isArray(raw) ? raw.filter(isRecent).slice(0, MAX_RECENT) : [];
}

/** Pure: return the list with `entry` moved to the front, deduplicated by path. */
export function withRecent(list: RecentRepository[], entry: RecentRepository): RecentRepository[] {
  return [entry, ...list.filter((r) => r.path !== entry.path)].slice(0, MAX_RECENT);
}

export function withoutRecent(list: RecentRepository[], path: string): RecentRepository[] {
  return list.filter((r) => r.path !== path);
}

export function saveRecent(list: RecentRepository[]): void {
  writeJson(KEY, list);
}
