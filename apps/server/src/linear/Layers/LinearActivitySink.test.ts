import { describe, expect, it } from "vitest";

import { mapOrchestrationEventToLinearActivity } from "./LinearActivitySink.ts";

describe("LinearActivitySink", () => {
  it("keeps turn start as an ephemeral status update", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.turn-start-requested",
      payload: {
        threadId: "thread-1",
      },
    } as any);

    expect(activity).toMatchObject({
      threadId: "thread-1",
      ephemeral: true,
      content: {
        type: "thought",
        body: "Starting work...",
      },
    });
  });

  it("keeps non-command tool progress ephemeral", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          kind: "tool.updated",
          summary: "Search project",
          createdAt: "2026-04-06T12:00:00.000Z",
          payload: {
            detail: "Found 4 matches",
          },
        },
      },
    } as any);

    expect(activity).toMatchObject({
      threadId: "thread-1",
      ephemeral: true,
      content: {
        type: "thought",
        body: "Search project: Found 4 matches",
      },
    });
  });

  it("drops raw command execution churn from the Linear activity log", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          kind: "tool.started",
          summary: "Ran command",
          createdAt: "2026-04-06T12:00:00.000Z",
          payload: {
            itemType: "command_execution",
            detail: "/bin/bash -lc pwd",
          },
        },
      },
    } as any);

    expect(activity).toBeNull();
  });

  it("lets the completion reactor own the final Linear response", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.message-sent",
      payload: {
        threadId: "thread-1",
        messageId: "message-1",
        role: "assistant",
        text: "Done shipping the change.",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-04-06T12:00:00.000Z",
        updatedAt: "2026-04-06T12:00:00.000Z",
      },
    } as any);

    expect(activity).toBeNull();
  });

  it("posts file diffs as durable action entries", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.turn-diff-completed",
      payload: {
        threadId: "thread-1",
        files: [
          {
            path: "src/app.ts",
            additions: 12,
            deletions: 3,
          },
        ],
      },
    } as any);

    expect(activity).toMatchObject({
      threadId: "thread-1",
      ephemeral: false,
      content: {
        type: "action",
        action: "Changed 1 file (+12 -3)",
        parameter: "src/app.ts",
      },
    });
  });
});
