import type { ThreadId, WorktreeId } from "@repo/contracts";

interface TerminalRetentionThread {
  id: ThreadId;
  deletedAt: string | null;
}

interface CollectActiveTerminalThreadIdsInput {
  snapshotThreads: readonly TerminalRetentionThread[];
  draftThreadIds: Iterable<ThreadId>;
}

interface TerminalRetentionWorktree {
  id: WorktreeId;
  deletedAt: string | null;
}

interface CollectActiveTerminalWorktreeIdsInput {
  snapshotWorktrees: readonly TerminalRetentionWorktree[];
}

export function collectActiveTerminalThreadIds(
  input: CollectActiveTerminalThreadIdsInput,
): Set<ThreadId> {
  const activeThreadIds = new Set<ThreadId>();
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    activeThreadIds.add(thread.id);
  }
  for (const draftThreadId of input.draftThreadIds) {
    activeThreadIds.add(draftThreadId);
  }
  return activeThreadIds;
}

export function collectActiveTerminalWorktreeIds(
  input: CollectActiveTerminalWorktreeIdsInput,
): Set<WorktreeId> {
  const activeWorktreeIds = new Set<WorktreeId>();
  for (const worktree of input.snapshotWorktrees) {
    if (worktree.deletedAt !== null) {
      continue;
    }
    activeWorktreeIds.add(worktree.id);
  }
  return activeWorktreeIds;
}
