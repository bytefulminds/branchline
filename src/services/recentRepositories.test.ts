import { describe, expect, it } from "vitest";
import {
  loadRecent,
  MAX_RECENT,
  saveRecent,
  withoutRecent,
  withRecent,
} from "./recentRepositories";

const repo = (n: number) => ({ path: `/repos/r${n}`, name: `r${n}`, lastOpened: n });

describe("recent repositories", () => {
  it("moves a reopened repository to the front without duplicates", () => {
    const list = withRecent(withRecent([repo(1)], repo(2)), { ...repo(1), lastOpened: 99 });
    expect(list.map((r) => r.path)).toEqual(["/repos/r1", "/repos/r2"]);
    expect(list[0]!.lastOpened).toBe(99);
  });

  it("caps the list length", () => {
    let list = [repo(0)];
    for (let i = 1; i < 25; i++) list = withRecent(list, repo(i));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]!.path).toBe("/repos/r24");
  });

  it("removes entries", () => {
    expect(withoutRecent([repo(1), repo(2)], "/repos/r1")).toEqual([repo(2)]);
  });

  it("round-trips through storage and ignores corrupt data", () => {
    saveRecent([repo(1)]);
    expect(loadRecent()).toEqual([repo(1)]);
    window.localStorage.setItem("branchline.recentRepositories.v1", "{not json");
    expect(loadRecent()).toEqual([]);
    window.localStorage.setItem(
      "branchline.recentRepositories.v1",
      JSON.stringify([{ path: 1 }, repo(3)]),
    );
    expect(loadRecent()).toEqual([repo(3)]);
  });
});
