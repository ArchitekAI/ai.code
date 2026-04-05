import { type OrchestrationEvent } from "@t3tools/contracts";
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

const toLinearActivity = (event: OrchestrationEvent) => {
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
      if (
        event.payload.role !== "assistant" ||
        event.payload.streaming ||
        !event.payload.text.trim()
      ) {
        return null;
      }
      return {
        threadId: event.payload.threadId,
        content: {
          type: "response",
          body: event.payload.text,
        },
        ephemeral: false,
      } as const;
    case "thread.turn-diff-completed": {
      const files = event.payload.files.map((file) => file.path).join("\n");
      return {
        threadId: event.payload.threadId,
        content: {
          type: "action",
          action: `Changed ${event.payload.files.length} file${event.payload.files.length === 1 ? "" : "s"}`,
          parameter: files || "No files changed",
        },
        ephemeral: true,
      } as const;
    }
    case "thread.session-set":
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
    const activity = toLinearActivity(event);
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
