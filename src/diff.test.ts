import { describe, expect, it } from "vitest";
import { parseDiff, patchForHunks, patchForLines } from "./diff";

const patch = `diff --git a/a.txt b/a.txt
index 7898192..422c2b7 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-alpha
+beta`;

describe("parseDiff", () => {
  it("parses hunk lines and line numbers", () => {
    const parsed = parseDiff(patch);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].lines.map((line) => line.kind)).toEqual(["delete", "add"]);
    expect(parsed.hunks[0].lines[1].newNumber).toBe(1);
  });

  it("builds a patch from selected hunks", () => {
    const parsed = parseDiff(patch);
    expect(patchForHunks(parsed, new Set([parsed.hunks[0].id]))).toContain("+beta");
    expect(patchForHunks(parsed, new Set())).toBe("");
  });

  it("turns an unselected deletion into context for a partial patch", () => {
    const parsed = parseDiff(patch);
    const addition = parsed.hunks[0].lines.find((line) => line.kind === "add")!;
    const partial = patchForLines(parsed, new Set([addition.id]));
    expect(partial).toContain(" alpha");
    expect(partial).toContain("+beta");
    expect(partial).toContain("@@ -1,1 +1,2 @@");
  });

  it("omits an unselected deletion when building a reverse partial patch", () => {
    const parsed = parseDiff(patch);
    const addition = parsed.hunks[0].lines.find((line) => line.kind === "add")!;
    const partial = patchForLines(parsed, new Set([addition.id]), true);
    expect(partial).not.toContain(" alpha");
    expect(partial).toContain("+beta");
    expect(partial).toContain("@@ -1,0 +1,1 @@");
  });

  it("splits separated line selections into independent output hunks", () => {
    const raw = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,11 +1,11 @@
 one
-old two
+new two
 three
 four
 five
 six
 seven
 eight
 nine
-old ten
+new ten
 eleven`;
    const parsed = parseDiff(raw);
    const additions = parsed.hunks[0].lines.filter((line) => line.kind === "add");
    const partial = patchForLines(parsed, new Set(additions.map((line) => line.id)));
    expect(partial.match(/^@@/gm)).toHaveLength(2);
  });

  it("disables unsafe individual-line selection for rename patches", () => {
    const renamed = parseDiff(`diff --git a/old.txt b/new.txt
similarity index 80%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-old
+new`);
    expect(renamed.lineSelectionReason).toContain("rename or copy");
    expect(renamed.hunks[0].lines.filter((line) => line.kind === "add" || line.kind === "delete").every((line) => !line.selectable)).toBe(true);
  });
});
