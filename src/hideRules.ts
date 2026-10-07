import type { ChangedFile } from "./types";

export interface HideRules {
  patterns: string[];
  enabled: boolean;
}

export interface RuleError {
  line: number;
  message: string;
}

const storageKey = (repositoryPath: string) => `hide-rules:${repositoryPath}`;

function escapeRegex(char: string) {
  return /[.+^$()|[\]{}\\*?]/.test(char) ? `\\${char}` : char;
}

// Converts a gitignore-style glob into an anchored RegExp over repo-relative paths.
export function compileGlob(input: string): RegExp {
  let pattern = input.trim();
  if (!pattern) throw new Error("Pattern is empty");
  if (pattern.startsWith("!")) throw new Error("Negated patterns (!) are not supported");
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (!pattern) throw new Error("Pattern is empty");

  let source = "";
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      if (index + 1 >= pattern.length) throw new Error("Trailing backslash");
      source += escapeRegex(pattern[++index]);
    } else if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      let end = index + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end >= pattern.length) throw new Error("Unbalanced [");
      let body = pattern.slice(index + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      if (!body) throw new Error("Empty character class []");
      source += `[${negated ? "^/" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      index = end;
    } else if (char === "{") {
      braceDepth++;
      source += "(?:";
    } else if (char === "}") {
      if (braceDepth === 0) throw new Error("Unbalanced }");
      braceDepth--;
      source += ")";
    } else if (char === "," && braceDepth > 0) {
      source += "|";
    } else {
      source += escapeRegex(char);
    }
  }
  if (braceDepth > 0) throw new Error("Unbalanced {");

  try {
    return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}$`);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export function parsePatterns(text: string) {
  return text.split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, pattern: line.trim() }))
    .filter(({ pattern }) => pattern && !pattern.startsWith("#"));
}

export function compileRules(text: string) {
  const patterns: string[] = [];
  const matchers: RegExp[] = [];
  const errors: RuleError[] = [];
  for (const { line, pattern } of parsePatterns(text)) {
    try {
      matchers.push(compileGlob(pattern));
      patterns.push(pattern);
    } catch (error) {
      errors.push({ line, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { patterns, matchers, errors };
}

export function compilePatterns(patterns: string[]) {
  return patterns.flatMap((pattern) => {
    try { return [compileGlob(pattern)]; } catch { return []; }
  });
}

export function isHidden(file: ChangedFile, matchers: RegExp[]) {
  return matchers.some((matcher) => matcher.test(file.path) || (!!file.oldPath && matcher.test(file.oldPath)));
}

export function loadHideRules(repositoryPath: string): HideRules {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(repositoryPath)) || "null") as Partial<HideRules> | null;
    const patterns = Array.isArray(stored?.patterns) ? stored.patterns.filter((item): item is string => typeof item === "string") : [];
    return { patterns, enabled: patterns.length > 0 && stored?.enabled !== false };
  } catch {
    localStorage.removeItem(storageKey(repositoryPath));
    return { patterns: [], enabled: false };
  }
}

export function saveHideRules(repositoryPath: string, rules: HideRules) {
  if (rules.patterns.length === 0) localStorage.removeItem(storageKey(repositoryPath));
  else localStorage.setItem(storageKey(repositoryPath), JSON.stringify(rules));
}

export function clearHideRules(repositoryPath: string) {
  localStorage.removeItem(storageKey(repositoryPath));
}
