import { type OrchestrationEvent, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { LinearClient } from "../Services/LinearClient.ts";
import { LinearSessionRegistry } from "../Services/LinearSessionRegistry.ts";
import {
  LinearActivitySink,
  type LinearActivitySinkShape,
} from "../Services/LinearActivitySink.ts";

const latestEntry = <T extends { readonly createdAt: string }>(entries: ReadonlyArray<T>) =>
  entries.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);

function readActivityDetail(activity: OrchestrationThreadActivity): string | undefined {
  if (!activity.payload || typeof activity.payload !== "object") {
    return undefined;
  }

  const payload = activity.payload as { detail?: unknown; message?: unknown };
  if (typeof payload.detail === "string" && payload.detail.trim().length > 0) {
    return payload.detail.trim();
  }
  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message.trim();
  }
  return undefined;
}

function readActivityItemType(activity: OrchestrationThreadActivity): string | undefined {
  if (!activity.payload || typeof activity.payload !== "object") {
    return undefined;
  }

  const payload = activity.payload as { itemType?: unknown };
  return typeof payload.itemType === "string" ? payload.itemType : undefined;
}

function activityKindToLinearContent(activity: OrchestrationThreadActivity) {
  const detail = readActivityDetail(activity);
  const itemType = readActivityItemType(activity);
  const isCommandExecution = itemType === "command_execution";

  switch (activity.kind) {
    case "tool.started":
      if (isCommandExecution) {
        // Cyrus keeps raw command churn out of the durable issue timeline.
        return null;
      }
      return {
        content: {
          type: "thought",
          body: detail ? `${activity.summary}: ${detail}` : activity.summary,
        },
        ephemeral: true,
      } as const;
    case "tool.updated":
      if (isCommandExecution) {
        return null;
      }
      return {
        content: {
          type: "thought",
          body: detail ? `${activity.summary}: ${detail}` : activity.summary,
        },
        ephemeral: true,
      } as const;
    case "tool.completed":
      if (isCommandExecution) {
        return null;
      }
      return {
        content: {
          type: "action",
          action: activity.summary,
          parameter: detail ?? "Completed",
        },
        ephemeral: true,
      } as const;
    case "task.started":
      return {
        content: {
          type: "thought",
          body: activity.summary,
        },
        ephemeral: false,
      } as const;
    case "task.progress":
      return {
        content: {
          type: "thought",
          body: detail ? `${activity.summary}: ${detail}` : activity.summary,
        },
        ephemeral: false,
      } as const;
    case "task.completed":
      return {
        content: {
          type: "thought",
          body: detail ? `${activity.summary}: ${detail}` : activity.summary,
        },
        ephemeral: false,
      } as const;
    case "approval.requested":
      return {
        content: {
          type: "thought",
          body: `Waiting for approval: ${activity.summary}`,
        },
        ephemeral: false,
      } as const;
    case "approval.resolved":
      return {
        content: {
          type: "thought",
          body: "Approval resolved",
        },
        ephemeral: false,
      } as const;
    case "runtime.error":
      return {
        content: {
          type: "error",
          body: detail ?? activity.summary,
        },
        ephemeral: false,
      } as const;
    case "runtime.warning":
      return {
        content: {
          type: "thought",
          body: `Warning: ${detail ?? activity.summary}`,
        },
        ephemeral: false,
      } as const;
    case "turn.plan.updated":
      return {
        content: {
          type: "thought",
          body: `Plan: ${activity.summary}`,
        },
        ephemeral: false,
      } as const;
    case "prompt-mode.entered":
      return {
        content: {
          type: "thought",
          body: activity.summary,
        },
        ephemeral: false,
      } as const;
    case "user-input.requested":
      return {
        content: {
          type: "thought",
          body: "Waiting for user input...",
        },
        ephemeral: false,
      } as const;
    case "context-compaction":
    case "context-window.updated":
    case "user-input.resolved":
      return null;
    default:
      return null;
  }
}

export const mapOrchestrationEventToLinearActivity = (event: OrchestrationEvent) => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return {
        threadId: event.payload.threadId,
        content: {
          type: "thought",
          body: "Starting work...",
        },
        ephemeral: true,
      } as const;
    case "thread.message-sent":
      // Cyrus treats the terminal response as session-orchestration output, not
      // a direct echo of the raw assistant message stream.
      return null;
    case "thread.turn-diff-completed": {
      const files = event.payload.files.map((file) => file.path).join("\n");
      const additions = event.payload.files.reduce((total, file) => total + file.additions, 0);
      const deletions = event.payload.files.reduce((total, file) => total + file.deletions, 0);
      return {
        threadId: event.payload.threadId,
        content: {
          type: "action",
          action: `Changed ${event.payload.files.length} file${event.payload.files.length === 1 ? "" : "s"} (+${additions} -${deletions})`,
          parameter: files || "No files changed",
        },
        ephemeral: false,
      } as const;
    }
    case "thread.activity-appended": {
      const activity = activityKindToLinearContent(event.payload.activity);
      if (!activity) {
        return null;
      }
      return {
        threadId: event.payload.threadId,
        ...activity,
      } as const;
    }
    case "thread.session-set":
      if (event.payload.session.status === "running") {
        return {
          threadId: event.payload.threadId,
          content: {
            type: "thought",
            body: "Session started",
          },
          ephemeral: false,
        } as const;
      }
      // Cyrus relies on explicit assistant/error/response activities for terminal
      // state narration instead of adding a synthetic "session completed" banner.
      if (event.payload.session.status === "stopped") {
        return null;
      }
      if (event.payload.session.status !== "error" || !event.payload.session.lastError) {
        return null;
      }
      return {
        threadId: event.payload.threadId,
        content: {
          type: "error",
          body: event.payload.session.lastError,
        },
        ephemeral: false,
      } as const;
    default:
      return null;
  }
};

const makeLinearActivitySink = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sessionRegistry = yield* LinearSessionRegistry;
  const linearClient = yield* LinearClient;

  const publishEvent = Effect.fn("publishLinearActivityEvent")(function* (
    event: OrchestrationEvent,
  ) {
    const activity = mapOrchestrationEventToLinearActivity(event);
    if (!activity) {
      return;
    }

    const sessions = yield* sessionRegistry.listByThreadId(activity.threadId);
    const session = latestEntry(sessions);
    if (!session) {
      return;
    }

    yield* linearClient
      .createAgentActivity({
        agentSessionId: session.linearSessionId,
        content: activity.content,
        ephemeral: activity.ephemeral,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to post Linear activity update", {
            threadId: activity.threadId,
            linearSessionId: session.linearSessionId,
            detail: error.message,
          }),
        ),
      );
  });

  const start: LinearActivitySinkShape["start"] = () =>
    // Keep webhook-driven activity fanout isolated from the rest of the reactor startup.
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        publishEvent(event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("linear activity sink failed while processing event", {
              type: event.type,
              detail: error.message,
            }),
          ),
        ),
      ),
    ).pipe(Effect.asVoid);

  return {
    start,
  } satisfies LinearActivitySinkShape;
});

export const LinearActivitySinkLive = Layer.effect(LinearActivitySink, makeLinearActivitySink);
