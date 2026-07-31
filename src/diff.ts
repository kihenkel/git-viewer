import type { DiffDocument, DiffHunk, DiffLine } from "./types";

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(raw: string): DiffDocument {
  const header: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  raw.split("\n").forEach((content, index) => {
    const match = content.match(HUNK);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      current = { id: `hunk-${index}`, header: content, lines: [] };
      hunks.push(current);
      return;
    }
    if (!current) {
      header.push(content);
      return;
    }
    let line: DiffLine;
    if (content.startsWith("+") && !content.startsWith("+++")) {
      line = { id: `line-${index}`, kind: "add", content, newNumber: newLine++, selectable: true };
    } else if (content.startsWith("-") && !content.startsWith("---")) {
      line = { id: `line-${index}`, kind: "delete", content, oldNumber: oldLine++, selectable: true };
    } else if (content.startsWith(" ")) {
      line = { id: `line-${index}`, kind: "context", content, oldNumber: oldLine++, newNumber: newLine++, selectable: false };
    } else {
      line = { id: `line-${index}`, kind: "meta", content, selectable: false };
    }
    current.lines.push(line);
  });

  return { raw, header, hunks, binary: raw.includes("Binary files") || raw.includes("GIT binary patch") };
}

export function patchForHunks(document: DiffDocument, selectedHunks: Set<string>): string {
  const hunks = document.hunks.filter((hunk) => selectedHunks.has(hunk.id));
  if (!hunks.length) return "";
  return [...document.header, ...hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => line.content)])].join("\n");
}

export function patchForLines(document: DiffDocument, selectedLines: Set<string>): string {
  const output: string[] = [...document.header];
  for (const hunk of document.hunks) {
    if (!hunk.lines.some((line) => selectedLines.has(line.id))) continue;
    const lines = hunk.lines.flatMap((line) => {
      if (line.kind === "add") return selectedLines.has(line.id) ? [line.content] : [];
      if (line.kind === "delete") return [selectedLines.has(line.id) ? line.content : ` ${line.content.slice(1)}`];
      return [line.content];
    });
    const oldStart = hunk.lines.find((line) => line.oldNumber !== undefined)?.oldNumber ?? 0;
    const newStart = hunk.lines.find((line) => line.newNumber !== undefined)?.newNumber ?? 0;
    const oldCount = lines.filter((line) => !line.startsWith("+") && !line.startsWith("\\")).length;
    const newCount = lines.filter((line) => !line.startsWith("-") && !line.startsWith("\\")).length;
    const suffix = hunk.header.replace(/^@@[^@]+@@/, "").trim();
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix ? ` ${suffix}` : ""}`, ...lines);
  }
  return output.length === document.header.length ? "" : output.join("\n");
}
