import type { GitBranch, NativeApi, ProjectId, WorktreeId } from "@repo/contracts";
import type { Project, Worktree } from "~/types";
import { buildPrefixedBranchName } from "@repo/shared/git";
import { rootWorktreeIdForProject } from "@repo/shared/worktrees";
import { newCommandId, newWorktreeId } from "./utils";

const NATURE_ADJECTIVES = [
  "amber",
  "ancient",
  "autumn",
  "blue",
  "bright",
  "calm",
  "cedar",
  "clear",
  "cool",
  "crisp",
  "deep",
  "drift",
  "dune",
  "early",
  "fern",
  "golden",
  "granite",
  "green",
  "hollow",
  "juniper",
  "lunar",
  "mossy",
  "north",
  "quiet",
  "rapid",
  "redwood",
  "river",
  "sage",
  "silent",
  "silver",
  "solstice",
  "spring",
  "stone",
  "summer",
  "sunlit",
  "wild",
  "winter",
] as const;

const NATURE_MIDDLES = [
  "alder",
  "ash",
  "bay",
  "briar",
  "brook",
  "canyon",
  "clover",
  "coral",
  "creek",
  "dawn",
  "delta",
  "field",
  "fjord",
  "forest",
  "glade",
  "glen",
  "harbor",
  "heather",
  "lagoon",
  "laurel",
  "lotus",
  "maple",
  "marsh",
  "meadow",
  "ocean",
  "orchid",
  "pine",
  "prairie",
  "reef",
  "sierra",
  "spruce",
  "thicket",
  "timber",
  "tundra",
  "valley",
  "willow",
] as const;

const NATURE_ENDINGS = [
  "bank",
  "bluff",
  "branch",
  "cove",
  "crest",
  "dell",
  "fen",
  "grove",
  "harbor",
  "heights",
  "horizon",
  "knoll",
  "landing",
  "meadow",
  "mist",
  "pass",
  "path",
  "peak",
  "point",
  "ridge",
  "run",
  "shore",
  "spring",
  "trail",
  "vista",
  "water",
  "wilds",
  "wood",
  "woods",
] as const;

function pickWord(words: readonly string[]): string {
  return words[Math.floor(Math.random() * words.length)] ?? "field";
}

export function worktreePathName(worktreePath: string): string {
  const normalized = worktreePath.replace(/\\/g, "/").replace(/\/+$/g, "");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function generateNatureWorktreeSlug(existingPathNames: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const slug = `${pickWord(NATURE_ADJECTIVES)}-${pickWord(NATURE_MIDDLES)}-${pickWord(NATURE_ENDINGS)}`;
    if (!existingPathNames.has(slug)) {
      return slug;
    }
  }

  const total = NATURE_ADJECTIVES.length * NATURE_MIDDLES.length * NATURE_ENDINGS.length;
  const seed = existingPathNames.size % total;
  for (let offset = 0; offset < total; offset += 1) {
    const value = (seed + offset) % total;
    const adjectiveIndex =
      Math.floor(value / (NATURE_MIDDLES.length * NATURE_ENDINGS.length)) %
      NATURE_ADJECTIVES.length;
    const middleIndex = Math.floor(value / NATURE_ENDINGS.length) % NATURE_MIDDLES.length;
    const endingIndex = value % NATURE_ENDINGS.length;
    const slug = `${NATURE_ADJECTIVES[adjectiveIndex]}-${NATURE_MIDDLES[middleIndex]}-${NATURE_ENDINGS[endingIndex]}`;
    if (!existingPathNames.has(slug)) {
      return slug;
    }
  }

  return "silent-fern-ridge";
}

export function buildManagedWorktreeBranchName(prefix: string, slug: string): string {
  return buildPrefixedBranchName(prefix, slug);
}

export function createManagedWorktreeSeed(input: {
  readonly existingWorktrees: readonly { workspacePath: string }[];
  readonly branchPrefix: string;
}): { slug: string; branch: string } {
  const existingPathNames = new Set(
    input.existingWorktrees.map((worktree) => worktreePathName(worktree.workspacePath)),
  );
  const slug = generateNatureWorktreeSlug(existingPathNames);
  return {
    slug,
    branch: buildManagedWorktreeBranchName(input.branchPrefix, slug),
  };
}

export function resolveProjectWorktreeBaseBranch(input: {
  readonly configuredBaseBranch: string | null;
  readonly fallbackBranch: string | null;
}): string | null {
  return input.configuredBaseBranch ?? input.fallbackBranch;
}

export function hasGitBranch(
  branches: readonly Pick<GitBranch, "name">[],
  branchName: string | null,
): boolean {
  if (!branchName) {
    return false;
  }

  return branches.some((branch) => branch.name === branchName);
}

export function findRootWorktree(
  projectId: ProjectId,
  worktrees: readonly Worktree[],
): Worktree | undefined {
  return worktrees.find((worktree) => worktree.projectId === projectId && worktree.isRoot);
}

export function findProjectWorktreeByPath(input: {
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly worktrees: readonly Worktree[];
}): Worktree | undefined {
  return input.worktrees.find(
    (worktree) =>
      worktree.projectId === input.projectId && worktree.workspacePath === input.workspacePath,
  );
}

export async function materializeWorktreeRecord(input: {
  readonly api: NativeApi;
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly branch: string | null;
  readonly isRoot: boolean;
  readonly branchRenamePending: boolean;
  readonly worktrees: readonly Worktree[];
  readonly createdAt?: string;
}): Promise<{
  worktreeId: WorktreeId;
  reusedExistingWorktree: boolean;
  restoredArchivedWorktree: boolean;
}> {
  const existingWorktree = findProjectWorktreeByPath({
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    worktrees: input.worktrees,
  });

  if (existingWorktree) {
    if (existingWorktree.archivedAt !== null) {
      await input.api.orchestration.dispatchCommand({
        type: "worktree.unarchive",
        commandId: newCommandId(),
        worktreeId: existingWorktree.id,
      });
    }
    await input.api.orchestration.dispatchCommand({
      type: "worktree.meta.update",
      commandId: newCommandId(),
      worktreeId: existingWorktree.id,
      workspacePath: input.workspacePath,
      branch: input.branch,
      branchRenamePending: input.branchRenamePending,
    });
    return {
      worktreeId: existingWorktree.id,
      reusedExistingWorktree: true,
      restoredArchivedWorktree: existingWorktree.archivedAt !== null,
    };
  }

  const worktreeId = newWorktreeId();
  await input.api.orchestration.dispatchCommand({
    type: "worktree.create",
    commandId: newCommandId(),
    worktreeId,
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    branch: input.branch,
    isRoot: input.isRoot,
    branchRenamePending: input.branchRenamePending,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  return {
    worktreeId,
    reusedExistingWorktree: false,
    restoredArchivedWorktree: false,
  };
}

export function getRootWorktreeId(projectId: ProjectId): WorktreeId {
  return rootWorktreeIdForProject(projectId);
}

export function worktreeDisplayTitle(worktree: Worktree, branchOverride?: string | null): string {
  const branchName = branchOverride ?? worktree.branch;
  if (worktree.isRoot) {
    return branchName ?? "main";
  }
  return branchName ?? worktreePathName(worktree.workspacePath);
}

export function worktreeDisplaySubtitle(worktree: Worktree, project: Project): string | null {
  if (worktree.isRoot) {
    return null;
  }
  const pathName = worktreePathName(worktree.workspacePath);
  if (pathName === project.name || pathName.length === 0) {
    return null;
  }
  return pathName;
}
