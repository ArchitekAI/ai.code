import {
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type GitStatusResult,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Ref, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { GitManager, type GitActionProgressReporter } from "../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { LinearClient } from "../Services/LinearClient.ts";
import { LinearSessionRegistry } from "../Services/LinearSessionRegistry.ts";
import {
  LinearSessionCompletionReactor,
  type LinearSessionCompletionReactorShape,
} from "../Services/LinearSessionCompletionReactor.ts";

type CompletionCandidateEvent = Extract<
  OrchestrationEvent,
  { type: "thread.session-set" | "thread.message-sent" | "thread.turn-diff-completed" }
>;
type LinearShippingAction = "commit_push_pr" | "create_pr";

const latestByCreatedAt = <T extends { readonly createdAt: string }>(entries: ReadonlyArray<T>) =>
  entries.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;

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

function gitProgressToLinearContent(event: GitActionProgressEvent) {
  switch (event.kind) {
    case "action_started":
      return {
        type: "thought",
        body:
          event.action === "commit_push_pr"
            ? "Shipping code changes..."
            : "Preparing pull request...",
      } as const;
    case "phase_started":
      return {
        type: "thought",
        body: event.label,
      } as const;
    case "action_finished": {
      const prUrl = event.result.pr.url ?? null;
      return prUrl
        ? ({
            type: "action",
            action: "Pull request ready",
            parameter: prUrl,
          } as const)
        : ({
            type: "thought",
            body: "Git shipping steps completed.",
          } as const);
    }
    case "action_failed":
      return {
        type: "error",
        body: event.message,
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
  const linearClient = yield* LinearClient;
  const sessionRegistry = yield* LinearSessionRegistry;
  const processedTurns = yield* Ref.make(new Map<ThreadId, string>());

  const postDurableActivity = Effect.fn("postLinearCompletionActivity")(function* (input: {
    readonly linearSessionId: string;
    readonly content: Record<string, unknown>;
  }) {
    // These activities are the durable audit trail that mirrors Cyrus's
    // session-manager behavior instead of relying on ephemeral status banners.
    yield* linearClient
      .createAgentActivity({
        agentSessionId: input.linearSessionId,
        content: input.content,
        ephemeral: false,
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
    yield* postDurableActivity({
      linearSessionId: input.linearSessionId,
      content: {
        type: "response",
        body: input.body,
      },
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

  const processCompletionCandidateThread = Effect.fn("processLinearCompletionCandidateThread")(
    function* (event: CompletionCandidateEvent) {
      const threadId = completionCandidateThreadId(event);
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId) ?? null;
      if (!thread || !thread.latestTurn || thread.latestTurn.state !== "completed") {
        return;
      }

      // Completion can race with projection updates, so we only process once the
      // read model shows the terminal session state and the latest turn matches
      // the event that nudged us to re-check.
      if (!thread.session || !isLinearCompletionCandidateStatus(thread.session.status)) {
        return;
      }

      const eventTurnId = completionCandidateTurnId(event);
      if (eventTurnId !== null && eventTurnId !== thread.latestTurn.turnId) {
        return;
      }

      const turnId = thread.latestTurn.turnId;
      const alreadyProcessed = yield* hasProcessedTurn({
        threadId: thread.id,
        turnId,
      });
      if (alreadyProcessed) {
        return;
      }

      const threadSessions = yield* sessionRegistry.listByThreadId(thread.id);
      const latestLinearSession = latestByCreatedAt(threadSessions);
      if (!latestLinearSession) {
        return;
      }

      const project = readModel.projects.find((entry) => entry.id === thread.projectId) ?? null;
      const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
      if (!cwd) {
        return;
      }

      const statusResult = yield* gitManager.status({ cwd }).pipe(Effect.exit);
      const assistantSummary = findAssistantSummary(thread);
      if (Exit.isFailure(statusResult)) {
        const detail = `Failed to inspect git status: ${statusResult.cause.toString()}`;
        yield* postDurableActivity({
          linearSessionId: latestLinearSession.linearSessionId,
          content: {
            type: "error",
            body: detail,
          },
        });
        yield* postResponse({
          linearSessionId: latestLinearSession.linearSessionId,
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
            linearSessionId: latestLinearSession.linearSessionId,
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
          const content = gitProgressToLinearContent(progressEvent);
          if (!content) {
            return Effect.void;
          }
          return postDurableActivity({
            linearSessionId: latestLinearSession.linearSessionId,
            content,
          });
        },
      };

      const actionEffect = gitManager
        .runStackedAction(
          {
            actionId: `linear:${latestLinearSession.linearSessionId}:${turnId}`,
            cwd,
            action: shippingAction,
          },
          { progressReporter },
        )
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const detail = `Automatic shipping failed: ${error.message}`;
              yield* postDurableActivity({
                linearSessionId: latestLinearSession.linearSessionId,
                content: {
                  type: "error",
                  body: detail,
                },
              });
              yield* postResponse({
                linearSessionId: latestLinearSession.linearSessionId,
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
        return;
      }

      yield* postResponse({
        linearSessionId: latestLinearSession.linearSessionId,
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
