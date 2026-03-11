import type { GitStatusResult } from "@repo/contracts";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";

export interface WorktreeDiffStat {
  additions: number;
  deletions: number;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveWorktreeDiffStat(
  status: Pick<GitStatusResult, "workingTree"> | null | undefined,
): WorktreeDiffStat | null {
  if (!status) {
    return null;
  }

  if (status.workingTree.insertions === 0 && status.workingTree.deletions === 0) {
    return null;
  }

  return {
    additions: status.workingTree.insertions,
    deletions: status.workingTree.deletions,
  };
}
