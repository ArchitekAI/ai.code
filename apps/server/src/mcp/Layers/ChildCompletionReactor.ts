import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { BootstrapTurnService } from "../../orchestration/Services/BootstrapTurnService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ChildCompletionReactor,
  type ChildCompletionReactorShape,
} from "../Services/ChildCompletionReactor.ts";
import { ThreadRelationshipRegistry } from "../Services/ThreadRelationshipRegistry.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
    }
  | {
      readonly source: "domain";
      readonly event: Extract<OrchestrationEvent, { type: "thread.session-set" }>;
    };

const serverCommandId = (tag: string) =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const lastAssistantMessage = (thread: {
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
  }>;
}) =>
  thread.messages
    .toReversed()
    .find((message) => message.role === "assistant" && message.text.trim().length > 0)?.text ?? "";

const make = Effect.gen(function* () {
  const bootstrapTurnService = yield* BootstrapTurnService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const threadRelationshipRegistry = yield* ThreadRelationshipRegistry;

  const resumeParent = Effect.fn("resumeParentFromChildTurn")(function* (input: {
    readonly childThreadId: ThreadId;
    readonly resumeKey: string;
    readonly status: "completed" | "error";
  }) {
    const relationshipOption = yield* threadRelationshipRegistry.findParent(input.childThreadId);
    if (Option.isNone(relationshipOption)) {
      return;
    }

    const marked = yield* threadRelationshipRegistry.markResumed(
      input.childThreadId,
      input.resumeKey,
    );
    if (!marked) {
      return;
    }

    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const childThread = snapshot.threads.find((thread) => thread.id === input.childThreadId);
    const parentThread = snapshot.threads.find(
      (thread) => thread.id === relationshipOption.value.parentThreadId,
    );
    if (!childThread || !parentThread) {
      return;
    }

    const summaryText =
      lastAssistantMessage(childThread).trim() || "No assistant summary was produced.";
    const childWorktreePath =
      relationshipOption.value.childWorktreePath ?? childThread.worktreePath ?? "unknown";
    const createdAt = new Date().toISOString();

    yield* bootstrapTurnService.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("child-completion-resume"),
      threadId: parentThread.id,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: [
          "## Child task completed",
          "",
          `Issue: ${relationshipOption.value.childIssueIdentifier ?? "unknown"}`,
          `Child worktree: ${childWorktreePath}`,
          `Status: ${input.status}`,
          "",
          "---",
          "",
          summaryText,
          "",
          "---",
          "",
          "Review the child's work inside the child worktree and decide next steps.",
        ].join("\n"),
        attachments: [],
      },
      modelSelection: parentThread.modelSelection,
      titleSeed: parentThread.title,
      runtimeMode: parentThread.runtimeMode,
      interactionMode: parentThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      ...(childWorktreePath !== "unknown" ? { additionalDirectories: [childWorktreePath] } : {}),
      createdAt,
    });
  });

  const processRuntimeEvent = Effect.fn("processChildCompletionRuntimeEvent")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const turnId = event.turnId as TurnId | undefined;
    if (!turnId) {
      return;
    }
    yield* resumeParent({
      childThreadId: event.threadId,
      resumeKey: turnId,
      status: event.payload.state === "failed" ? "error" : "completed",
    });
  });

  const processDomainEvent = Effect.fn("processChildCompletionDomainEvent")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
  ) {
    if (event.payload.session.status !== "error") {
      return;
    }
    const resumeKey = event.payload.session.activeTurnId ?? `error:${event.occurredAt}`;
    yield* resumeParent({
      childThreadId: event.payload.threadId,
      resumeKey,
      status: "error",
    });
  });

  const worker = yield* makeDrainableWorker((input: ReactorInput) =>
    (input.source === "runtime"
      ? processRuntimeEvent(input.event)
      : processDomainEvent(input.event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("child completion reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const start: ChildCompletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.session-set") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
  } satisfies ChildCompletionReactorShape;
});

export const ChildCompletionReactorLive = Layer.effect(ChildCompletionReactor, make);
