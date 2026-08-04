import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDiff, patchForLines } from "./diff";

let repository = "";

function git(args: string[], input?: string) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", input });
}

function changedLine(raw: string, kind: "add" | "delete") {
  const document = parseDiff(raw);
  const line = document.hunks.flatMap((hunk) => hunk.lines).find((candidate) => candidate.kind === kind);
  if (!line) throw new Error(`Expected a ${kind} line`);
  return { document, line };
}

describe("partial patches against a real Git index", () => {
  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), "tempo-partial-patch-"));
    git(["init", "-q"]);
    git(["config", "user.email", "tempo-tests@example.com"]);
    git(["config", "user.name", "Git Tempo Tests"]);
    writeFileSync(join(repository, "notes.txt"), "alpha\n");
    git(["add", "notes.txt"]);
    git(["commit", "-q", "-m", "initial"]);
  });

  afterEach(() => rmSync(repository, { recursive: true, force: true }));

  it("stages only an added line from a replacement", () => {
    writeFileSync(join(repository, "notes.txt"), "beta\n");
    const raw = git(["diff", "--", "notes.txt"]);
    const { document, line } = changedLine(raw, "add");
    const partial = patchForLines(document, new Set([line.id]));

    git(["apply", "--cached", "--check", "--recount", "-"], partial);
    git(["apply", "--cached", "--recount", "-"], partial);

    expect(git(["show", ":notes.txt"])).toBe("alpha\nbeta\n");
    expect(git(["diff", "--cached", "--", "notes.txt"])).toContain("+beta");
  });

  it("unstages only an added line from a staged replacement", () => {
    writeFileSync(join(repository, "notes.txt"), "beta\n");
    git(["add", "notes.txt"]);
    const raw = git(["diff", "--cached", "--", "notes.txt"]);
    const { document, line } = changedLine(raw, "add");
    const partial = patchForLines(document, new Set([line.id]), true);

    git(["apply", "--cached", "--reverse", "--check", "--recount", "-"], partial);
    git(["apply", "--cached", "--reverse", "--recount", "-"], partial);

    expect(git(["show", ":notes.txt"])).toBe("");
    expect(git(["diff", "--cached", "--", "notes.txt"])).toContain("-alpha");
  });

  it("unstages only a removed line while retaining the staged addition", () => {
    writeFileSync(join(repository, "notes.txt"), "beta\n");
    git(["add", "notes.txt"]);
    const raw = git(["diff", "--cached", "--", "notes.txt"]);
    const { document, line } = changedLine(raw, "delete");
    const partial = patchForLines(document, new Set([line.id]), true);

    git(["apply", "--cached", "--reverse", "--check", "--recount", "-"], partial);
    git(["apply", "--cached", "--reverse", "--recount", "-"], partial);

    expect(git(["show", ":notes.txt"])).toBe("alpha\nbeta\n");
    expect(git(["diff", "--cached", "--", "notes.txt"])).toContain("+beta");
  });

  it("partially unstages a new file in a repository without HEAD", () => {
    const unborn = mkdtempSync(join(tmpdir(), "tempo-unborn-patch-"));
    const previous = repository;
    repository = unborn;
    try {
      git(["init", "-q"]);
      writeFileSync(join(repository, "new.txt"), "alpha\nbeta\n");
      git(["add", "new.txt"]);
      const raw = git(["diff", "--cached", "--", "new.txt"]);
      const document = parseDiff(raw);
      const beta = document.hunks.flatMap((hunk) => hunk.lines).find((line) => line.kind === "add" && line.content === "+beta");
      if (!beta) throw new Error("Expected the staged beta line");
      const partial = patchForLines(document, new Set([beta.id]), true);

      git(["apply", "--cached", "--reverse", "--check", "--recount", "-"], partial);
      git(["apply", "--cached", "--reverse", "--recount", "-"], partial);

      expect(git(["show", ":new.txt"])).toBe("alpha\n");
    } finally {
      rmSync(unborn, { recursive: true, force: true });
      repository = previous;
    }
  });

  it("stages selected lines from a deleted file without staging the entire deletion", () => {
    writeFileSync(join(repository, "notes.txt"), "alpha\nbeta\n");
    git(["add", "notes.txt"]);
    git(["commit", "-q", "-m", "add beta"]);
    unlinkSync(join(repository, "notes.txt"));
    const raw = git(["diff", "--", "notes.txt"]);
    const document = parseDiff(raw);
    const beta = document.hunks.flatMap((hunk) => hunk.lines).find((line) => line.kind === "delete" && line.content === "-beta");
    if (!beta) throw new Error("Expected the deleted beta line");
    const partial = patchForLines(document, new Set([beta.id]));

    git(["apply", "--cached", "--check", "--recount", "-"], partial);
    git(["apply", "--cached", "--recount", "-"], partial);

    expect(git(["show", ":notes.txt"])).toBe("alpha\n");
  });

  it("partially unstages a deleted file", () => {
    writeFileSync(join(repository, "notes.txt"), "alpha\nbeta\n");
    git(["add", "notes.txt"]);
    git(["commit", "-q", "-m", "add beta"]);
    git(["rm", "-q", "notes.txt"]);
    const raw = git(["diff", "--cached", "--", "notes.txt"]);
    const document = parseDiff(raw);
    const beta = document.hunks.flatMap((hunk) => hunk.lines).find((line) => line.kind === "delete" && line.content === "-beta");
    if (!beta) throw new Error("Expected the staged beta deletion");
    const partial = patchForLines(document, new Set([beta.id]), true);

    git(["apply", "--cached", "--reverse", "--check", "--recount", "-"], partial);
    git(["apply", "--cached", "--reverse", "--recount", "-"], partial);

    expect(git(["show", ":notes.txt"])).toBe("beta\n");
  });
});
