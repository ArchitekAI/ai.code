import {
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type GitStatusResult,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { Duration, Effect, Exit, Layer, Option, Ref, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { GitManager, type GitActionProgressReporter } from "../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { LinearClient } from "../Services/LinearClient.ts";
import { LinearSessionRegistry } from "../Services/LinearSessionRegistry.ts";
import {
  LinearSessionCompletionReactor,
  type LinearSessionCompletionReactorShape,
} from "../Services/LinearSessionCompletionReactor.ts";
import { findLatestLiveLinearSessionContext } from "./LinearSessionContext.ts";

type CompletionCandidateEvent = Extract<
  OrchestrationEvent,
  { type: "thread.session-set" | "thread.message-sent" | "thread.turn-diff-completed" }
>;
type LinearShippingAction = "commit_push_pr" | "create_pr";

const COMPLETION_SETTLE_ATTEMPTS = 8;
const COMPLETION_SETTLE_DELAY = Duration.millis(250);

export function resolveLinearShippingAction(
  status: Pick<GitStatusResult, "isRepo" | "hasWorkingTreeChanges" | "aheadCount" | "pr">,
): LinearShippingAction | null {
  if (!status.isRepo) {
    return null;
  }
  if (status.hasWorkingTreeChanges) {
    return "commit_push_pr";
  }
  if (status.aheadCount > 0 && !status.pr) {
    return "create_pr";
  }
  return null;
}

export function isLinearCompletionCandidateStatus(
  status: OrchestrationSessionStatus,
): status is "ready" | "stopped" {
  return status === "ready" || status === "stopped";
}

function canSettleLinearCompletion(status: OrchestrationSessionStatus): boolean {
  // Provider teardown can lag behind the final assistant turn. Let completed turns
  // ship while the session is still marked running so Linear doesn't get stuck in
  // an endless "Working" state after the useful work is already done.
  return status === "running" || status === "ready" || status === "stopped";
}

export function isLinearCompletionTriggerEvent(
  event: OrchestrationEvent,
): event is CompletionCandidateEvent {
  switch (event.type) {
    case "thread.session-set":
      return isLinearCompletionCandidateStatus(event.payload.session.status);
    case "thread.message-sent":
      return (
        event.payload.role === "assistant" &&
        !event.payload.streaming &&
        event.payload.turnId !== null &&
        event.payload.text.trim().length > 0
      );
    case "thread.turn-diff-completed":
      return true;
    default:
      return false;
  }
}

function completionCandidateThreadId(event: CompletionCandidateEvent): ThreadId {
  return event.payload.threadId;
}

function completionCandidateTurnId(event: CompletionCandidateEvent): string | null {
  switch (event.type) {
    case "thread.session-set":
      return null;
    case "thread.message-sent":
      return event.payload.turnId;
    case "thread.turn-diff-completed":
      return event.payload.turnId;
  }
}

function findAssistantSummary(thread: OrchestrationThread): string {
  const assistantMessageId = thread.latestTurn?.assistantMessageId ?? null;
  const exactMessage =
    assistantMessageId === null
      ? null
      : (thread.messages.find((message) => message.id === assistantMessageId) ?? null);
  if (exactMessage?.role === "assistant" && exactMessage.text.trim().length > 0) {
    return exactMessage.text.trim();
  }

  const latestAssistant = thread.messages
    .toReversed()
    .find((message) => message.role === "assistant" && message.text.trim().length > 0);
  return latestAssistant?.text.trim() ?? "";
}

function summarizePullRequest(
  result: Pick<GitRunStackedActionResult, "pr" | "push" | "branch"> | null,
  status: Pick<GitStatusResult, "pr" | "branch">,
): string | null {
  const prUrl = result?.pr.url ?? status.pr?.url ?? null;
  if (!prUrl) {
    return null;
  }

  const prTitle = result?.pr.title ?? status.pr?.title ?? null;
  const headBranch =
    result?.pr.headBranch ?? result?.push.branch ?? result?.branch.name ?? status.pr?.headBranch;
  const lines = [
    prTitle ? `Pull request: ${prTitle}` : "Pull request is ready.",
    `PR: ${prUrl}`,
    headBranch ? `Branch: ${headBranch}` : null,
  ].filter((value): value is string => value !== null);
  return lines.join("\n");
}

export function buildLinearCompletionResponse(input: {
  readonly assistantSummary: string;
  readonly status: Pick<GitStatusResult, "pr" | "branch">;
  readonly result: Pick<GitRunStackedActionResult, "pr" | "push" | "branch"> | null;
}): string | null {
  const summary = input.assistantSummary.trim();
  const prSummary = summarizePullRequest(input.result, input.status);

  if (!summary && !prSummary) {
    return "Finished work on this issue.";
  }
  if (!prSummary) {
    return summary || null;
  }
  if (!summary) {
    return prSummary;
  }
  return `${summary}\n\n${prSummary}`;
}

function gitProgressToLinearActivity(event: GitActionProgressEvent) {
  switch (event.kind) {
    case "action_started":
      return {
        type: "thought",
        body:
          event.action === "commit_push_pr"
            ? "Shipping code changes..."
            : "Preparing pull request...",
        ephemeral: true,
      } as const;
    case "phase_started":
      return {
        type: "thought",
        body: event.label,
        ephemeral: true,
      } as const;
    case "action_finished": {
      const prUrl = event.result.pr.url ?? null;
      return prUrl
        ? ({
            type: "action",
            action: "Pull request ready",
            parameter: prUrl,
            ephemeral: false,
          } as const)
        : ({
            type: "thought",
            body: "Git shipping steps completed.",
            ephemeral: false,
          } as const);
    }
    case "action_failed":
      return {
        type: "error",
        body: event.message,
        ephemeral: false,
      } as const;
    case "hook_started":
    case "hook_output":
    case "hook_finished":
      return null;
  }
}

const make = Effect.gen(function* () {
  const gitManager = yield* GitManager;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const linearClient = yield* LinearClient;
  const sessionRegistry = yield* LinearSessionRegistry;
  const processedTurns = yield* Ref.make(new Map<ThreadId, string>());

  const lookupThreadContext = Effect.fn("lookupLinearCompletionThreadContext")(function* (
    threadId: ThreadId,
  ) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const thread =
      snapshot.threads.find(
        (entry) => entry.id === threadId && entry.archivedAt === null && entry.deletedAt === null,
      ) ?? null;
    return thread === null ? Option.none<(typeof snapshot.threads)[number]>() : Option.some(thread);
  });

  const postActivity = Effect.fn("postLinearCompletionActivity")(function* (input: {
    readonly linearSessionId: string;
    readonly content: Record<string, unknown>;
    readonly ephemeral: boolean;
  }) {
    yield* linearClient
      .createAgentActivity({
        agentSessionId: input.linearSessionId,
        content: input.content,
        ephemeral: input.ephemeral,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to post linear completion activity", {
            linearSessionId: input.linearSessionId,
            error: error.message,
          }),
        ),
      );
  });

  const postResponse = Effect.fn("postLinearCompletionResponse")(function* (input: {
    readonly linearSessionId: string;
    readonly body: string;
  }) {
    // Cyrus treats the final response as a durable terminal event for the session.
    yield* postActivity({
      linearSessionId: input.linearSessionId,
      content: {
        type: "response",
        body: input.body,
      },
      ephemeral: false,
    });
  });

  const hasProcessedTurn = Effect.fn("hasProcessedLinearTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: string;
  }) {
    return yield* Ref.get(processedTurns).pipe(
      Effect.map((current) => (current.get(input.threadId) ?? null) === input.turnId),
    );
  });

  const markTurnProcessed = Effect.fn("markLinearTurnProcessed")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: string;
  }) {
    yield* Ref.update(processedTurns, (current) => {
      const next = new Map(current);
      next.set(input.threadId, input.turnId);
      return next;
    });
  });

  const loadSettledCompletionContext = Effect.fn("loadSettledLinearCompletionContext")(
    function* (input: { readonly threadId: ThreadId; readonly eventTurnId: string | null }) {
      for (let attempt = 0; attempt < COMPLETION_SETTLE_ATTEMPTS; attempt += 1) {
        const snapshot = yield* projectionSnapshotQuery.getSnapshot();
        const thread =
          snapshot.threads.find(
            (entry) =>
              entry.id === input.threadId && entry.archivedAt === null && entry.deletedAt === null,
          ) ?? null;
        if (
          thread &&
          thread.latestTurn &&
          thread.latestTurn.state === "completed" &&
          thread.session &&
          canSettleLinearCompletion(thread.session.status) &&
          (input.eventTurnId === null || input.eventTurnId === thread.latestTurn.turnId)
        ) {
          return {
            snapshot,
            thread,
          };
        }
        if (attempt < COMPLETION_SETTLE_ATTEMPTS - 1) {
          yield* Effect.sleep(COMPLETION_SETTLE_DELAY);
        }
      }
      return null;
    },
  );

  const processCompletionCandidateThread = Effect.fn("processLinearCompletionCandidateThread")(
    function* (event: CompletionCandidateEvent) {
      const threadId = completionCandidateThreadId(event);
      const settledContext = yield* loadSettledCompletionContext({
        threadId,
        eventTurnId: completionCandidateTurnId(event),
      });
      if (!settledContext) {
        return;
      }
      const { snapshot, thread } = settledContext;
      const latestTurn = thread.latestTurn;
      if (!latestTurn) {
        return;
      }

      const turnId = latestTurn.turnId;
      const alreadyProcessed = yield* hasProcessedTurn({
        threadId: thread.id,
        turnId,
      });
      if (alreadyProcessed) {
        return;
      }

      const threadSessions = yield* sessionRegistry.listByThreadId(thread.id);
      const latestLinearSession = yield* findLatestLiveLinearSessionContext({
        sessions: threadSessions,
        lookupThreadContext,
        removeSession: sessionRegistry.remove,
      });
      if (!latestLinearSession) {
        return;
      }

      const project = snapshot.projects.find((entry) => entry.id === thread.projectId) ?? null;
      const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
      if (!cwd) {
        return;
      }

      const statusResult = yield* gitManager.status({ cwd }).pipe(Effect.exit);
      const assistantSummary = findAssistantSummary(thread);
      if (Exit.isFailure(statusResult)) {
        const detail = `Failed to inspect git status: ${statusResult.cause.toString()}`;
        yield* postActivity({
          linearSessionId: latestLinearSession.session.linearSessionId,
          content: {
            type: "error",
            body: detail,
          },
          ephemeral: false,
        });
        yield* postResponse({
          linearSessionId: latestLinearSession.session.linearSessionId,
          body: assistantSummary ? `${assistantSummary}\n\n${detail}` : detail,
        });
        yield* markTurnProcessed({
          threadId: thread.id,
          turnId,
        });
        return;
      }

      const gitStatus: GitStatusResult = statusResult.value;
      const shippingAction = resolveLinearShippingAction(gitStatus);

      if (!shippingAction) {
        const noOpResponse = buildLinearCompletionResponse({
          assistantSummary,
          status: gitStatus,
          result: null,
        });
        if (noOpResponse) {
          yield* postResponse({
            linearSessionId: latestLinearSession.session.linearSessionId,
            body: noOpResponse,
          });
        }
        yield* markTurnProcessed({
          threadId: thread.id,
          turnId,
        });
        return;
      }

      const progressReporter: GitActionProgressReporter = {
        publish: (progressEvent: GitActionProgressEvent) => {
          const activity = gitProgressToLinearActivity(progressEvent);
          if (!activity) {
            return Effect.void;
          }
          return postActivity({
            linearSessionId: latestLinearSession.session.linearSessionId,
            content:
              activity.type === "thought"
                ? { type: "thought", body: activity.body }
                : activity.type === "action"
                  ? {
                      type: "action",
                      action: activity.action,
                      ...(activity.parameter ? { parameter: activity.parameter } : {}),
                    }
                  : { type: "error", body: activity.body },
            ephemeral: activity.ephemeral,
          });
        },
      };

      const actionEffect = gitManager
        .runStackedAction(
          {
            actionId: `linear:${latestLinearSession.session.linearSessionId}:${turnId}`,
            cwd,
            action: shippingAction,
          },
          { progressReporter },
        )
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const detail = `Automatic shipping failed: ${error.message}`;
              yield* postActivity({
                linearSessionId: latestLinearSession.session.linearSessionId,
                content: {
                  type: "error",
                  body: detail,
                },
                ephemeral: false,
              });
              yield* postResponse({
                linearSessionId: latestLinearSession.session.linearSessionId,
                body: assistantSummary ? `${assistantSummary}\n\n${detail}` : detail,
              });
              return null;
            }),
          ),
        );
      const actionResult = yield* actionEffect;
      if (!actionResult) {
        yield* markTurnProcessed({
          threadId: thread.id,
          turnId,
        });
        return;
      }

      // Cyrus treats terminal narration as a session concern. We mirror that here
      // so Linear gets one durable completion response even if the provider has
      // already transitioned the session to stopped by the time shipping finishes.
      const responseBody = buildLinearCompletionResponse({
        assistantSummary,
        status: gitStatus,
        result: actionResult,
      });
      if (!responseBody) {
        yield* markTurnProcessed({
          threadId: thread.id,
          turnId,
        });
        return;
      }

      yield* postResponse({
        linearSessionId: latestLinearSession.session.linearSessionId,
        body: responseBody,
      });
      yield* markTurnProcessed({
        threadId: thread.id,
        turnId,
      });
    },
  );

  const worker = yield* makeDrainableWorker((event: CompletionCandidateEvent) =>
    processCompletionCandidateThread(event).pipe(
      Effect.catch((error) =>
        Effect.logWarning("linear session completion reactor failed to process event", {
          threadId: completionCandidateThreadId(event),
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );

  const start: LinearSessionCompletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!isLinearCompletionTriggerEvent(event)) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
  } satisfies LinearSessionCompletionReactorShape;
});

export const LinearSessionCompletionReactorLive = Layer.effect(
  LinearSessionCompletionReactor,
  make,
);
