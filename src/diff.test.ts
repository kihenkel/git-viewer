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
});
