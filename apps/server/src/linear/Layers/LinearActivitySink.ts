import { type OrchestrationEvent, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { LinearClient } from "../Services/LinearClient.ts";
import { LinearSessionRegistry } from "../Services/LinearSessionRegistry.ts";
import {
  LinearActivitySink,
  type LinearActivitySinkShape,
} from "../Services/LinearActivitySink.ts";
import { formatLinearActivityContent } from "./LinearActivityFormatter.ts";
import { findLatestLiveLinearSessionContext } from "./LinearSessionContext.ts";

function activityKindToLinearContent(activity: OrchestrationThreadActivity) {
  return formatLinearActivityContent(activity);
}

export const mapOrchestrationEventToLinearActivity = (event: OrchestrationEvent) => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return {
        threadId: event.payload.threadId,
        content: {
          type: "thought",
          body: "Analyzing your request...",
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
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const sessionRegistry = yield* LinearSessionRegistry;
  const linearClient = yield* LinearClient;

  const lookupThreadContext = Effect.fn("lookupLinearSinkThreadContext")(function* (
    threadId: string,
  ) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const thread =
      snapshot.threads.find(
        (entry) => entry.id === threadId && entry.archivedAt === null && entry.deletedAt === null,
      ) ?? null;
    return thread === null ? Option.none<(typeof snapshot.threads)[number]>() : Option.some(thread);
  });

  const publishEvent = Effect.fn("publishLinearActivityEvent")(function* (
    event: OrchestrationEvent,
  ) {
    const activity = mapOrchestrationEventToLinearActivity(event);
    if (!activity) {
      return;
    }

    const sessions = yield* sessionRegistry.listByThreadId(activity.threadId);
    const sessionContext = yield* findLatestLiveLinearSessionContext({
      sessions,
      lookupThreadContext,
      removeSession: sessionRegistry.remove,
    });
    if (!sessionContext) {
      return;
    }

    yield* linearClient
      .createAgentActivity({
        agentSessionId: sessionContext.session.linearSessionId,
        content: activity.content,
        ephemeral: activity.ephemeral,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to post Linear activity update", {
            threadId: activity.threadId,
            linearSessionId: sessionContext.session.linearSessionId,
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
