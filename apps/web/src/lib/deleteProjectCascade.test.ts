import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildDeleteProjectConfirmationMessage,
  deleteProjectCascade,
} from "./deleteProjectCascade";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID_1 = ThreadId.makeUnsafe("thread-1");
const THREAD_ID_2 = ThreadId.makeUnsafe("thread-2");

describe("buildDeleteProjectConfirmationMessage", () => {
  it("uses the existing single-project wording when no threads need deletion", () => {
    expect(
      buildDeleteProjectConfirmationMessage({
        projectName: "Repo",
        threadCount: 0,
      }),
    ).toBe('Remove project "Repo"?');
  });

  it("includes the thread count when deleting a non-empty project", () => {
    expect(
      buildDeleteProjectConfirmationMessage({
        projectName: "Repo",
        threadCount: 2,
      }),
    ).toBe(
      'Remove project "Repo" and delete 2 threads?\nThis permanently clears conversation history for these threads.',
    );
  });
});

describe("deleteProjectCascade", () => {
  it("does nothing when the user declines confirmation", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const deleteThread = vi.fn();
    const prepareProjectDeletion = vi.fn();
    const deleteProject = vi.fn();

    await expect(
      deleteProjectCascade({
        projectId: PROJECT_ID,
        projectName: "Repo",
        projectThreadIds: [THREAD_ID_1],
        confirm,
        deleteThread,
        prepareProjectDeletion,
        deleteProject,
      }),
    ).resolves.toBe(false);

    expect(deleteThread).not.toHaveBeenCalled();
    expect(prepareProjectDeletion).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("deletes project threads before removing the project", async () => {
    const calls: string[] = [];
    const confirm = vi.fn().mockResolvedValue(true);
    const deleteThread = vi.fn(async (threadId: ThreadId) => {
      calls.push(`thread:${threadId}`);
    });
    const prepareProjectDeletion = vi.fn(async () => {
      calls.push("prepare");
    });
    const deleteProject = vi.fn(async (projectId: ProjectId) => {
      calls.push(`project:${projectId}`);
    });

    await expect(
      deleteProjectCascade({
        projectId: PROJECT_ID,
        projectName: "Repo",
        projectThreadIds: [THREAD_ID_1, THREAD_ID_2],
        confirm,
        deleteThread,
        prepareProjectDeletion,
        deleteProject,
      }),
    ).resolves.toBe(true);

    expect(deleteThread).toHaveBeenNthCalledWith(1, THREAD_ID_1, {
      deletedThreadIds: new Set([THREAD_ID_1, THREAD_ID_2]),
    });
    expect(deleteThread).toHaveBeenNthCalledWith(2, THREAD_ID_2, {
      deletedThreadIds: new Set([THREAD_ID_1, THREAD_ID_2]),
    });
    expect(calls).toEqual(["thread:thread-1", "thread:thread-2", "prepare", "project:project-1"]);
  });
});
