import { exec } from "node:child_process";

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
import { moveIssueToReviewState } from "./LinearIssueLifecycle.ts";
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
  previewUrl?: string | null,
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
    previewUrl ? `Preview: ${previewUrl}` : null,
  ].filter((value): value is string => value !== null);
  return lines.join("\n");
}

export function buildLinearCompletionResponse(input: {
  readonly assistantSummary: string;
  readonly status: Pick<GitStatusResult, "pr" | "branch">;
  readonly result: Pick<GitRunStackedActionResult, "pr" | "push" | "branch"> | null;
  readonly previewUrl?: string | null;
}): string | null {
  const summary = input.assistantSummary.trim();
  const prSummary = summarizePullRequest(input.result, input.status, input.previewUrl);

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

// ---------------------------------------------------------------------------
// Vercel preview URL detection
// ---------------------------------------------------------------------------

const VERCEL_POLL_ATTEMPTS = 6;
const VERCEL_POLL_DELAY = Duration.seconds(10);

/**
 * Best-effort detection of a Vercel preview deployment URL from GitHub PR checks.
 *
 * Uses `gh pr checks` to find a Vercel check run with a preview URL. Polls a
 * few times to give Vercel time to start the deployment. Returns null if the
 * `gh` CLI is unavailable, the PR has no Vercel check, or the check hasn't
 * completed within the polling window.
 */
function fetchVercelPreviewUrl(input: {
  readonly cwd: string;
  readonly prNumber: number;
}): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    // Initial delay to give Vercel time to register the check
    yield* Effect.sleep(Duration.seconds(15));

    for (let attempt = 0; attempt < VERCEL_POLL_ATTEMPTS; attempt += 1) {
      const result = yield* Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            exec(
              `gh pr checks ${input.prNumber} --json name,detailsUrl,state`,
              { cwd: input.cwd, timeout: 10_000 },
              (error, stdout) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(stdout.trim());
                }
              },
            );
          }),
        catch: () => null,
      });

      if (!result) {
        return null;
      }

      const checks: ReadonlyArray<{
        name?: string;
        detailsUrl?: string;
        state?: string;
      }> = (() => {
        try {
          return JSON.parse(result) as typeof checks;
        } catch {
          return [];
        }
      })();

      // Look for a completed Vercel check with a details URL
      const vercelCheck = checks.find(
        (check) =>
          check.name?.toLowerCase().includes("vercel") &&
          check.state?.toUpperCase() === "SUCCESS" &&
          check.detailsUrl?.trim(),
      );

      if (vercelCheck?.detailsUrl) {
        return vercelCheck.detailsUrl.trim();
      }

      // Also check for deployment status checks that contain vercel URLs
      const deploymentCheck = checks.find(
        (check) =>
          check.detailsUrl?.includes("vercel.app") && check.state?.toUpperCase() === "SUCCESS",
      );

      if (deploymentCheck?.detailsUrl) {
        return deploymentCheck.detailsUrl.trim();
      }

      if (attempt < VERCEL_POLL_ATTEMPTS - 1) {
        yield* Effect.sleep(VERCEL_POLL_DELAY);
      }
    }

    return null;
  }).pipe(Effect.catch(() => Effect.succeed(null)));
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
        Effect.catch((error) => {
          // Log to both Effect and stderr so the error is visible in journalctl.
          console.error("[linear-completion] failed to post activity", {
            linearSessionId: input.linearSessionId,
            contentType: (input.content as Record<string, unknown>).type,
            error: error.message,
          });
          return Effect.logWarning("failed to post linear completion activity", {
            linearSessionId: input.linearSessionId,
            error: error.message,
          });
        }),
      );
  });

  const postResponse = Effect.fn("postLinearCompletionResponse")(function* (input: {
    readonly linearSessionId: string;
    readonly body: string;
  }) {
    // Cyrus treats the final response as a durable terminal event for the session.
    // The `type: "response"` activity signals Linear that the agent is done working.
    console.log("[linear-completion] posting terminal response", {
      linearSessionId: input.linearSessionId,
      bodyLength: input.body.length,
    });
    yield* postActivity({
      linearSessionId: input.linearSessionId,
      content: {
        type: "response",
        body: input.body,
      },
      ephemeral: false,
    });
  });

  const resolveTeamIdForIssue = Effect.fn("resolveTeamIdForIssue")(function* (issueId: string) {
    const issue = yield* linearClient
      .fetchIssue(issueId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return issue?.teamId ?? "";
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
      console.log("[linear-completion] processing candidate event", {
        type: event.type,
        threadId,
        turnId: completionCandidateTurnId(event),
      });
      const settledContext = yield* loadSettledCompletionContext({
        threadId,
        eventTurnId: completionCandidateTurnId(event),
      });
      if (!settledContext) {
        console.log("[linear-completion] settled context was null, skipping", { threadId });
        return;
      }
      const { snapshot, thread } = settledContext;
      console.log("[linear-completion] settled", {
        threadId: thread.id,
        turnState: thread.latestTurn?.state,
        sessionStatus: thread.session?.status,
      });
      const latestTurn = thread.latestTurn;
      if (!latestTurn) {
        console.log("[linear-completion] no latest turn, skipping");
        return;
      }

      const turnId = latestTurn.turnId;
      const alreadyProcessed = yield* hasProcessedTurn({
        threadId: thread.id,
        turnId,
      });
      if (alreadyProcessed) {
        console.log("[linear-completion] turn already processed, skipping", { turnId });
        return;
      }

      const threadSessions = yield* sessionRegistry.listByThreadId(thread.id);
      const latestLinearSession = yield* findLatestLiveLinearSessionContext({
        sessions: threadSessions,
        lookupThreadContext,
        removeSession: sessionRegistry.remove,
      });
      if (!latestLinearSession) {
        console.log("[linear-completion] no linear session found for thread", {
          threadId: thread.id,
          sessionCount: threadSessions.length,
        });
        return;
      }
      console.log("[linear-completion] found linear session", {
        linearSessionId: latestLinearSession.session.linearSessionId,
        issueIdentifier: latestLinearSession.session.issueIdentifier,
      });

      const project = snapshot.projects.find((entry) => entry.id === thread.projectId) ?? null;
      const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
      if (!cwd) {
        console.log("[linear-completion] no cwd, skipping");
        return;
      }

      console.log("[linear-completion] checking git status", { cwd });
      const statusResult = yield* gitManager.status({ cwd }).pipe(Effect.exit);
      const assistantSummary = findAssistantSummary(thread);
      console.log("[linear-completion] git status result", {
        success: Exit.isSuccess(statusResult),
        assistantSummaryLen: assistantSummary.length,
        ...(Exit.isSuccess(statusResult)
          ? {
              hasWorkingTreeChanges: statusResult.value.hasWorkingTreeChanges,
              aheadCount: statusResult.value.aheadCount,
              hasPr: !!statusResult.value.pr,
            }
          : {}),
      });
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

      // When the agent already created and pushed a PR, skip automatic shipping
      // and go straight to posting the terminal response. The agent's verify-and-
      // ship prompt extension handles commit/push/PR creation. Attempting to ship
      // again can cause the completion reactor to hang on redundant git operations.
      const agentAlreadyShipped = !!gitStatus.pr;
      const shippingAction = agentAlreadyShipped ? null : resolveLinearShippingAction(gitStatus);

      console.log("[linear-completion] shipping decision", {
        shippingAction,
        agentAlreadyShipped,
        hasPr: !!gitStatus.pr,
        hasWorkingTreeChanges: gitStatus.hasWorkingTreeChanges,
        aheadCount: gitStatus.aheadCount,
      });

      if (!shippingAction) {
        // When the agent already created the PR, move issue to "In Review".
        if (gitStatus.pr) {
          yield* moveIssueToReviewState({
            issueId: latestLinearSession.session.issueId,
            issueIdentifier: latestLinearSession.session.issueIdentifier,
            teamId: yield* resolveTeamIdForIssue(latestLinearSession.session.issueId),
          });
        }

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

      console.log("[linear-completion] running stacked action", { shippingAction, cwd });
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
          Effect.timeout(Duration.minutes(3)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const detail = `Automatic shipping failed: ${error instanceof Error ? error.message : String(error)}`;
              console.error("[linear-completion] shipping failed", { detail });
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

      // Move issue to "In Review" after successful PR creation.
      // Fire-and-forget — don't block the completion response on this.
      const prWasCreatedOrOpened =
        actionResult.pr.status === "created" || actionResult.pr.status === "opened_existing";
      if (prWasCreatedOrOpened) {
        yield* moveIssueToReviewState({
          issueId: latestLinearSession.session.issueId,
          issueIdentifier: latestLinearSession.session.issueIdentifier,
          teamId: yield* resolveTeamIdForIssue(latestLinearSession.session.issueId),
        });
      }

      // Best-effort Vercel preview URL detection. Runs in the background and
      // posts a follow-up activity if a preview is found after the initial
      // completion response has already been sent.
      const prNumber = actionResult.pr.number;
      if (prNumber && prWasCreatedOrOpened) {
        yield* Effect.forkDaemon(
          fetchVercelPreviewUrl({ cwd, prNumber }).pipe(
            Effect.flatMap((previewUrl) => {
              if (!previewUrl) {
                return Effect.void;
              }
              return postActivity({
                linearSessionId: latestLinearSession.session.linearSessionId,
                content: {
                  type: "action",
                  action: "Preview deployment ready",
                  parameter: previewUrl,
                },
                ephemeral: false,
              });
            }),
            Effect.catch((error) =>
              Effect.logWarning("vercel preview detection failed", {
                prNumber,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        );
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
