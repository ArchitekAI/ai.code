import { type ProjectId, type ThreadId } from "@t3tools/contracts";

export interface DeleteProjectCascadeInput {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly projectThreadIds: ReadonlyArray<ThreadId>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly deleteThread: (
    threadId: ThreadId,
    options?: { deletedThreadIds?: ReadonlySet<ThreadId> },
  ) => Promise<void>;
  readonly prepareProjectDeletion?: () => void | Promise<void>;
  readonly deleteProject: (projectId: ProjectId) => Promise<void>;
}

export function buildDeleteProjectConfirmationMessage(input: {
  readonly projectName: string;
  readonly threadCount: number;
}): string {
  if (input.threadCount === 0) {
    return `Remove project "${input.projectName}"?`;
  }

  return [
    `Remove project "${input.projectName}" and delete ${input.threadCount} thread${input.threadCount === 1 ? "" : "s"}?`,
    `This permanently clears conversation history for ${input.threadCount === 1 ? "this thread" : "these threads"}.`,
  ].join("\n");
}

export async function deleteProjectCascade(input: DeleteProjectCascadeInput): Promise<boolean> {
  const confirmed = await input.confirm(
    buildDeleteProjectConfirmationMessage({
      projectName: input.projectName,
      threadCount: input.projectThreadIds.length,
    }),
  );
  if (!confirmed) {
    return false;
  }

  const deletedThreadIds = new Set(input.projectThreadIds);
  // Delete threads first so the project never disappears while its children still exist.
  for (const threadId of input.projectThreadIds) {
    await input.deleteThread(threadId, { deletedThreadIds });
  }

  await input.prepareProjectDeletion?.();
  await input.deleteProject(input.projectId);
  return true;
}
