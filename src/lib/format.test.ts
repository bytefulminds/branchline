import { describe, expect, it } from "vitest";
import { headLabel } from "../features/repository/headLabel";
import { displayPath, plural, relativeTime, splitPath } from "./format";

describe("format helpers", () => {
  it("splits paths", () => {
    expect(splitPath("a/b/c.txt")).toEqual({ name: "c.txt", dir: "a/b" });
    expect(splitPath("root.txt")).toEqual({ name: "root.txt", dir: "" });
  });

  it("shortens home directories", () => {
    expect(displayPath("/Users/mark/Development/x")).toBe("~/Development/x");
    expect(displayPath("/home/dev")).toBe("~");
    expect(displayPath("C:\\work\\x")).toBe("C:\\work\\x");
  });

  it("formats relative time", () => {
    const now = Date.UTC(2026, 0, 10, 12);
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 2 * 3600_000, now)).toBe("2 hours ago");
    expect(relativeTime(now - 24 * 3600_000, now)).toBe("yesterday");
    expect(relativeTime("not a date", now)).toBe("");
  });

  it("pluralizes", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
  });

  it("labels HEAD states", () => {
    expect(headLabel({ kind: "branch", name: "main", oid: "a".repeat(40) }).text).toBe("main");
    const detached = headLabel({ kind: "detached", oid: "1234567890abcdef" });
    expect(detached).toMatchObject({ text: "1234567", qualifier: "detached", mono: true });
    expect(headLabel({ kind: "unborn", name: "main" }).qualifier).toBe("no commits yet");
  });
});
