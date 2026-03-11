import type { ProjectEntry } from "@repo/contracts";

export interface WorktreeExplorerStat {
  insertions: number;
  deletions: number;
}

export interface WorktreeExplorerEntry {
  path: string;
  kind: ProjectEntry["kind"];
  stat?: WorktreeExplorerStat | null;
}

export interface WorktreeExplorerDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  stat: WorktreeExplorerStat | null;
  children: WorktreeExplorerNode[];
}

export interface WorktreeExplorerFileNode {
  kind: "file";
  name: string;
  path: string;
  stat: WorktreeExplorerStat | null;
}

export type WorktreeExplorerNode = WorktreeExplorerDirectoryNode | WorktreeExplorerFileNode;

export interface WorktreeExplorerRow {
  kind: WorktreeExplorerNode["kind"];
  path: string;
  name: string;
  depth: number;
  stat: WorktreeExplorerStat | null;
  expandable: boolean;
  expanded: boolean;
  node: WorktreeExplorerNode;
}

interface MutableDirectoryNode {
  name: string;
  path: string;
  stat: WorktreeExplorerStat | null;
  directories: Map<string, MutableDirectoryNode>;
  files: WorktreeExplorerFileNode[];
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, SORT_LOCALE_OPTIONS);
}

function mergeStats(
  left: WorktreeExplorerStat | null,
  right: WorktreeExplorerStat | null | undefined,
): WorktreeExplorerStat | null {
  if (!right) return left;
  if (!left) {
    return {
      insertions: right.insertions,
      deletions: right.deletions,
    };
  }
  return {
    insertions: left.insertions + right.insertions,
    deletions: left.deletions + right.deletions,
  };
}

function compactDirectoryNode(node: WorktreeExplorerDirectoryNode): WorktreeExplorerDirectoryNode {
  const compactedChildren = node.children.map((child) =>
    child.kind === "directory" ? compactDirectoryNode(child) : child,
  );

  let compactedNode: WorktreeExplorerDirectoryNode = {
    ...node,
    children: compactedChildren,
  };

  while (compactedNode.children.length === 1 && compactedNode.children[0]?.kind === "directory") {
    const onlyChild = compactedNode.children[0];
    compactedNode = {
      kind: "directory",
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      stat: onlyChild.stat,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toTreeNodes(directory: MutableDirectoryNode): WorktreeExplorerNode[] {
  const subdirectories: WorktreeExplorerDirectoryNode[] = Array.from(directory.directories.values())
    .toSorted(compareByName)
    .map((subdirectory) => ({
      kind: "directory" as const,
      name: subdirectory.name,
      path: subdirectory.path,
      stat: subdirectory.stat,
      children: toTreeNodes(subdirectory),
    }))
    .map((subdirectory) => compactDirectoryNode(subdirectory));

  const files = directory.files.toSorted(compareByName);
  return [...subdirectories, ...files];
}

export function buildWorktreeExplorerTree(
  entries: ReadonlyArray<WorktreeExplorerEntry>,
): WorktreeExplorerNode[] {
  const root: MutableDirectoryNode = {
    name: "",
    path: "",
    stat: null,
    directories: new Map(),
    files: [],
  };

  for (const entry of entries) {
    const segments = normalizePathSegments(entry.path);
    if (segments.length === 0) {
      continue;
    }

    const ancestors: MutableDirectoryNode[] = [root];
    let currentDirectory = root;

    for (const segment of segments.slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      const existing = currentDirectory.directories.get(segment);
      if (existing) {
        currentDirectory = existing;
      } else {
        const created: MutableDirectoryNode = {
          name: segment,
          path: nextPath,
          stat: null,
          directories: new Map(),
          files: [],
        };
        currentDirectory.directories.set(segment, created);
        currentDirectory = created;
      }
      ancestors.push(currentDirectory);
    }

    const leafName = segments.at(-1);
    if (!leafName) {
      continue;
    }

    if (entry.kind === "directory") {
      const nextPath = segments.join("/");
      const existing = currentDirectory.directories.get(leafName);
      if (!existing) {
        currentDirectory.directories.set(leafName, {
          name: leafName,
          path: nextPath,
          stat: entry.stat ?? null,
          directories: new Map(),
          files: [],
        });
      } else {
        existing.stat = mergeStats(existing.stat, entry.stat);
      }
      for (const ancestor of ancestors) {
        ancestor.stat = mergeStats(ancestor.stat, entry.stat);
      }
      continue;
    }

    currentDirectory.files.push({
      kind: "file",
      name: leafName,
      path: segments.join("/"),
      stat: entry.stat ?? null,
    });

    for (const ancestor of ancestors) {
      ancestor.stat = mergeStats(ancestor.stat, entry.stat);
    }
  }

  return toTreeNodes(root);
}

export function collectWorktreeExplorerDirectoryPaths(
  nodes: ReadonlyArray<WorktreeExplorerNode>,
): string[] {
  const paths: string[] = [];

  const visit = (items: ReadonlyArray<WorktreeExplorerNode>) => {
    for (const item of items) {
      if (item.kind !== "directory") continue;
      paths.push(item.path);
      visit(item.children);
    }
  };

  visit(nodes);
  return paths;
}

export function flattenWorktreeExplorerTree(options: {
  nodes: ReadonlyArray<WorktreeExplorerNode>;
  expandedPaths: ReadonlySet<string>;
}): WorktreeExplorerRow[] {
  const rows: WorktreeExplorerRow[] = [];

  const visit = (items: ReadonlyArray<WorktreeExplorerNode>, depth: number) => {
    for (const item of items) {
      if (item.kind === "directory") {
        const expanded = options.expandedPaths.has(item.path);
        rows.push({
          kind: "directory",
          path: item.path,
          name: item.name,
          depth,
          stat: item.stat,
          expandable: item.children.length > 0,
          expanded,
          node: item,
        });
        if (expanded) {
          visit(item.children, depth + 1);
        }
        continue;
      }

      rows.push({
        kind: "file",
        path: item.path,
        name: item.name,
        depth,
        stat: item.stat,
        expandable: false,
        expanded: false,
        node: item,
      });
    }
  };

  visit(options.nodes, 0);
  return rows;
}

export function buildWorktreeExplorerList(
  entries: ReadonlyArray<WorktreeExplorerEntry>,
): WorktreeExplorerRow[] {
  return entries
    .filter((entry) => entry.kind === "file")
    .toSorted((left, right) => left.path.localeCompare(right.path, undefined, SORT_LOCALE_OPTIONS))
    .map((entry) => ({
      kind: "file" as const,
      path: entry.path,
      name: entry.path,
      depth: 0,
      stat: entry.stat ?? null,
      expandable: false,
      expanded: false,
      node: {
        kind: "file",
        name: entry.path.split("/").at(-1) ?? entry.path,
        path: entry.path,
        stat: entry.stat ?? null,
      },
    }));
}
