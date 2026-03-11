import { describe, expect, it } from "vitest";

import {
  buildWorktreeExplorerList,
  buildWorktreeExplorerTree,
  collectWorktreeExplorerDirectoryPaths,
  flattenWorktreeExplorerTree,
  type WorktreeExplorerEntry,
} from "./worktreeExplorer";

describe("worktreeExplorer", () => {
  it("compacts single-directory chains in tree mode", () => {
    const entries: WorktreeExplorerEntry[] = [
      { path: "src/components/Button.tsx", kind: "file" },
      { path: "src/components/Input.tsx", kind: "file" },
      { path: "README.md", kind: "file" },
    ];

    const tree = buildWorktreeExplorerTree(entries);

    expect(tree.map((entry) => entry.path)).toEqual(["src/components", "README.md"]);
    expect(tree[0]).toMatchObject({
      kind: "directory",
      name: "src/components",
      path: "src/components",
    });
  });

  it("aggregates change stats onto directories and flattens expanded rows", () => {
    const entries: WorktreeExplorerEntry[] = [
      {
        path: "apps/web/src/App.tsx",
        kind: "file",
        stat: { insertions: 5, deletions: 1 },
      },
      {
        path: "apps/web/src/routes.tsx",
        kind: "file",
        stat: { insertions: 3, deletions: 2 },
      },
    ];

    const tree = buildWorktreeExplorerTree(entries);
    const directoryPaths = collectWorktreeExplorerDirectoryPaths(tree);
    const rows = flattenWorktreeExplorerTree({
      nodes: tree,
      expandedPaths: new Set(directoryPaths),
    });

    expect(rows[0]).toMatchObject({
      kind: "directory",
      path: "apps/web/src",
      stat: { insertions: 8, deletions: 3 },
    });
    expect(rows.slice(1).map((row) => row.path)).toEqual([
      "apps/web/src/App.tsx",
      "apps/web/src/routes.tsx",
    ]);
  });

  it("builds a flat, sorted file list for list mode", () => {
    const entries: WorktreeExplorerEntry[] = [
      { path: "z-last.ts", kind: "file" },
      { path: "a-first.ts", kind: "file" },
      { path: "src", kind: "directory" },
    ];

    const rows = buildWorktreeExplorerList(entries);

    expect(rows.map((row) => row.path)).toEqual(["a-first.ts", "z-last.ts"]);
    expect(rows.every((row) => row.kind === "file")).toBe(true);
  });
});
