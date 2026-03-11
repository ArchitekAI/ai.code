import { Encoding } from "effect";
import { CheckpointRef, ProjectId, WorktreeId, type ThreadId } from "@repo/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly worktreeId?: WorktreeId | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly worktreePath?: string | null | undefined;
  };
  readonly worktrees?: ReadonlyArray<{
    readonly id: WorktreeId;
    readonly workspacePath: string;
  }>;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd =
    (input.thread.worktreeId
      ? input.worktrees?.find((worktree) => worktree.id === input.thread.worktreeId)?.workspacePath
      : undefined) ??
    input.thread.worktreePath ??
    undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.thread.projectId
    ? input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot
    : undefined;
}
