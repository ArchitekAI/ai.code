import { basename as nodeBasename } from "node:path";

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
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
  ProjectId,
  OrchestrationDispatchCommandError,
  type PromptType,
  type LinearProjectMapping,
  ThreadId,
} from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { Effect, Layer, Option, Path, Ref, Schema } from "effect";

import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BootstrapTurnService } from "../../orchestration/Services/BootstrapTurnService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ToolPolicyResolver } from "../../provider/Services/ToolPolicyResolver.ts";
import { ProjectOnboarding } from "../../project/Services/ProjectOnboarding.ts";
import {
  LinearClient,
  type LinearIssueComment,
  type LinearIssueDetails,
} from "../Services/LinearClient.ts";
import {
  LinearPromptAssembler,
  type LinearPromptAssemblerCommentContext,
  type LinearPromptAssemblerGuidanceRule,
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
import { downloadCommentAttachments, downloadIssueAttachments } from "./LinearAttachmentService.ts";
import { moveIssueToInProgress } from "./LinearIssueLifecycle.ts";
import {
  dedupeLinearSessions,
  findLatestLiveLinearSessionContext,
} from "./LinearSessionContext.ts";

const LINEAR_AGENT_SESSION_MARKER = "This thread is for an agent session";
const LINEAR_STOP_REQUEST = /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i;

const makeServerCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

type ActiveThreadContext = OrchestrationReadModel["threads"][number];

interface RepoDirective {
  readonly routeKey: string;
  readonly branch?: string;
}

interface PendingRepositorySelection {
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
  readonly guidance?: ReadonlyArray<LinearPromptAssemblerGuidanceRule>;
  readonly newComment?: LinearPromptAssemblerCommentContext;
}

type RepositoryRoutingResolution =
  | { readonly type: "resolved"; readonly mapping: LinearProjectMapping }
  | { readonly type: "selection"; readonly mappings: ReadonlyArray<LinearProjectMapping> }
  | { readonly type: "none" };

function normalizeToken(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredStringValue(
  record: Record<string, unknown>,
  key: string,
): Effect.Effect<string, LinearWebhookHandlerError> {
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new LinearWebhookHandlerError({
      detail: `Linear created webhook payload is missing ${key}.`,
    }),
  );
}

function decodeCreatedWebhookPayload(
  payload: Record<string, unknown>,
): Effect.Effect<LinearAgentSessionCreatedWebhookPayload, LinearWebhookHandlerError> {
  return Effect.gen(function* () {
    const type = yield* requiredStringValue(payload, "type");
    const action = yield* requiredStringValue(payload, "action");
    const createdAt = yield* requiredStringValue(payload, "createdAt");
    const organizationId = yield* requiredStringValue(payload, "organizationId");
    const agentSessionRecord = recordValue(payload.agentSession);

    if (!agentSessionRecord) {
      return yield* new LinearWebhookHandlerError({
        detail: "Linear created webhook payload is missing agentSession.",
      });
    }

    const issueRecord = recordValue(agentSessionRecord.issue);
    if (!issueRecord) {
      return yield* new LinearWebhookHandlerError({
        detail: "Linear created webhook payload is missing agentSession.issue.",
      });
    }

    const issueId = yield* requiredStringValue(issueRecord, "id");
    const agentSessionId = yield* requiredStringValue(agentSessionRecord, "id");
    const issueTeam = recordValue(issueRecord.team);
    const commentRecord = recordValue(agentSessionRecord.comment);
    const creatorRecord = recordValue(agentSessionRecord.creator);
    const guidance =
      Array.isArray(payload.guidance) && payload.guidance.length > 0
        ? payload.guidance.flatMap((entry) => {
            const guidanceRecord = recordValue(entry);
            if (!guidanceRecord) {
              return [];
            }
            const originRecord = recordValue(guidanceRecord.origin);
            const teamRecord = originRecord ? recordValue(originRecord.team) : null;
            return [
              {
                body: typeof guidanceRecord.body === "string" ? guidanceRecord.body : "",
                ...(originRecord
                  ? {
                      origin: {
                        ...(typeof originRecord.__typename === "string"
                          ? { __typename: originRecord.__typename }
                          : {}),
                        ...(teamRecord && typeof teamRecord.displayName === "string"
                          ? {
                              team: {
                                displayName: teamRecord.displayName,
                              },
                            }
                          : {}),
                      },
                    }
                  : {}),
              },
            ];
          })
        : undefined;

    return {
      type: type as "AgentSessionEvent",
      action: action as "created",
      createdAt,
      organizationId,
      agentSession: {
        id: agentSessionId,
        issue: {
          id: issueId,
          identifier: typeof issueRecord.identifier === "string" ? issueRecord.identifier : "",
          title: typeof issueRecord.title === "string" ? issueRecord.title : "",
          ...(typeof issueRecord.description === "string"
            ? { description: issueRecord.description }
            : {}),
          ...(issueTeam && typeof issueTeam.key === "string"
            ? { team: { key: issueTeam.key } }
            : {}),
        },
        ...(typeof agentSessionRecord.issueId === "string"
          ? { issueId: agentSessionRecord.issueId }
          : {}),
        ...(commentRecord
          ? {
              comment: {
                id: typeof commentRecord.id === "string" ? commentRecord.id : "",
                body: typeof commentRecord.body === "string" ? commentRecord.body : "",
              },
            }
          : {}),
        ...(creatorRecord && typeof creatorRecord.id === "string"
          ? {
              creator: {
                id: creatorRecord.id,
                ...(optionalStringValue(creatorRecord.name)
                  ? { name: optionalStringValue(creatorRecord.name) }
                  : {}),
                ...(optionalStringValue(creatorRecord.displayName)
                  ? { displayName: optionalStringValue(creatorRecord.displayName) }
                  : {}),
                ...(optionalStringValue(creatorRecord.email)
                  ? { email: optionalStringValue(creatorRecord.email) }
                  : {}),
              },
            }
          : {}),
      },
      ...(guidance ? { guidance } : {}),
    };
  });
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

  // Linear API writes escaped markdown brackets for some issue creation paths,
  // so we accept both `[repo=foo]` and `\[repo=foo\]` here.
  const match = /\\?\[repo=([^\]\\#\s]+)(?:#([^\]\\]+))?\\?\]/i.exec(description);
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

function buildSelectableMappings(input: {
  readonly organizationId: string;
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
  readonly defaultWorkspaceRoot: string;
}): ReadonlyArray<LinearProjectMapping> {
  const scopedMappings = input.mappings.filter((mapping) =>
    mappingMatchesOrganization(mapping, input.organizationId),
  );
  const normalizedWorkspaceRoots = new Set(
    scopedMappings
      .map((mapping) => mapping.workspaceRoot.trim())
      .filter((workspaceRoot) => workspaceRoot.length > 0),
  );
  const normalizedDefaultWorkspaceRoot = input.defaultWorkspaceRoot.trim();

  // Treat the default workspace as a first-class routing candidate so Linear
  // can elicit repository selection the same way Cyrus does.
  if (
    normalizedDefaultWorkspaceRoot.length > 0 &&
    !normalizedWorkspaceRoots.has(normalizedDefaultWorkspaceRoot)
  ) {
    return [
      ...scopedMappings,
      {
        workspaceRoot: normalizedDefaultWorkspaceRoot,
      },
    ];
  }

  return scopedMappings;
}

const resolveRepositoryRouting = (input: {
  readonly organizationId: string;
  readonly issueTeamKey: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly issueDescription?: string;
  readonly mappings: ReadonlyArray<LinearProjectMapping>;
  readonly defaultWorkspaceRoot: string;
}): RepositoryRoutingResolution => {
  const selectableMappings = buildSelectableMappings(input);
  if (selectableMappings.length > 0) {
    const routingMatches = collectRoutingMatches(input);
    const firstResolvedTier = routingMatches.find((entry) => entry.matches.length > 0);
    if (firstResolvedTier) {
      if (firstResolvedTier.matches.length === 1) {
        const [mapping] = firstResolvedTier.matches;
        if (mapping) {
          // Team-level routing is intentionally broad; when multiple repositories
          // are configured we mirror Cyrus and ask the user instead of silently
          // preferring the first team match over the default workspace.
          if (firstResolvedTier.tier === "team-key" && selectableMappings.length > 1) {
            return { type: "selection", mappings: selectableMappings };
          }
          return { type: "resolved", mapping };
        }
      }
      // Cyrus asks the user to choose when multiple configured repositories remain viable.
      return { type: "selection", mappings: selectableMappings };
    }

    if (selectableMappings.length === 1) {
      const [mapping] = selectableMappings;
      if (mapping) {
        return { type: "resolved", mapping };
      }
    }

    // When multiple repositories are available we prefer Cyrus-style repo
    // elicitation over silently picking the fallback workspace.
    return { type: "selection", mappings: selectableMappings };
  }

  const resolvedFallback = resolveMapping({
    ...input,
    defaultWorkspaceRoot: input.defaultWorkspaceRoot,
  });
  if (resolvedFallback) {
    return { type: "resolved", mapping: resolvedFallback };
  }
  return { type: "none" };
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
  const projectOnboarding = yield* ProjectOnboarding;
  const threadRelationshipRegistry = yield* ThreadRelationshipRegistry;
  const toolPolicyResolver = yield* ToolPolicyResolver;
  const pendingRepositorySelections = yield* Ref.make(
    new Map<string, PendingRepositorySelection>(),
  );

  const resolveLinearToken = Effect.fn("resolveLinearToken")(function* () {
    const settings = yield* serverSettings.getSettings;
    const directToken = settings.linear.apiToken.trim();
    if (directToken) {
      return directToken;
    }
    // Fallback to OAuth token if available — imported via LinearOAuth in LinearClient
    // but we access it through the settings OAuth workspace.
    return settings.linear.oauth.workspace?.accessToken ?? null;
  });

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

      return resolveRepositoryRouting(input);
    },
  );

  const storePendingRepositorySelection = Effect.fn("storePendingRepositorySelection")(
    function* (input: {
      readonly linearSessionId: string;
      readonly pending: PendingRepositorySelection;
    }) {
      yield* Ref.update(pendingRepositorySelections, (current) => {
        const next = new Map(current);
        next.set(input.linearSessionId, input.pending);
        return next;
      });
    },
  );

  const takePendingRepositorySelection = Effect.fn("takePendingRepositorySelection")(function* (
    linearSessionId: string,
  ) {
    return yield* Ref.modify(pendingRepositorySelections, (current) => {
      const next = new Map(current);
      const pending = next.get(linearSessionId) ?? null;
      next.delete(linearSessionId);
      return [pending, next] as const;
    });
  });

  const elicitRepositorySelection = Effect.fn("elicitRepositorySelection")(function* (input: {
    readonly linearSessionId: string;
    readonly mappings: ReadonlyArray<LinearProjectMapping>;
  }) {
    const firstMapping = input.mappings[0];
    if (!firstMapping) {
      return;
    }

    const options = input.mappings.map((mapping) => ({
      value: defaultRouteKey(mapping),
    }));

    yield* linearClient.createAgentActivity({
      agentSessionId: input.linearSessionId,
      content: {
        type: "elicitation",
        body: "Which repository should I work in for this issue?",
      },
      signal: "select",
      signalMetadata: { options },
    });
  });

  const postResponseActivity = Effect.fn("postResponseActivity")(function* (input: {
    readonly linearSessionId: string;
    readonly body: string;
  }) {
    // Cyrus emits explicit response activities for terminal session moments so
    // Linear always has a durable explanation instead of only an interrupt.
    yield* linearClient.createAgentActivity({
      agentSessionId: input.linearSessionId,
      content: {
        type: "response",
        body: input.body,
      },
      ephemeral: false,
    });
  });

  const stopSessionsWithResponse = Effect.fn("stopSessionsWithResponse")(function* (input: {
    readonly sessions: ReadonlyArray<LinearSessionRow>;
    readonly responseBody: string;
  }) {
    for (const session of input.sessions) {
      yield* postResponseActivity({
        linearSessionId: session.linearSessionId,
        body: input.responseBody,
      }).pipe(Effect.catch(() => Effect.void));
    }

    const uniqueThreadIds = [...new Set(input.sessions.map((entry) => entry.threadId))];
    for (const threadId of uniqueThreadIds) {
      yield* stopThreadForSession(threadId);
    }
  });

  const selectMappingFromPrompt = (input: {
    readonly mappings: ReadonlyArray<LinearProjectMapping>;
    readonly prompt: string;
  }): { readonly mapping: LinearProjectMapping; readonly matchedSelection: boolean } | null => {
    const firstMapping = input.mappings[0];
    if (!firstMapping) {
      return null;
    }

    const selectedMapping =
      input.mappings.find((mapping) => mappingMatchesRouteKey(mapping, input.prompt)) ?? null;
    return {
      mapping: selectedMapping ?? firstMapping,
      matchedSelection: selectedMapping !== null,
    };
  };

  const startNewIssueSession = Effect.fn("startNewIssueSession")(function* (input: {
    readonly linearSessionId: string;
    readonly issue: LinearIssueDetails;
    readonly issueComments: ReadonlyArray<LinearIssueComment>;
    readonly mapping: LinearProjectMapping;
    readonly guidance?: ReadonlyArray<LinearPromptAssemblerGuidanceRule>;
    readonly newComment?: LinearPromptAssemblerCommentContext;
    readonly parentLinearSessionId?: string;
  }) {
    const parentRelationship = input.parentLinearSessionId
      ? yield* threadRelationshipRegistry.findParentByLinearSession(input.parentLinearSessionId)
      : Option.none();
    const parentThreadContext = Option.isSome(parentRelationship)
      ? yield* lookupThreadContext(parentRelationship.value.parentThreadId)
      : Option.none<ActiveThreadContext>();
    const project = yield* projectOnboarding
      .ensureProjectForWorkspaceRoot(input.mapping.workspaceRoot)
      .pipe(
        Effect.mapError(
          (cause) =>
            new LinearWebhookHandlerError({
              detail:
                cause instanceof Error
                  ? cause.message
                  : "Failed to prepare project for Linear issue.",
              cause,
            }),
        ),
      );
    const promptType = yield* resolvePromptTypeWithDiagnostics({
      issueIdentifier: input.issue.identifier,
      labelNames: input.issue.labelNames,
      mapping: input.mapping,
    });
    const blockedByBranch =
      promptType === "graphite-orchestrator" ? yield* findBlockedByBranch(input.issue) : null;
    const baseBranch = resolveBaseBranch({
      issue: input.issue,
      mapping: input.mapping,
      blockedByBranch,
      parentBranch:
        Option.isSome(parentThreadContext) &&
        parentThreadContext.value.projectId === project.projectId
          ? parentThreadContext.value.branch
          : null,
    });
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const repositoryRoutingContext =
      promptType === "orchestrator" || promptType === "graphite-orchestrator"
        ? buildRepositoryRoutingContext({
            currentProjectId: project.projectId,
            projects: snapshot.projects,
            mappings: (yield* serverSettings.getSettings).linearProjectMappings.mappings,
          })
        : undefined;
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
    const branchName = sanitizeFeatureBranchName(`${input.issue.identifier} ${input.issue.title}`);
    const worktreePath = path.join(input.mapping.workspaceRoot, branchName);

    // Download attachments from issue description and comments before prompt
    // assembly so the manifest can be included in the prompt.
    const attachmentsDir = path.join(worktreePath, ".t3-attachments");
    const linearToken = yield* resolveLinearToken();
    const attachmentResult = yield* downloadIssueAttachments({
      issueDescription: input.issue.description,
      commentBodies: input.issueComments.map((c) => c.body),
      attachmentsDir,
      token: linearToken,
    });

    const promptAssembly = yield* promptAssembler.assembleNewSessionPrompt({
      issue: input.issue,
      comments: input.issueComments,
      workspaceRoot: input.mapping.workspaceRoot,
      worktreePath,
      baseBranch,
      promptType,
      ...(repositoryRoutingContext ? { repositoryRoutingContext } : {}),
      ...(input.newComment ? { newComment: input.newComment } : {}),
      ...(input.guidance ? { guidance: input.guidance } : {}),
      ...(attachmentResult.manifest ? { attachmentManifest: attachmentResult.manifest } : {}),
    });
    const toolPolicy = yield* resolveToolPolicy({
      promptType: promptAssembly.promptType,
      mappings: [input.mapping],
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
      titleSeed: input.issue.title,
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
          projectId: project.projectId,
          title: input.issue.identifier,
          modelSelection: project.defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
        prepareWorktree: {
          projectCwd: input.mapping.workspaceRoot,
          baseBranch,
          branch: branchName,
          writeLinearMcpConfig: true,
        },
        runSetupScript: true,
      },
      createdAt,
    });

    yield* sessionRegistry.register({
      linearSessionId: input.linearSessionId,
      threadId,
      projectId: project.projectId,
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      createdAt,
    });
    if (Option.isSome(parentRelationship)) {
      yield* threadRelationshipRegistry.attachChildThread({
        childLinearSessionId: input.linearSessionId,
        childThreadId: threadId,
        childIssueIdentifier: input.issue.identifier,
        childWorktreePath: worktreePath,
        attachedAt: createdAt,
      });
    }
    yield* appendPromptModeActivity({
      threadId,
      promptType: promptAssembly.promptType,
      createdAt,
    });

    // Mirror Cyrus: move the issue to "In Progress" when the agent starts working.
    // Fire-and-forget — don't block session startup on the state transition.
    yield* moveIssueToInProgress({
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      teamId: input.issue.teamId,
      currentState: input.issue.state,
    });
  });

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

  const findBlockedByBranch = Effect.fn("findBlockedByBranch")(function* (
    issue: LinearIssueDetails,
  ) {
    for (const blockedByIssueId of issue.blockedByIssueIds) {
      const sessions = yield* sessionRegistry.listByIssueId(blockedByIssueId);
      const blockedBySession = yield* findLatestLiveLinearSessionContext({
        sessions,
        lookupThreadContext,
        removeSession: sessionRegistry.remove,
      });
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
    const newComment = newCommentFromCreatedWebhook(webhook);
    const issueSessions = yield* sessionRegistry.listByIssueId(fetchedIssue.id);
    const existingSessionContext = yield* findLatestLiveLinearSessionContext({
      sessions: issueSessions,
      lookupThreadContext,
      removeSession: sessionRegistry.remove,
    });
    const parentRelationship = yield* threadRelationshipRegistry.findParentByLinearSession(
      webhook.agentSession.id,
    );

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
    const routingResolution = yield* resolveMappingWithDiagnostics({
      organizationId: webhook.organizationId,
      issueTeamKey: fetchedIssue.teamKey,
      labelNames: fetchedIssue.labelNames,
      projectKeys: fetchedIssue.projectKeys,
      issueDescription: fetchedIssue.description,
      mappings: settings.linearProjectMappings.mappings,
      defaultWorkspaceRoot: settings.linearProjectMappings.defaultWorkspaceRoot,
      issueIdentifier: fetchedIssue.identifier,
    });

    if (routingResolution.type === "selection") {
      yield* storePendingRepositorySelection({
        linearSessionId: webhook.agentSession.id,
        pending: {
          mappings: routingResolution.mappings,
          ...(newComment ? { newComment } : {}),
          ...(webhook.guidance ? { guidance: webhook.guidance } : {}),
        },
      });
      yield* elicitRepositorySelection({
        linearSessionId: webhook.agentSession.id,
        mappings: routingResolution.mappings,
      });
      return;
    }

    if (routingResolution.type === "none") {
      return yield* new LinearWebhookHandlerError({
        detail: `No Linear project mapping matched ${fetchedIssue.identifier}.`,
      });
    }
    const mapping = routingResolution.mapping;
    yield* startNewIssueSession({
      linearSessionId: webhook.agentSession.id,
      issue: fetchedIssue,
      issueComments,
      mapping,
      ...(newComment ? { newComment } : {}),
      ...(webhook.guidance ? { guidance: webhook.guidance } : {}),
      ...(Option.isSome(parentRelationship)
        ? { parentLinearSessionId: webhook.agentSession.id }
        : {}),
    });
  });

  const handlePrompted = Effect.fn("handlePrompted")(function* (
    webhook: LinearAgentSessionPromptedWebhookPayload,
  ) {
    const issueId = webhook.agentSession.issueId ?? webhook.agentSession.issue.id;
    const pendingSelection = yield* takePendingRepositorySelection(webhook.agentSession.id);

    if (
      webhook.agentActivity?.signal === "stop" ||
      LINEAR_STOP_REQUEST.test(stopTextFromPromptedWebhook(webhook))
    ) {
      if (pendingSelection) {
        return;
      }
    }

    if (pendingSelection) {
      const fetchedIssue = yield* linearClient.fetchIssue(issueId);
      const issueComments = yield* linearClient.fetchIssueComments(fetchedIssue.id);
      const selectedPrompt = promptFromPromptedWebhook(webhook);
      const selectedMapping = selectMappingFromPrompt({
        mappings: pendingSelection.mappings,
        prompt: selectedPrompt,
      });
      if (!selectedMapping) {
        return yield* new LinearWebhookHandlerError({
          detail: `No repository mappings are available for prompted issue ${issueId}.`,
        });
      }

      const followUpComment = selectedMapping.matchedSelection
        ? pendingSelection.newComment
        : continuationCommentFromPromptedWebhook(webhook);

      yield* startNewIssueSession({
        linearSessionId: webhook.agentSession.id,
        issue: fetchedIssue,
        issueComments,
        mapping: selectedMapping.mapping,
        ...(followUpComment ? { newComment: followUpComment } : {}),
        ...(pendingSelection.guidance ? { guidance: pendingSelection.guidance } : {}),
        parentLinearSessionId: webhook.agentSession.id,
      });
      return;
    }

    const sessionLookup = yield* sessionRegistry.lookupBySessionId(webhook.agentSession.id);
    const fallbackSessions = yield* sessionRegistry.listByIssueId(issueId);
    const sessionCandidates = dedupeLinearSessions(
      Option.match(sessionLookup, {
        onNone: () => fallbackSessions,
        onSome: (session) => [session, ...fallbackSessions],
      }),
    );
    const targetSession = yield* findLatestLiveLinearSessionContext({
      sessions: sessionCandidates,
      lookupThreadContext,
      removeSession: sessionRegistry.remove,
    });

    if (!targetSession) {
      return yield* new LinearWebhookHandlerError({
        detail: `No active Linear session mapping found for prompted issue ${issueId}.`,
      });
    }

    if (
      webhook.agentActivity?.signal === "stop" ||
      LINEAR_STOP_REQUEST.test(stopTextFromPromptedWebhook(webhook))
    ) {
      yield* postResponseActivity({
        linearSessionId: targetSession.session.linearSessionId,
        body: "Stopping work on this issue at your request.",
      }).pipe(Effect.catch(() => Effect.void));
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
    // Download any new attachments from the continuation comment.
    const commentBody = promptFromPromptedWebhook(webhook);
    const continuationAttachmentsDir = targetSession.thread.worktreePath
      ? path.join(targetSession.thread.worktreePath, ".t3-attachments")
      : null;
    const continuationToken = yield* resolveLinearToken();
    const commentAttachmentResult = continuationAttachmentsDir
      ? yield* downloadCommentAttachments({
          commentBody,
          attachmentsDir: continuationAttachmentsDir,
          token: continuationToken,
        })
      : null;

    const promptAssembly = yield* promptAssembler.assembleContinuationPrompt({
      comment: continuationCommentFromPromptedWebhook(webhook),
      promptType,
      ...(commentAttachmentResult?.manifest
        ? { attachmentManifest: commentAttachmentResult.manifest }
        : {}),
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
        yield* stopSessionsWithResponse({
          sessions,
          responseBody: `Stopping work because the issue moved to '${nextState.name}'.`,
        });
        yield* sessionRegistry.removeByIssueId(webhook.data.id);
        return;
      }
    }

    if (updatedFrom.description === undefined && updatedFrom.title === undefined) {
      return;
    }

    const sessions = yield* sessionRegistry.listByIssueId(webhook.data.id);
    const targetSession = yield* findLatestLiveLinearSessionContext({
      sessions,
      lookupThreadContext,
      removeSession: sessionRegistry.remove,
    });
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
    yield* stopSessionsWithResponse({
      sessions,
      responseBody: "Stopping work because this issue was unassigned from me.",
    });
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
        // Linear's created event currently includes nullable SDK fields that we do not depend on.
        // Normalize only the data needed to bootstrap a session, mirroring Cyrus's looser handling.
        const webhook = yield* decodeCreatedWebhookPayload(payload);
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
