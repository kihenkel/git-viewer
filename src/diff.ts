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
      current = {
        id: `hunk-${index}`,
        header: content,
        oldStart: oldLine,
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: newLine,
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
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

  const binary = raw.includes("Binary files") || raw.includes("GIT binary patch");
  const renamed = header.some((line) => line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to "));
  if (renamed) {
    for (const hunk of hunks) for (const line of hunk.lines) line.selectable = false;
  }
  return {
    raw,
    header,
    hunks,
    binary,
    lineSelectionReason: renamed ? "Individual line selection is unavailable for rename or copy patches; select the hunk or whole file instead." : undefined,
  };
}

export function patchForHunks(document: DiffDocument, selectedHunks: Set<string>): string {
  const hunks = document.hunks.filter((hunk) => selectedHunks.has(hunk.id));
  if (!hunks.length) return "";
  return finishPatch(document, [...document.header, ...hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => line.content)])]);
}

export function patchForLines(document: DiffDocument, selectedLines: Set<string>, reverse = false): string {
  const output: string[] = normalizePartialFileHeader(document, selectedLines, reverse);
  for (const hunk of document.hunks) {
    if (!hunk.lines.some((line) => selectedLines.has(line.id))) continue;
    const candidates: Array<{ contents: string[]; oldCount: number; newCount: number; selected: boolean }> = [];
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        const selected = selectedLines.has(line.id);
        if (selected) candidates.push({ contents: [line.content], oldCount: 0, newCount: 1, selected: true });
        else if (reverse) candidates.push({ contents: [` ${line.content.slice(1)}`], oldCount: 1, newCount: 1, selected: false });
      } else if (line.kind === "delete") {
        const selected = selectedLines.has(line.id);
        if (selected) candidates.push({ contents: [line.content], oldCount: 1, newCount: 0, selected: true });
        else if (!reverse) candidates.push({ contents: [` ${line.content.slice(1)}`], oldCount: 1, newCount: 1, selected: false });
      } else if (line.kind === "meta" && line.content.startsWith("\\")) {
        candidates[candidates.length - 1]?.contents.push(line.content);
      } else if (line.kind === "context") {
        candidates.push({ contents: [line.content], oldCount: 1, newCount: 1, selected: false });
      }
    }
    const selectedIndexes = candidates.flatMap((candidate, index) => candidate.selected ? [index] : []);
    if (selectedIndexes.length === 0) continue;
    const spans = selectedIndexes
      .map((index) => ({ start: Math.max(0, index - 3), end: Math.min(candidates.length, index + 4) }))
      .reduce<Array<{ start: number; end: number }>>((merged, span) => {
        const previous = merged[merged.length - 1];
        if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
        else merged.push(span);
        return merged;
      }, []);
    const suffix = hunk.header.replace(/^@@[^@]+@@/, "").trim();
    for (const span of spans) {
      const before = candidates.slice(0, span.start);
      const lines = candidates.slice(span.start, span.end);
      const oldStart = hunk.oldStart + before.reduce((count, line) => count + line.oldCount, 0);
      const newStart = hunk.newStart + before.reduce((count, line) => count + line.newCount, 0);
      const oldCount = lines.reduce((count, line) => count + line.oldCount, 0);
      const newCount = lines.reduce((count, line) => count + line.newCount, 0);
      output.push(
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix ? ` ${suffix}` : ""}`,
        ...lines.flatMap((line) => line.contents),
      );
    }
  }
  return output.length === document.header.length ? "" : finishPatch(document, output);
}

function finishPatch(document: DiffDocument, lines: string[]): string {
  const patch = lines.join("\n");
  return document.raw.endsWith("\n") && !patch.endsWith("\n") ? `${patch}\n` : patch;
}

function normalizePartialFileHeader(document: DiffDocument, selectedLines: Set<string>, reverse: boolean): string[] {
  const header = document.header;
  const newFile = header.some((line) => line.startsWith("new file mode "));
  const deletedFile = header.some((line) => line.startsWith("deleted file mode "));
  if (!newFile && !deletedFile) return [...header];
  const changedLines = document.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add" || line.kind === "delete");
  const allSelected = changedLines.length > 0 && changedLines.every((line) => selectedLines.has(line.id));
  if (allSelected) return [...header];
  const resultRemainsAFile = (newFile && reverse) || (deletedFile && !reverse);
  if (!resultRemainsAFile) return header.filter((line) => !line.startsWith("index "));
  const normalized = header.filter((line) => !line.startsWith("new file mode ") && !line.startsWith("deleted file mode ") && !line.startsWith("index "));
  if (newFile) {
    const newPath = normalized.find((line) => line.startsWith("+++ "));
    const oldPath = newPath?.replace(/^\+\+\+ ("?)b\//, "--- $1a/");
    return normalized.map((line) => line === "--- /dev/null" && oldPath ? oldPath : line);
  }
  const oldPath = normalized.find((line) => line.startsWith("--- "));
  const newPath = oldPath?.replace(/^--- ("?)a\//, "+++ $1b/");
  return normalized.map((line) => line === "+++ /dev/null" && newPath ? newPath : line);
}
