import { ThreadId, WorktreeId } from "@repo/contracts";
import { describe, expect, it } from "vitest";

import {
  collectActiveTerminalThreadIds,
  collectActiveTerminalWorktreeIds,
} from "./terminalStateCleanup";

const threadId = (id: string): ThreadId => ThreadId.makeUnsafe(id);
const worktreeId = (id: string): WorktreeId => WorktreeId.makeUnsafe(id);

describe("collectActiveTerminalThreadIds", () => {
  it("retains non-deleted server threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { id: threadId("server-1"), deletedAt: null },
        { id: threadId("server-2"), deletedAt: null },
      ],
      draftThreadIds: [],
    });

    expect(activeThreadIds).toEqual(new Set([threadId("server-1"), threadId("server-2")]));
  });

  it("ignores deleted server threads and keeps local draft threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { id: threadId("server-active"), deletedAt: null },
        { id: threadId("server-deleted"), deletedAt: "2026-03-05T08:00:00.000Z" },
      ],
      draftThreadIds: [threadId("local-draft")],
    });

    expect(activeThreadIds).toEqual(new Set([threadId("server-active"), threadId("local-draft")]));
  });
});

describe("collectActiveTerminalWorktreeIds", () => {
  it("retains non-deleted worktrees", () => {
    const activeWorktreeIds = collectActiveTerminalWorktreeIds({
      snapshotWorktrees: [
        { id: worktreeId("worktree-1"), deletedAt: null },
        { id: worktreeId("worktree-2"), deletedAt: null },
      ],
    });

    expect(activeWorktreeIds).toEqual(
      new Set([worktreeId("worktree-1"), worktreeId("worktree-2")]),
    );
  });

  it("ignores deleted worktrees", () => {
    const activeWorktreeIds = collectActiveTerminalWorktreeIds({
      snapshotWorktrees: [
        { id: worktreeId("active"), deletedAt: null },
        { id: worktreeId("deleted"), deletedAt: "2026-03-05T08:00:00.000Z" },
      ],
    });

    expect(activeWorktreeIds).toEqual(new Set([worktreeId("active")]));
  });
});
