import { basename as nodeBasename } from "node:path";

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  LinearAgentSessionCreatedWebhook,
  type LinearAgentSessionCreatedWebhook as LinearAgentSessionCreatedWebhookPayload,
  LinearAgentSessionPromptedWebhook,
  type LinearAgentSessionPromptedWebhook as LinearAgentSessionPromptedWebhookPayload,
  LinearIssueStateChangeWebhook,
  type LinearIssueStateChangeWebhook as LinearIssueStateChangeWebhookPayload,
  LinearIssueUnassignedWebhook,
  type LinearIssueUnassignedWebhook as LinearIssueUnassignedWebhookPayload,
  type LinearSessionRow,
  LinearWebhookHandlerError,
  LinearWebhookVerificationError,
  MessageId,
  type OrchestrationReadModel,
  OrchestrationDispatchCommandError,
  type PromptType,
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
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ToolPolicyResolver } from "../../provider/Services/ToolPolicyResolver.ts";
import { LinearClient, type LinearIssueDetails } from "../Services/LinearClient.ts";
import {
  LinearPromptAssembler,
  type LinearPromptAssemblerCommentContext,
} from "../Services/LinearPromptAssembler.ts";
import {
  LinearSessionRegistry,
  type LinearSessionRegistryError,
} from "../Services/LinearSessionRegistry.ts";
import { ThreadRelationshipRegistry } from "../../mcp/Services/ThreadRelationshipRegistry.ts";
import {
  LinearWebhookHandler,
  type LinearWebhookHandlerShape,
} from "../Services/LinearWebhookHandler.ts";

const DEFAULT_LINEAR_MODEL_SELECTION = {
  provider: "codex" as const,
  model: "gpt-5-codex",
};

const LINEAR_AGENT_SESSION_MARKER = "This thread is for an agent session";
const LINEAR_STOP_REQUEST = /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i;

const makeServerCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

type ActiveThreadContext = OrchestrationReadModel["threads"][number];

interface RepoDirective {
  readonly routeKey: string;
  readonly branch?: string;
}

function normalizeToken(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeTokenSet(values: ReadonlyArray<string>): Set<string> {
  return new Set(
    values.map((value) => normalizeToken(value)).filter((value): value is string => !!value),
  );
}

function defaultRouteKey(mapping: LinearProjectMapping): string {
  return mapping.routeKey?.trim() || nodeBasename(mapping.workspaceRoot) || mapping.workspaceRoot;
}

function parseRepoDirective(description: string | undefined): RepoDirective | null {
  if (!description?.trim()) {
    return null;
  }

  const match = /\[repo=([^\]#\s]+)(?:#([^\]]+))?\]/i.exec(description);
  if (!match) {
    return null;
  }

  const routeKey = match[1]?.trim();
  if (!routeKey) {
    return null;
  }

  const branch = match[2]?.trim();
  return {
    routeKey,
    ...(branch ? { branch } : {}),
  };
}

function mappingMatchesRouteKey(mapping: LinearProjectMapping, routeKey: string): boolean {
  const normalizedRouteKey = normalizeToken(routeKey);
  if (!normalizedRouteKey) {
    return false;
  }

  const routeTokens = [defaultRouteKey(mapping), ...(mapping.routeAliases ?? [])]
    .map((value) => normalizeToken(value))
    .filter((value): value is string => !!value);

  return routeTokens.includes(normalizedRouteKey);
}

function mappingMatchesOrganization(
  mapping: LinearProjectMapping,
  organizationId: string,
): boolean {
  const expected = normalizeToken(mapping.organizationId);
  if (!expected) {
    return true;
  }
  return expected === normalizeToken(organizationId);
}

const resolveMapping = (input: {
  readonly organizationId: string;
  readonly issueTeamKey: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly issueDescription?: string;
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
  readonly defaultWorkspaceRoot: string;
}): LinearProjectMapping | null => {
  const normalizedTeamKey = normalizeToken(input.issueTeamKey);
  const normalizedLabels = normalizeTokenSet(input.labelNames);
  const normalizedProjectKeys = normalizeTokenSet(input.projectKeys);
  const scopedMappings = input.mappings.filter((mapping) =>
    mappingMatchesOrganization(mapping, input.organizationId),
  );

  const repoDirective = parseRepoDirective(input.issueDescription);
  if (repoDirective) {
    const routeMatch =
      scopedMappings.find((mapping) => mappingMatchesRouteKey(mapping, repoDirective.routeKey)) ??
      null;
    if (routeMatch) {
      return routeMatch;
    }
  }

  const routingLabelMatch =
    scopedMappings.find((mapping) => {
      const routingLabels = [
        ...(mapping.routingLabels ?? []),
        ...(mapping.labelName ? [mapping.labelName] : []),
      ]
        .map((label) => normalizeToken(label))
        .filter((label): label is string => !!label);
      if (
        routingLabels.length === 0 ||
        !routingLabels.some((label) => normalizedLabels.has(label))
      ) {
        return false;
      }
      const mappingTeamKey = normalizeToken(mapping.teamKey);
      return mappingTeamKey ? mappingTeamKey === normalizedTeamKey : true;
    }) ?? null;
  if (routingLabelMatch) {
    return routingLabelMatch;
  }

  const projectKeyMatch =
    scopedMappings.find((mapping) => {
      const mappingProjectKeys = (mapping.projectKeys ?? [])
        .map((projectKey) => normalizeToken(projectKey))
        .filter((projectKey): projectKey is string => !!projectKey);
      if (
        mappingProjectKeys.length === 0 ||
        !mappingProjectKeys.some((projectKey) => normalizedProjectKeys.has(projectKey))
      ) {
        return false;
      }
      const mappingTeamKey = normalizeToken(mapping.teamKey);
      return mappingTeamKey ? mappingTeamKey === normalizedTeamKey : true;
    }) ?? null;
  if (projectKeyMatch) {
    return projectKeyMatch;
  }

  const teamMatch =
    scopedMappings.find((mapping) => {
      const mappingTeamKey = normalizeToken(mapping.teamKey);
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

function collectRoutingMatches(input: {
  readonly organizationId: string;
  readonly issueTeamKey: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly issueDescription?: string;
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
}): ReadonlyArray<{
  readonly tier: "repo-directive" | "routing-label" | "project-key" | "team-key";
  readonly matches: ReadonlyArray<LinearProjectMapping>;
}> {
  const normalizedTeamKey = normalizeToken(input.issueTeamKey);
  const normalizedLabels = normalizeTokenSet(input.labelNames);
  const normalizedProjectKeys = normalizeTokenSet(input.projectKeys);
  const scopedMappings = input.mappings.filter((mapping) =>
    mappingMatchesOrganization(mapping, input.organizationId),
  );

  const repoDirective = parseRepoDirective(input.issueDescription);
  const repoDirectiveMatches = repoDirective
    ? scopedMappings.filter((mapping) => mappingMatchesRouteKey(mapping, repoDirective.routeKey))
    : [];
  const routingLabelMatches = scopedMappings.filter((mapping) => {
    const routingLabels = [
      ...(mapping.routingLabels ?? []),
      ...(mapping.labelName ? [mapping.labelName] : []),
    ]
      .map((label) => normalizeToken(label))
      .filter((label): label is string => !!label);
    if (routingLabels.length === 0 || !routingLabels.some((label) => normalizedLabels.has(label))) {
      return false;
    }
    const mappingTeamKey = normalizeToken(mapping.teamKey);
    return mappingTeamKey ? mappingTeamKey === normalizedTeamKey : true;
  });
  const projectKeyMatches = scopedMappings.filter((mapping) => {
    const mappingProjectKeys = (mapping.projectKeys ?? [])
      .map((projectKey) => normalizeToken(projectKey))
      .filter((projectKey): projectKey is string => !!projectKey);
    if (
      mappingProjectKeys.length === 0 ||
      !mappingProjectKeys.some((projectKey) => normalizedProjectKeys.has(projectKey))
    ) {
      return false;
    }
    const mappingTeamKey = normalizeToken(mapping.teamKey);
    return mappingTeamKey ? mappingTeamKey === normalizedTeamKey : true;
  });
  const teamMatches = scopedMappings.filter((mapping) => {
    const mappingTeamKey = normalizeToken(mapping.teamKey);
    return mappingTeamKey === normalizedTeamKey && !mapping.labelName;
  });

  return [
    {
      tier: "repo-directive",
      matches: repoDirectiveMatches,
    },
    {
      tier: "routing-label",
      matches: routingLabelMatches,
    },
    {
      tier: "project-key",
      matches: projectKeyMatches,
    },
    {
      tier: "team-key",
      matches: teamMatches,
    },
  ];
}

function resolvePromptType(input: {
  readonly labelNames: ReadonlyArray<string>;
  readonly mapping: LinearProjectMapping;
}): PromptType {
  return collectPromptTypeMatches(input).at(0) ?? "builder";
}

function collectPromptTypeMatches(input: {
  readonly labelNames: ReadonlyArray<string>;
  readonly mapping: LinearProjectMapping;
}): ReadonlyArray<PromptType> {
  const normalizedLabels = normalizeTokenSet(input.labelNames);
  const configuredLabels = input.mapping.promptLabels;
  const hasConfiguredLabel = (labels: ReadonlyArray<string> | undefined): boolean =>
    (labels ?? [])
      .map((label) => normalizeToken(label))
      .filter((label): label is string => !!label)
      .some((label) => normalizedLabels.has(label));

  const matches: PromptType[] = [];
  const hasOrchestrator =
    normalizedLabels.has("orchestrator") || hasConfiguredLabel(configuredLabels?.orchestrator);
  const hasGraphite =
    normalizedLabels.has("graphite") ||
    normalizedLabels.has("graphite-orchestrator") ||
    hasConfiguredLabel(configuredLabels?.graphite);

  if (hasGraphite && hasOrchestrator) {
    matches.push("graphite-orchestrator");
  }
  if (normalizedLabels.has("scoper") || hasConfiguredLabel(configuredLabels?.scoper)) {
    matches.push("scoper");
  }
  if (hasOrchestrator) {
    matches.push("orchestrator");
  }
  if (
    normalizedLabels.has("bug") ||
    normalizedLabels.has("debugger") ||
    hasConfiguredLabel(configuredLabels?.debugger)
  ) {
    matches.push("debugger");
  }
  if (hasConfiguredLabel(configuredLabels?.builder)) {
    matches.push("builder");
  }

  return matches;
}

function buildRepositoryRoutingContext(input: {
  readonly currentProjectId: ProjectId;
  readonly projects: OrchestrationReadModel["projects"];
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
}): string {
  const segments = input.projects
    .filter((project) => project.deletedAt === null)
    .map((project) => {
      const mapping =
        input.mappings.find((entry) => entry.workspaceRoot === project.workspaceRoot) ?? null;
      const routeKey = mapping ? defaultRouteKey(mapping) : nodeBasename(project.workspaceRoot);
      const routeAliases = mapping?.routeAliases ?? [];
      const routingLabels = mapping?.routingLabels ?? [];
      const teamKeys = mapping?.teamKey ? [mapping.teamKey] : [];
      const projectKeys = mapping?.projectKeys ?? [];
      const baseBranch = mapping?.baseBranch?.trim() || "main";

      const lines = [
        `<repository>`,
        `  <project_title>${project.title}</project_title>`,
        `  <workspace_root>${project.workspaceRoot}</workspace_root>`,
        `  <route_key>${routeKey}</route_key>`,
        `  <repo_directives>[repo=${routeKey}]${routeAliases
          .map((alias) => `, [repo=${alias}]`)
          .join("")}</repo_directives>`,
        `  <routing_labels>${routingLabels.join(", ") || "none"}</routing_labels>`,
        `  <team_keys>${teamKeys.join(", ") || "none"}</team_keys>`,
        `  <project_keys>${projectKeys.join(", ") || "none"}</project_keys>`,
        `  <base_branch>${baseBranch}</base_branch>`,
        `  <current>${project.id === input.currentProjectId ? "true" : "false"}</current>`,
        `</repository>`,
      ];

      return lines.join("\n");
    });

  return segments.join("\n");
}

function resolveBaseBranch(input: {
  readonly issue: LinearIssueDetails;
  readonly mapping: LinearProjectMapping;
  readonly blockedByBranch?: string | null;
  readonly parentBranch?: string | null;
}): string {
  const repoDirective = parseRepoDirective(input.issue.description);
  if (repoDirective?.branch) {
    return repoDirective.branch;
  }
  if (input.blockedByBranch?.trim()) {
    return input.blockedByBranch.trim();
  }
  if (input.parentBranch?.trim()) {
    return input.parentBranch.trim();
  }
  return input.mapping.baseBranch?.trim() || "main";
}

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

const newCommentFromCreatedWebhook = (
  webhook: LinearAgentSessionCreatedWebhookPayload,
): LinearPromptAssemblerCommentContext | undefined => {
  const commentBody = webhook.agentSession.comment?.body?.trim() ?? "";
  if (!commentBody || commentBody.includes(LINEAR_AGENT_SESSION_MARKER)) {
    return undefined;
  }
  const creator = webhook.agentSession.creator;
  return {
    body: commentBody,
    author: creator?.name?.trim() || creator?.displayName?.trim() || creator?.id || "Unknown",
    timestamp: webhook.createdAt,
  };
};

const continuationCommentFromPromptedWebhook = (
  webhook: LinearAgentSessionPromptedWebhookPayload,
): LinearPromptAssemblerCommentContext => {
  const creator = webhook.agentSession.creator;
  return {
    body: promptFromPromptedWebhook(webhook),
    author: creator?.name?.trim() || creator?.displayName?.trim() || creator?.id || "Unknown",
    timestamp: webhook.createdAt,
  };
};

const stopTextFromPromptedWebhook = (webhook: LinearAgentSessionPromptedWebhookPayload) =>
  webhook.agentActivity?.content?.body?.trim() ?? webhook.agentSession.comment?.body?.trim() ?? "";

const dedupeSessions = (sessions: ReadonlyArray<LinearSessionRow>) => [
  ...new Map(sessions.map((session) => [session.linearSessionId, session])).values(),
];

const isTerminalWorkflowState = (input: { readonly name: string; readonly type?: string }) => {
  const normalizedType = input.type?.trim().toLowerCase();
  if (normalizedType === "completed" || normalizedType === "canceled") {
    return true;
  }

  const normalizedName = input.name.trim().toLowerCase();
  return (
    normalizedName === "done" || normalizedName === "canceled" || normalizedName === "cancelled"
  );
};

const makeLinearWebhookHandler = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const startup = yield* ServerRuntimeStartup;
  const bootstrapTurnService = yield* BootstrapTurnService;
  const sessionRegistry = yield* LinearSessionRegistry;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const linearClient = yield* LinearClient;
  const promptAssembler = yield* LinearPromptAssembler;
  const path = yield* Path.Path;
  const threadRelationshipRegistry = yield* ThreadRelationshipRegistry;
  const toolPolicyResolver = yield* ToolPolicyResolver;

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

  const lookupThreadContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ActiveThreadContext>, ProjectionRepositoryError, never> =
    Effect.fn("lookupThreadContext")(function* (threadId: ThreadId) {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const thread =
        snapshot.threads.find(
          (entry) => entry.id === threadId && entry.archivedAt === null && entry.deletedAt === null,
        ) ?? null;
      return thread === null ? Option.none<ActiveThreadContext>() : Option.some(thread);
    });

  const appendPromptModeActivity = Effect.fn("appendPromptModeActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly promptType: PromptType;
    readonly createdAt: string;
  }) {
    if (input.promptType === "builder") {
      return;
    }

    // Surface prompt-mode switches as first-class activity so Linear mirrors Cyrus mode-entry UX.
    yield* dispatchCommand({
      type: "thread.activity.append",
      commandId: makeServerCommandId("linear-prompt-mode"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "prompt-mode.entered",
        summary: `Entering '${input.promptType}' mode`,
        payload: {
          promptType: input.promptType,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveToolPolicy = Effect.fn("resolveToolPolicy")(function* (input: {
    readonly promptType: PromptType;
    readonly mappings: ReadonlyArray<LinearProjectMapping>;
  }) {
    // Keep routing, prompt selection, and tool policy bound to the same mapping context.
    return yield* toolPolicyResolver.resolve(input);
  });

  const resolveMappingWithDiagnostics = Effect.fn("resolveMappingWithDiagnostics")(
    function* (input: {
      readonly organizationId: string;
      readonly issueTeamKey: string;
      readonly labelNames: ReadonlyArray<string>;
      readonly projectKeys: ReadonlyArray<string>;
      readonly issueDescription?: string;
      readonly mappings: ReadonlyArray<LinearProjectMapping>;
      readonly defaultWorkspaceRoot: string;
      readonly issueIdentifier: string;
    }) {
      const routingMatches = collectRoutingMatches(input);
      const winningTier = routingMatches.find((entry) => entry.matches.length > 0);
      if (winningTier && winningTier.matches.length > 1) {
        yield* Effect.logWarning(
          "linear routing matched multiple project mappings; first match wins",
          {
            issueIdentifier: input.issueIdentifier,
            tier: winningTier.tier,
            workspaceRoots: winningTier.matches.map((mapping) => mapping.workspaceRoot),
          },
        );
      }

      return resolveMapping(input);
    },
  );

  const resolvePromptTypeWithDiagnostics = Effect.fn("resolvePromptTypeWithDiagnostics")(
    function* (input: {
      readonly issueIdentifier: string;
      readonly labelNames: ReadonlyArray<string>;
      readonly mapping: LinearProjectMapping;
    }) {
      const matches = collectPromptTypeMatches(input);
      if (matches.length > 1) {
        yield* Effect.logWarning(
          "linear prompt labels matched multiple prompt types; first match wins",
          {
            issueIdentifier: input.issueIdentifier,
            workspaceRoot: input.mapping.workspaceRoot,
            matches,
          },
        );
      }

      return resolvePromptType(input);
    },
  );

  const findLatestLiveSessionContext: (
    sessions: ReadonlyArray<LinearSessionRow>,
  ) => Effect.Effect<
    { readonly session: LinearSessionRow; readonly thread: ActiveThreadContext } | null,
    ProjectionRepositoryError | LinearSessionRegistryError,
    never
  > = Effect.fn("findLatestLiveSessionContext")(function* (
    sessions: ReadonlyArray<LinearSessionRow>,
  ) {
    const sortedSessions = sessions.toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );

    for (const session of sortedSessions) {
      const thread = yield* lookupThreadContext(session.threadId);
      if (Option.isSome(thread)) {
        return {
          session,
          thread: thread.value,
        };
      }

      // Prune dead mappings eagerly so the next webhook can recover automatically.
      yield* sessionRegistry.remove(session.linearSessionId);
    }

    return null;
  });

  const findBlockedByBranch = Effect.fn("findBlockedByBranch")(function* (
    issue: LinearIssueDetails,
  ) {
    for (const blockedByIssueId of issue.blockedByIssueIds) {
      const sessions = yield* sessionRegistry.listByIssueId(blockedByIssueId);
      const blockedBySession = yield* findLatestLiveSessionContext(sessions);
      const branch = blockedBySession?.thread.branch?.trim();
      if (branch) {
        return branch;
      }
    }
    return null;
  });

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
    const issueComments = yield* linearClient.fetchIssueComments(fetchedIssue.id);
    const issueSessions = yield* sessionRegistry.listByIssueId(fetchedIssue.id);
    const existingSessionContext = yield* findLatestLiveSessionContext(issueSessions);
    const parentRelationship = yield* threadRelationshipRegistry.findParentByLinearSession(
      webhook.agentSession.id,
    );
    const parentThreadContext = Option.isSome(parentRelationship)
      ? yield* lookupThreadContext(parentRelationship.value.parentThreadId)
      : Option.none<ActiveThreadContext>();

    if (existingSessionContext) {
      const settings = yield* serverSettings.getSettings;
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const existingProject =
        snapshot.projects.find((entry) => entry.id === existingSessionContext.session.projectId) ??
        null;
      const existingMapping = settings.linearProjectMappings.mappings.find(
        (entry) => entry.workspaceRoot === existingProject?.workspaceRoot,
      ) ?? {
        workspaceRoot:
          existingProject?.workspaceRoot ??
          path.dirname(existingSessionContext.thread.worktreePath ?? process.cwd()),
      };
      const promptType = yield* resolvePromptTypeWithDiagnostics({
        issueIdentifier: fetchedIssue.identifier,
        labelNames: fetchedIssue.labelNames,
        mapping: existingMapping,
      });
      const repositoryRoutingContext =
        promptType === "orchestrator" || promptType === "graphite-orchestrator"
          ? buildRepositoryRoutingContext({
              currentProjectId: existingSessionContext.session.projectId,
              projects: snapshot.projects,
              mappings: settings.linearProjectMappings.mappings,
            })
          : undefined;
      const existingWorktreePath =
        existingSessionContext.thread.worktreePath ??
        path.join("/tmp", existingSessionContext.thread.id);
      const newComment = newCommentFromCreatedWebhook(webhook);
      const promptAssembly = yield* promptAssembler.assembleNewSessionPrompt({
        issue: fetchedIssue,
        comments: issueComments,
        workspaceRoot: path.dirname(existingWorktreePath),
        worktreePath: existingWorktreePath,
        baseBranch: existingSessionContext.thread.branch ?? "main",
        promptType,
        ...(repositoryRoutingContext ? { repositoryRoutingContext } : {}),
        ...(newComment ? { newComment } : {}),
        ...(webhook.guidance ? { guidance: webhook.guidance } : {}),
      });
      const toolPolicy = yield* resolveToolPolicy({
        promptType: promptAssembly.promptType,
        mappings: [existingMapping],
      });
      const createdAt = new Date().toISOString();
      yield* dispatchCommand({
        type: "thread.turn.start",
        commandId: makeServerCommandId("linear-turn-start"),
        threadId: existingSessionContext.thread.id,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: promptAssembly.prompt,
          attachments: [],
        },
        modelSelection: existingSessionContext.thread.modelSelection,
        titleSeed: fetchedIssue.title,
        runtimeMode: existingSessionContext.thread.runtimeMode,
        interactionMode: existingSessionContext.thread.interactionMode,
        promptType: promptAssembly.promptType,
        ...(promptAssembly.systemPromptPrefix
          ? { systemPromptPrefix: promptAssembly.systemPromptPrefix }
          : {}),
        ...(toolPolicy.allowedTools !== undefined
          ? { allowedTools: [...toolPolicy.allowedTools] }
          : {}),
        ...(toolPolicy.disallowedTools !== undefined
          ? { disallowedTools: [...toolPolicy.disallowedTools] }
          : {}),
        createdAt,
      });
      yield* sessionRegistry.register({
        linearSessionId: webhook.agentSession.id,
        threadId: existingSessionContext.session.threadId,
        projectId: existingSessionContext.session.projectId,
        issueId: fetchedIssue.id,
        issueIdentifier: fetchedIssue.identifier,
        createdAt,
      });
      if (Option.isSome(parentRelationship)) {
        yield* threadRelationshipRegistry.attachChildThread({
          childLinearSessionId: webhook.agentSession.id,
          childThreadId: existingSessionContext.thread.id,
          childIssueIdentifier: fetchedIssue.identifier,
          childWorktreePath: existingSessionContext.thread.worktreePath,
          attachedAt: createdAt,
        });
      }
      yield* appendPromptModeActivity({
        threadId: existingSessionContext.thread.id,
        promptType: promptAssembly.promptType,
        createdAt,
      });
      return;
    }

    const settings = yield* serverSettings.getSettings;
    const mapping = yield* resolveMappingWithDiagnostics({
      organizationId: webhook.organizationId,
      issueTeamKey: fetchedIssue.teamKey,
      labelNames: fetchedIssue.labelNames,
      projectKeys: fetchedIssue.projectKeys,
      issueDescription: fetchedIssue.description,
      mappings: settings.linearProjectMappings.mappings,
      defaultWorkspaceRoot: settings.linearProjectMappings.defaultWorkspaceRoot,
      issueIdentifier: fetchedIssue.identifier,
    });

    if (!mapping) {
      return yield* new LinearWebhookHandlerError({
        detail: `No Linear project mapping matched ${fetchedIssue.identifier}.`,
      });
    }

    const project = yield* ensureProjectForWorkspaceRoot(mapping.workspaceRoot);
    const promptType = yield* resolvePromptTypeWithDiagnostics({
      issueIdentifier: fetchedIssue.identifier,
      labelNames: fetchedIssue.labelNames,
      mapping,
    });
    const blockedByBranch =
      promptType === "graphite-orchestrator" ? yield* findBlockedByBranch(fetchedIssue) : null;
    const baseBranch = resolveBaseBranch({
      issue: fetchedIssue,
      mapping,
      blockedByBranch,
      parentBranch:
        Option.isSome(parentThreadContext) && parentThreadContext.value.projectId === project.id
          ? parentThreadContext.value.branch
          : null,
    });
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const repositoryRoutingContext =
      promptType === "orchestrator" || promptType === "graphite-orchestrator"
        ? buildRepositoryRoutingContext({
            currentProjectId: project.id,
            projects: snapshot.projects,
            mappings: settings.linearProjectMappings.mappings,
          })
        : undefined;
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
    const branchName = sanitizeFeatureBranchName(
      `${fetchedIssue.identifier} ${fetchedIssue.title}`,
    );
    const worktreePath = path.join(mapping.workspaceRoot, branchName);
    const newComment = newCommentFromCreatedWebhook(webhook);
    const promptAssembly = yield* promptAssembler.assembleNewSessionPrompt({
      issue: fetchedIssue,
      comments: issueComments,
      workspaceRoot: mapping.workspaceRoot,
      worktreePath,
      baseBranch,
      promptType,
      ...(repositoryRoutingContext ? { repositoryRoutingContext } : {}),
      ...(newComment ? { newComment } : {}),
      ...(webhook.guidance ? { guidance: webhook.guidance } : {}),
    });
    const toolPolicy = yield* resolveToolPolicy({
      promptType: promptAssembly.promptType,
      mappings: [mapping],
    });

    yield* dispatchCommand({
      type: "thread.turn.start",
      commandId: makeServerCommandId("linear-bootstrap-turn-start"),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: promptAssembly.prompt,
        attachments: [],
      },
      modelSelection: project.defaultModelSelection,
      titleSeed: fetchedIssue.title,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      promptType: promptAssembly.promptType,
      ...(promptAssembly.systemPromptPrefix
        ? { systemPromptPrefix: promptAssembly.systemPromptPrefix }
        : {}),
      ...(toolPolicy.allowedTools !== undefined
        ? { allowedTools: [...toolPolicy.allowedTools] }
        : {}),
      ...(toolPolicy.disallowedTools !== undefined
        ? { disallowedTools: [...toolPolicy.disallowedTools] }
        : {}),
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
          baseBranch,
          branch: branchName,
          writeLinearMcpConfig: true,
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
    if (Option.isSome(parentRelationship)) {
      yield* threadRelationshipRegistry.attachChildThread({
        childLinearSessionId: webhook.agentSession.id,
        childThreadId: threadId,
        childIssueIdentifier: fetchedIssue.identifier,
        childWorktreePath: worktreePath,
        attachedAt: createdAt,
      });
    }
    yield* appendPromptModeActivity({
      threadId,
      promptType: promptAssembly.promptType,
      createdAt,
    });
  });

  const handlePrompted = Effect.fn("handlePrompted")(function* (
    webhook: LinearAgentSessionPromptedWebhookPayload,
  ) {
    const issueId = webhook.agentSession.issueId ?? webhook.agentSession.issue.id;
    const sessionLookup = yield* sessionRegistry.lookupBySessionId(webhook.agentSession.id);
    const fallbackSessions = yield* sessionRegistry.listByIssueId(issueId);
    const sessionCandidates = dedupeSessions(
      Option.match(sessionLookup, {
        onNone: () => fallbackSessions,
        onSome: (session) => [session, ...fallbackSessions],
      }),
    );
    const targetSession = yield* findLatestLiveSessionContext(sessionCandidates);

    if (!targetSession) {
      return yield* new LinearWebhookHandlerError({
        detail: `No active Linear session mapping found for prompted issue ${issueId}.`,
      });
    }

    if (
      webhook.agentActivity?.signal === "stop" ||
      LINEAR_STOP_REQUEST.test(stopTextFromPromptedWebhook(webhook))
    ) {
      yield* stopThreadForSession(targetSession.thread.id);
      return;
    }

    const fetchedIssue = yield* linearClient.fetchIssue(issueId);
    const settings = yield* serverSettings.getSettings;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const project =
      snapshot.projects.find((entry) => entry.id === targetSession.thread.projectId) ?? null;
    const mapping = settings.linearProjectMappings.mappings.find(
      (entry) => entry.workspaceRoot === project?.workspaceRoot,
    ) ?? {
      workspaceRoot: project?.workspaceRoot ?? process.cwd(),
    };
    const promptType = yield* resolvePromptTypeWithDiagnostics({
      issueIdentifier: fetchedIssue.identifier,
      labelNames: fetchedIssue.labelNames,
      mapping,
    });
    const promptAssembly = yield* promptAssembler.assembleContinuationPrompt({
      comment: continuationCommentFromPromptedWebhook(webhook),
      promptType,
    });
    const toolPolicy = yield* resolveToolPolicy({
      promptType: promptAssembly.promptType,
      mappings: [mapping],
    });
    const createdAt = new Date().toISOString();
    yield* dispatchCommand({
      type: "thread.turn.start",
      commandId: makeServerCommandId("linear-prompt-turn-start"),
      threadId: targetSession.thread.id,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: promptAssembly.prompt,
        attachments: [],
      },
      modelSelection: targetSession.thread.modelSelection,
      titleSeed: fetchedIssue.title,
      runtimeMode: targetSession.thread.runtimeMode,
      interactionMode: targetSession.thread.interactionMode,
      promptType: promptAssembly.promptType,
      ...(promptAssembly.systemPromptPrefix
        ? { systemPromptPrefix: promptAssembly.systemPromptPrefix }
        : {}),
      ...(toolPolicy.allowedTools !== undefined
        ? { allowedTools: [...toolPolicy.allowedTools] }
        : {}),
      ...(toolPolicy.disallowedTools !== undefined
        ? { disallowedTools: [...toolPolicy.disallowedTools] }
        : {}),
      createdAt,
    });
  });

  const handleIssueUpdate = Effect.fn("handleIssueUpdate")(function* (
    webhook: LinearIssueStateChangeWebhookPayload,
  ) {
    const updatedFrom = webhook.updatedFrom;
    if (!updatedFrom) {
      return;
    }

    if (updatedFrom.stateId !== undefined) {
      const nextState = yield* linearClient.fetchIssueState(webhook.data.id);
      if (isTerminalWorkflowState(nextState)) {
        const sessions = yield* sessionRegistry.listByIssueId(webhook.data.id);
        const uniqueThreadIds = [...new Set(sessions.map((entry) => entry.threadId))];
        for (const threadId of uniqueThreadIds) {
          yield* stopThreadForSession(threadId);
        }
        yield* sessionRegistry.removeByIssueId(webhook.data.id);
        return;
      }
    }

    if (updatedFrom.description === undefined && updatedFrom.title === undefined) {
      return;
    }

    const sessions = yield* sessionRegistry.listByIssueId(webhook.data.id);
    const targetSession = yield* findLatestLiveSessionContext(sessions);
    if (!targetSession) {
      return;
    }

    const fetchedIssue = yield* linearClient.fetchIssue(webhook.data.id);
    const settings = yield* serverSettings.getSettings;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const project =
      snapshot.projects.find((entry) => entry.id === targetSession.thread.projectId) ?? null;
    const mapping = settings.linearProjectMappings.mappings.find(
      (entry) => entry.workspaceRoot === project?.workspaceRoot,
    ) ?? {
      workspaceRoot: project?.workspaceRoot ?? process.cwd(),
    };
    const promptType = yield* resolvePromptTypeWithDiagnostics({
      issueIdentifier: fetchedIssue.identifier,
      labelNames: fetchedIssue.labelNames,
      mapping,
    });
    const promptAssembly = yield* promptAssembler.assembleIssueUpdatePrompt({
      issue: fetchedIssue,
      promptType,
      ...(updatedFrom.title !== undefined ? { previousTitle: updatedFrom.title } : {}),
      ...(updatedFrom.description !== undefined
        ? { previousDescription: updatedFrom.description }
        : {}),
    });
    const toolPolicy = yield* resolveToolPolicy({
      promptType: promptAssembly.promptType,
      mappings: [mapping],
    });
    const createdAt = new Date().toISOString();

    yield* dispatchCommand({
      type: "thread.turn.start",
      commandId: makeServerCommandId("linear-issue-update-turn-start"),
      threadId: targetSession.thread.id,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: promptAssembly.prompt,
        attachments: [],
      },
      modelSelection: targetSession.thread.modelSelection,
      titleSeed: fetchedIssue.title,
      runtimeMode: targetSession.thread.runtimeMode,
      interactionMode: targetSession.thread.interactionMode,
      promptType: promptAssembly.promptType,
      ...(promptAssembly.systemPromptPrefix
        ? { systemPromptPrefix: promptAssembly.systemPromptPrefix }
        : {}),
      ...(toolPolicy.allowedTools !== undefined
        ? { allowedTools: [...toolPolicy.allowedTools] }
        : {}),
      ...(toolPolicy.disallowedTools !== undefined
        ? { disallowedTools: [...toolPolicy.disallowedTools] }
        : {}),
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

      if (type === "Issue" && action === "update") {
        const webhook = yield* Schema.decodeUnknownEffect(LinearIssueStateChangeWebhook)(
          payload,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new LinearWebhookHandlerError({
                detail: "Linear issue update webhook payload did not match the expected schema.",
                cause,
              }),
          ),
        );
        yield* handleIssueUpdate(webhook);
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
