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
        body: "Analyzing your request...",
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

  it("posts command completions as durable Bash action entries", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          kind: "tool.completed",
          summary: "Ran command",
          createdAt: "2026-04-06T12:00:00.000Z",
          payload: {
            itemType: "command_execution",
            detail: "/bin/bash -lc pwd",
            data: {
              item: {
                command: "/bin/bash -lc pwd",
                aggregatedOutput: "/var/lib/t3code/worktrees/ai.code/feature-aff-1605-test-issue",
                exitCode: 0,
              },
            },
          },
        },
      },
    } as any);

    expect(activity).toMatchObject({
      threadId: "thread-1",
      ephemeral: false,
      content: {
        type: "action",
        action: "Bash",
        parameter: "/bin/bash -lc pwd",
        result: "/var/lib/t3code/worktrees/ai.code/feature-aff-1605-test-issue",
      },
    });
  });

  it("posts MCP completions as durable action/result entries", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          kind: "tool.completed",
          summary: "MCP tool call",
          createdAt: "2026-04-06T12:00:00.000Z",
          payload: {
            itemType: "mcp_tool_call",
            data: {
              item: {
                tool: "github_create_pull_request",
                arguments: {
                  branch: "feature/aff-1605-test-issue",
                },
                result: {
                  structuredContent: {
                    url: "https://github.com/ArchitekAI/ai.code/pull/3",
                  },
                },
              },
            },
          },
        },
      },
    } as any);

    expect(activity).toMatchObject({
      threadId: "thread-1",
      ephemeral: false,
      content: {
        type: "action",
        action: "GitHub Create Pull Request",
        parameter: "feature/aff-1605-test-issue",
        result: "https://github.com/ArchitekAI/ai.code/pull/3",
      },
    });
  });

  it("drops reconnect warnings from the durable Linear timeline", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-06T12:00:00.000Z",
          payload: {
            message: "Reconnecting... 3/5",
            detail: {
              willRetry: true,
            },
          },
        },
      },
    } as any);

    expect(activity).toBeNull();
  });

  it("formats plan updates as a readable checklist", () => {
    const activity = mapOrchestrationEventToLinearActivity({
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          kind: "turn.plan.updated",
          summary: "Plan updated",
          createdAt: "2026-04-06T12:00:00.000Z",
          payload: {
            explanation: "Working through the request",
            plan: [
              { step: "Inspect files", status: "completed" },
              { step: "Apply patch", status: "in_progress" },
              { step: "Ship fix", status: "pending" },
            ],
          },
        },
      },
    } as any);

    expect(activity).toMatchObject({
      threadId: "thread-1",
      ephemeral: false,
      content: {
        type: "thought",
        body: "Working through the request\n[x] Inspect files\n[-] Apply patch\n[ ] Ship fix",
      },
    });
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
