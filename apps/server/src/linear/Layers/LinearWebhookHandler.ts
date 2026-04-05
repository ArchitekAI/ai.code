import { LinearWebhookClient } from "@linear/sdk/webhooks";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  LinearAgentSessionCreatedWebhook,
  type LinearAgentSessionCreatedWebhook as LinearAgentSessionCreatedWebhookPayload,
  LinearAgentSessionPromptedWebhook,
  type LinearAgentSessionPromptedWebhook as LinearAgentSessionPromptedWebhookPayload,
  LinearIssueUnassignedWebhook,
  type LinearIssueUnassignedWebhook as LinearIssueUnassignedWebhookPayload,
  LinearWebhookHandlerError,
  LinearWebhookVerificationError,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  type LinearProjectMapping,
  ThreadId,
} from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { Effect, Layer, Option, Path, Schema } from "effect";

import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BootstrapTurnService } from "../../orchestration/Services/BootstrapTurnService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { LinearClient } from "../Services/LinearClient.ts";
import { LinearSessionRegistry } from "../Services/LinearSessionRegistry.ts";
import {
  LinearWebhookHandler,
  type LinearWebhookHandlerShape,
} from "../Services/LinearWebhookHandler.ts";

const DEFAULT_LINEAR_MODEL_SELECTION = {
  provider: "codex" as const,
  model: "gpt-5-codex",
};

const LINEAR_AGENT_SESSION_MARKER = "This thread is for an agent session";

const makeServerCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const latestEntry = <T extends { readonly createdAt: string }>(entries: ReadonlyArray<T>) =>
  entries.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);

const resolveMapping = (input: {
  readonly issueTeamKey: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
  readonly defaultWorkspaceRoot: string;
}): LinearProjectMapping | null => {
  const normalizedTeamKey = input.issueTeamKey.trim().toLowerCase();
  const normalizedLabels = new Set(input.labelNames.map((label) => label.trim().toLowerCase()));

  const labelMatch =
    input.mappings.find((mapping) => {
      const mappingLabel = mapping.labelName?.trim().toLowerCase();
      const mappingTeamKey = mapping.teamKey?.trim().toLowerCase();
      if (!mappingLabel || !normalizedLabels.has(mappingLabel)) {
        return false;
      }
      return mappingTeamKey ? mappingTeamKey === normalizedTeamKey : true;
    }) ?? null;
  if (labelMatch) {
    return labelMatch;
  }

  const teamMatch =
    input.mappings.find((mapping) => {
      const mappingTeamKey = mapping.teamKey?.trim().toLowerCase();
      return mappingTeamKey === normalizedTeamKey && !mapping.labelName;
    }) ?? null;
  if (teamMatch) {
    return teamMatch;
  }

  return input.defaultWorkspaceRoot.trim()
    ? {
        workspaceRoot: input.defaultWorkspaceRoot.trim(),
      }
    : null;
};

const promptFromPromptedWebhook = (webhook: LinearAgentSessionPromptedWebhookPayload) => {
  const activityBody = webhook.agentActivity?.content?.body?.trim() ?? "";
  if (activityBody) {
    return activityBody;
  }
  const commentBody = webhook.agentSession.comment?.body?.trim() ?? "";
  if (commentBody) {
    return commentBody;
  }
  return webhook.agentSession.issue.title;
};

const makeLinearWebhookHandler = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const startup = yield* ServerRuntimeStartup;
  const bootstrapTurnService = yield* BootstrapTurnService;
  const sessionRegistry = yield* LinearSessionRegistry;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const linearClient = yield* LinearClient;
  const path = yield* Path.Path;

  const dispatchCommand = Effect.fn("dispatchCommand")(function* (
    command: Parameters<typeof orchestrationEngine.dispatch>[0],
  ) {
    return yield* startup.enqueueCommand(bootstrapTurnService.dispatch(command)).pipe(
      Effect.mapError((cause) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? new LinearWebhookHandlerError({
              detail: cause.message,
              cause,
            })
          : new LinearWebhookHandlerError({
              detail: "Failed to dispatch Linear-driven orchestration command.",
              cause,
            }),
      ),
    );
  });

  const ensureProjectForWorkspaceRoot = Effect.fn("ensureProjectForWorkspaceRoot")(function* (
    workspaceRoot: string,
  ) {
    const existingProject =
      yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(workspaceRoot);
    if (Option.isSome(existingProject)) {
      return {
        id: existingProject.value.id,
        defaultModelSelection:
          existingProject.value.defaultModelSelection ?? DEFAULT_LINEAR_MODEL_SELECTION,
      };
    }

    const createdAt = new Date().toISOString();
    const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
    const projectTitle = path.basename(workspaceRoot) || "project";

    // Reuse the existing project.create path so webhook projects behave like UI-created projects.
    yield* dispatchCommand({
      type: "project.create",
      commandId: makeServerCommandId("linear-project-create"),
      projectId,
      title: projectTitle,
      workspaceRoot,
      defaultModelSelection: DEFAULT_LINEAR_MODEL_SELECTION,
      createdAt,
    });

    return {
      id: projectId,
      defaultModelSelection: DEFAULT_LINEAR_MODEL_SELECTION,
    };
  });

  const findThreadContext = Effect.fn("findThreadContext")(function* (threadId: ThreadId) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const thread = snapshot.threads.find(
      (entry) => entry.id === threadId && entry.deletedAt === null,
    );
    if (!thread) {
      return yield* new LinearWebhookHandlerError({
        detail: `No active thread found for Linear thread mapping ${threadId}.`,
      });
    }
    return thread;
  });

  const initialPromptFromCreatedWebhook = (
    webhook: LinearAgentSessionCreatedWebhookPayload,
    issueDescription: string,
  ) => {
    const commentBody = webhook.agentSession.comment?.body?.trim() ?? "";
    if (commentBody && !commentBody.includes(LINEAR_AGENT_SESSION_MARKER)) {
      return commentBody;
    }
    const description = issueDescription.trim();
    if (description) {
      return description;
    }
    return webhook.agentSession.issue.title;
  };

  const stopThreadForSession = Effect.fn("stopThreadForSession")(function* (threadId: ThreadId) {
    const createdAt = new Date().toISOString();
    yield* dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: makeServerCommandId("linear-turn-interrupt"),
      threadId,
      createdAt,
    });
    yield* dispatchCommand({
      type: "thread.session.stop",
      commandId: makeServerCommandId("linear-session-stop"),
      threadId,
      createdAt,
    });
  });

  const handleCreated = Effect.fn("handleCreated")(function* (
    webhook: LinearAgentSessionCreatedWebhookPayload,
  ) {
    const fetchedIssue = yield* linearClient.fetchIssue(webhook.agentSession.issue.id);
    const prompt = initialPromptFromCreatedWebhook(webhook, fetchedIssue.description);
    const issueSessions = yield* sessionRegistry.listByIssueId(fetchedIssue.id);
    const existingIssueSession = latestEntry(issueSessions);

    if (existingIssueSession) {
      const existingThread = yield* findThreadContext(existingIssueSession.threadId);
      const createdAt = new Date().toISOString();
      yield* dispatchCommand({
        type: "thread.turn.start",
        commandId: makeServerCommandId("linear-turn-start"),
        threadId: existingThread.id,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection: existingThread.modelSelection,
        titleSeed: fetchedIssue.title,
        runtimeMode: existingThread.runtimeMode,
        interactionMode: existingThread.interactionMode,
        createdAt,
      });
      yield* sessionRegistry.register({
        linearSessionId: webhook.agentSession.id,
        threadId: existingIssueSession.threadId,
        projectId: existingIssueSession.projectId,
        issueId: fetchedIssue.id,
        issueIdentifier: fetchedIssue.identifier,
        createdAt,
      });
      return;
    }

    const settings = yield* serverSettings.getSettings;
    const mapping = resolveMapping({
      issueTeamKey: fetchedIssue.teamKey,
      labelNames: fetchedIssue.labelNames,
      mappings: settings.linearProjectMappings.mappings,
      defaultWorkspaceRoot: settings.linearProjectMappings.defaultWorkspaceRoot,
    });

    if (!mapping) {
      return yield* new LinearWebhookHandlerError({
        detail: `No Linear project mapping matched ${fetchedIssue.identifier}.`,
      });
    }

    const project = yield* ensureProjectForWorkspaceRoot(mapping.workspaceRoot);
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
    const branchName = sanitizeFeatureBranchName(
      `${fetchedIssue.identifier} ${fetchedIssue.title}`,
    );

    yield* dispatchCommand({
      type: "thread.turn.start",
      commandId: makeServerCommandId("linear-bootstrap-turn-start"),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: prompt,
        attachments: [],
      },
      modelSelection: project.defaultModelSelection,
      titleSeed: fetchedIssue.title,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      bootstrap: {
        createThread: {
          projectId: project.id,
          title: fetchedIssue.identifier,
          modelSelection: project.defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
        prepareWorktree: {
          projectCwd: mapping.workspaceRoot,
          baseBranch: mapping.baseBranch ?? "main",
          branch: branchName,
        },
        runSetupScript: true,
      },
      createdAt,
    });

    yield* sessionRegistry.register({
      linearSessionId: webhook.agentSession.id,
      threadId,
      projectId: project.id,
      issueId: fetchedIssue.id,
      issueIdentifier: fetchedIssue.identifier,
      createdAt,
    });
  });

  const handlePrompted = Effect.fn("handlePrompted")(function* (
    webhook: LinearAgentSessionPromptedWebhookPayload,
  ) {
    const issueId = webhook.agentSession.issueId ?? webhook.agentSession.issue.id;
    const sessionLookup = yield* sessionRegistry.lookupBySessionId(webhook.agentSession.id);
    const fallbackSessions = yield* sessionRegistry.listByIssueId(issueId);
    const targetSession = Option.match(sessionLookup, {
      onNone: () => latestEntry(fallbackSessions) ?? null,
      onSome: (session) => session,
    });

    if (!targetSession) {
      return yield* new LinearWebhookHandlerError({
        detail: `No Linear session mapping found for prompted issue ${issueId}.`,
      });
    }

    if (webhook.agentActivity?.signal === "stop") {
      yield* stopThreadForSession(targetSession.threadId);
      return;
    }

    const thread = yield* findThreadContext(targetSession.threadId);
    const createdAt = new Date().toISOString();
    yield* dispatchCommand({
      type: "thread.turn.start",
      commandId: makeServerCommandId("linear-prompt-turn-start"),
      threadId: thread.id,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: promptFromPromptedWebhook(webhook),
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      titleSeed: webhook.agentSession.issue.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
    });
  });

  const handleUnassigned = Effect.fn("handleUnassigned")(function* (
    webhook: LinearIssueUnassignedWebhookPayload,
  ) {
    const sessions = yield* sessionRegistry.listByIssueId(webhook.notification.issueId);
    const uniqueThreadIds = [...new Set(sessions.map((entry) => entry.threadId))];
    for (const threadId of uniqueThreadIds) {
      yield* stopThreadForSession(threadId);
    }
    yield* sessionRegistry.removeByIssueId(webhook.notification.issueId);
  });

  const verify = Effect.fn("verifyLinearWebhook")(function* (input: {
    readonly rawBody: Uint8Array;
    readonly signature?: string | undefined;
    readonly timestamp?: string | undefined;
    readonly authorization?: string | undefined;
  }) {
    const settings = yield* serverSettings.getSettings;
    const secret = settings.linear.webhookSecret.trim();
    if (!secret) {
      return yield* new LinearWebhookVerificationError({
        detail: "Linear webhook secret is not configured.",
      });
    }

    if (settings.linear.verificationMode === "proxy") {
      const expected = `Bearer ${secret}`;
      if ((input.authorization ?? "").trim() !== expected) {
        return yield* new LinearWebhookVerificationError({
          detail: "Linear proxy authorization did not match the configured bearer token.",
        });
      }
      return;
    }

    if (!input.signature?.trim()) {
      return yield* new LinearWebhookVerificationError({
        detail: "Linear webhook signature header is missing.",
      });
    }

    const webhookClient = new LinearWebhookClient(secret);
    const verified = webhookClient.verify(
      Buffer.from(input.rawBody),
      input.signature,
      input.timestamp,
    );
    if (!verified) {
      return yield* new LinearWebhookVerificationError({
        detail: "Linear webhook signature verification failed.",
      });
    }
  });

  const handleWebhook: LinearWebhookHandlerShape["handleWebhook"] = (input) =>
    Effect.gen(function* () {
      yield* verify(input);

      const raw = new TextDecoder().decode(input.rawBody);
      const payload = yield* Effect.try({
        try: () => JSON.parse(raw) as Record<string, unknown>,
        catch: (cause) =>
          new LinearWebhookHandlerError({
            detail: "Failed to parse Linear webhook JSON payload.",
            cause,
          }),
      });

      const type = typeof payload.type === "string" ? payload.type : "";
      const action = typeof payload.action === "string" ? payload.action : "";

      if (type === "AgentSessionEvent" && action === "created") {
        const webhook = yield* Schema.decodeUnknownEffect(LinearAgentSessionCreatedWebhook)(
          payload,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new LinearWebhookHandlerError({
                detail: "Linear created webhook payload did not match the expected schema.",
                cause,
              }),
          ),
        );
        yield* handleCreated(webhook);
        return;
      }

      if (type === "AgentSessionEvent" && action === "prompted") {
        const webhook = yield* Schema.decodeUnknownEffect(LinearAgentSessionPromptedWebhook)(
          payload,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new LinearWebhookHandlerError({
                detail: "Linear prompted webhook payload did not match the expected schema.",
                cause,
              }),
          ),
        );
        yield* handlePrompted(webhook);
        return;
      }

      if (type === "AppUserNotification" && action === "issueUnassignedFromYou") {
        const webhook = yield* Schema.decodeUnknownEffect(LinearIssueUnassignedWebhook)(
          payload,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new LinearWebhookHandlerError({
                detail: "Linear unassigned webhook payload did not match the expected schema.",
                cause,
              }),
          ),
        );
        yield* handleUnassigned(webhook);
        return;
      }

      // Other Linear webhook types are intentionally ignored so users can point a broader app at this endpoint safely.
      yield* Effect.logDebug("ignoring unsupported Linear webhook", {
        type,
        action,
      });
    }).pipe(
      Effect.mapError((cause) => {
        if (
          Schema.is(LinearWebhookVerificationError)(cause) ||
          Schema.is(LinearWebhookHandlerError)(cause)
        ) {
          return cause;
        }
        return new LinearWebhookHandlerError({
          detail: "Failed to process Linear webhook.",
          cause,
        });
      }),
    );

  return {
    handleWebhook,
  } satisfies LinearWebhookHandlerShape;
});

export const LinearWebhookHandlerLive = Layer.effect(
  LinearWebhookHandler,
  makeLinearWebhookHandler,
);
