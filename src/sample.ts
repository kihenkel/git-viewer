import type { CommitDetails, CommitSummary, Repository } from "./types";

export const sampleRepositories: Repository[] = [
  {
    path: "/Users/demo/Projects/tempo",
    name: "tempo",
    branch: "main",
    head: "8e42ca1",
    ahead: 2,
    behind: 0,
    changes: [
      { path: "src/components/DiffView.tsx", status: "M", section: "unstaged" },
      { path: "src/styles/theme.css", status: "M", section: "unstaged" },
      { path: "src-tauri/src/git/history.rs", status: "M", section: "staged" },
      { path: "docs/performance.md", status: "?", section: "untracked" },
    ],
  },
  { path: "/Users/demo/Projects/orbit-api", name: "orbit-api", branch: "feature/cache", head: "35d1b19", ahead: 0, behind: 1, changes: [] },
  { path: "/Users/demo/Projects/website", name: "website", branch: "develop", head: "acc18ef", ahead: 0, behind: 0, changes: [{ path: "app/page.tsx", status: "M", section: "unstaged" }] },
];

export const sampleCommits: CommitSummary[] = [
  { oid: "8e42ca1f45e", shortOid: "8e42ca1", parents: ["5b137aa"], subject: "Polish interactive diff selection", author: "Maya Chen", timestamp: Date.now() / 1000 - 1100, refs: ["HEAD", "main"] },
  { oid: "5b137aaf90d", shortOid: "5b137aa", parents: ["47aa902"], subject: "Stream repository status updates", author: "Maya Chen", timestamp: Date.now() / 1000 - 10800, refs: [] },
  { oid: "47aa902de13", shortOid: "47aa902", parents: ["d91b4ca"], subject: "Add keyboard navigation to file list", author: "Jon Bell", timestamp: Date.now() / 1000 - 86400, refs: [] },
  { oid: "d91b4cae412", shortOid: "d91b4ca", parents: ["7c39ea0"], subject: "Avoid redundant history queries on focus", author: "Maya Chen", timestamp: Date.now() / 1000 - 172800, refs: ["v0.1.0"] },
  { oid: "7c39ea0b371", shortOid: "7c39ea0", parents: [], subject: "Create the application shell", author: "Jon Bell", timestamp: Date.now() / 1000 - 345600, refs: [] },
];

const sampleCommitFiles = [
  { path: "src/components/DiffView.tsx", status: "M", section: "commit" as const },
  { path: "src/diff.ts", status: "M", section: "commit" as const },
  { path: "src/styles.css", status: "M", section: "commit" as const },
];

export const sampleCommitDetails: Record<string, CommitDetails> = Object.fromEntries(
  sampleCommits.map((commit) => [commit.oid, {
    ...commit,
    body: "This change improves the working tree experience while keeping repository operations fast and predictable.",
    email: `${commit.author.toLowerCase().replace(/ /g, ".")}@example.com`,
    files: sampleCommitFiles,
  }]),
);

export const sampleDiff = `diff --git a/src/components/DiffView.tsx b/src/components/DiffView.tsx
index 48a53e1..8e42ca1 100644
--- a/src/components/DiffView.tsx
+++ b/src/components/DiffView.tsx
@@ -18,8 +18,12 @@ export function DiffView({ diff }: Props) {
   const hunks = parseDiff(diff);
-  return <pre>{diff}</pre>;
+  const [selected, setSelected] = useState(new Set());

-  // Render the complete patch.
+  // Keep selection close to the rendered lines.
+  const toggleLine = (id: string) => {
+    setSelected(current => toggle(current, id));
+  };
+
   return (
     <section className="diff-view">
       {hunks.map(renderHunk)}
`;
