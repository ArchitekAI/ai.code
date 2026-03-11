import { ProjectId, WorktreeId } from "@repo/contracts";
import { Encoding } from "effect";

function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function rootWorktreeIdForProject(projectId: ProjectId): WorktreeId {
  return WorktreeId.makeUnsafe(`worktree:${projectId}:root`);
}

export function secondaryWorktreeIdForProjectPath(input: {
  readonly projectId: ProjectId;
  readonly workspacePath: string;
}): WorktreeId {
  const normalizedWorkspacePath = normalizeWorkspacePath(input.workspacePath);
  return WorktreeId.makeUnsafe(
    `worktree:${input.projectId}:${Encoding.encodeBase64Url(normalizedWorkspacePath)}`,
  );
}

export function deriveWorktreeIdFromLegacyThread(input: {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null | undefined;
}): WorktreeId {
  return input.worktreePath
    ? secondaryWorktreeIdForProjectPath({
        projectId: input.projectId,
        workspacePath: input.worktreePath,
      })
    : rootWorktreeIdForProject(input.projectId);
}

export function normalizeWorktreeWorkspacePath(value: string): string {
  return normalizeWorkspacePath(value);
}
