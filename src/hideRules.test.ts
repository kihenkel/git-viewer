// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { compileGlob, compileRules, isHidden, loadHideRules, saveHideRules } from "./hideRules";

const matches = (pattern: string, path: string) => compileGlob(pattern).test(path);

describe("compileGlob", () => {
  it("matches basename patterns at any depth", () => {
    expect(matches("*.test.ts*", "App.test.tsx")).toBe(true);
    expect(matches("*.test.ts*", "src/deep/diff.test.ts")).toBe(true);
    expect(matches("*.test.ts*", "src/diff.ts")).toBe(false);
    expect(matches("*.snap", "src/__snapshots__/a.snap")).toBe(true);
  });

  it("anchors patterns that contain a slash to the repository root", () => {
    expect(matches("tests/**", "tests/unit/a.ts")).toBe(true);
    expect(matches("tests/**", "src/tests/a.ts")).toBe(false);
    expect(matches("/docs/*.md", "docs/a.md")).toBe(true);
    expect(matches("src/*", "src/a/b.ts")).toBe(false);
  });

  it("treats a trailing slash as a directory prefix", () => {
    expect(matches("tests/", "tests/a.ts")).toBe(true);
    expect(matches("tests/", "tests")).toBe(false);
  });

  it("supports **, ?, character classes and braces", () => {
    expect(matches("**/__snapshots__/**", "src/a/__snapshots__/x.snap")).toBe(true);
    expect(matches("**/__snapshots__/**", "__snapshots__/x.snap")).toBe(true);
    expect(matches("src/**/*.rs", "src/git.rs")).toBe(true);
    expect(matches("file?.ts", "file1.ts")).toBe(true);
    expect(matches("file[0-9].ts", "file7.ts")).toBe(true);
    expect(matches("file[!0-9].ts", "file7.ts")).toBe(false);
    expect(matches("*.{md,txt}", "notes/readme.txt")).toBe(true);
    expect(matches("*.{md,txt}", "notes/readme.rs")).toBe(false);
  });

  it("escapes regex characters and is case-sensitive", () => {
    expect(matches("a+b.(x)", "a+b.(x)")).toBe(true);
    expect(matches("a.ts", "abts")).toBe(false);
    expect(matches("*.MD", "a.md")).toBe(false);
  });

  it("rejects invalid patterns", () => {
    expect(() => compileGlob("file[abc")).toThrow("Unbalanced [");
    expect(() => compileGlob("*.{md,txt")).toThrow("Unbalanced {");
    expect(() => compileGlob("a}")).toThrow("Unbalanced }");
    expect(() => compileGlob("!keep.ts")).toThrow("not supported");
  });
});

describe("compileRules", () => {
  it("skips blank and comment lines and reports errors with line numbers", () => {
    const result = compileRules("# tests\n*.test.ts*\n\nfile[abc\n  tests/**  \n");
    expect(result.patterns).toEqual(["*.test.ts*", "tests/**"]);
    expect(result.errors).toEqual([{ line: 4, message: "Unbalanced [" }]);
  });
});

describe("isHidden", () => {
  it("also matches the previous path of a rename", () => {
    const { matchers } = compileRules("tests/**");
    expect(isHidden({ path: "spec/a.ts", oldPath: "tests/a.ts", status: "R", section: "staged" }, matchers)).toBe(true);
    expect(isHidden({ path: "spec/a.ts", status: "M", section: "unstaged" }, matchers)).toBe(false);
  });
});

describe("storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips per repository and tolerates corrupt data", () => {
    saveHideRules("/repo/a", { patterns: ["*.md"], enabled: false });
    expect(loadHideRules("/repo/a")).toEqual({ patterns: ["*.md"], enabled: false });
    expect(loadHideRules("/repo/b")).toEqual({ patterns: [], enabled: false });
    localStorage.setItem("hide-rules:/repo/c", "{nope");
    expect(loadHideRules("/repo/c")).toEqual({ patterns: [], enabled: false });
  });
});
