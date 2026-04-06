import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas";

export const LinearVerificationMode = Schema.Literals(["direct", "proxy"]);
export type LinearVerificationMode = typeof LinearVerificationMode.Type;

export const LinearSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  webhookSecret: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  apiToken: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  verificationMode: LinearVerificationMode.pipe(Schema.withDecodingDefault(() => "direct")),
});
export type LinearSettings = typeof LinearSettings.Type;

export const LinearProjectMapping = Schema.Struct({
  organizationId: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  labelName: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: TrimmedNonEmptyString,
  // Linear webhooks do not carry enough Git metadata to derive this reliably.
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  // Route metadata keeps Linear issue routing aligned with local T3 projects.
  routeKey: Schema.optional(TrimmedNonEmptyString),
  routeAliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  routingLabels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  projectKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  // Prompt labels stay colocated with routing so workspace behavior resolves consistently.
  promptLabels: Schema.optional(
    Schema.Struct({
      builder: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      debugger: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      scoper: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      orchestrator: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      graphite: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
  ),
  // Tool policy lives with the mapping so prompt selection and permissions stay in sync.
  toolPolicy: Schema.optional(
    Schema.Struct({
      defaultAllowedToolsPreset: Schema.optional(TrimmedNonEmptyString),
      defaultDisallowedTools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      promptDefaults: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type LinearProjectMapping = typeof LinearProjectMapping.Type;

export const LinearProjectMappings = Schema.Struct({
  mappings: Schema.Array(LinearProjectMapping).pipe(Schema.withDecodingDefault(() => [])),
  defaultWorkspaceRoot: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type LinearProjectMappings = typeof LinearProjectMappings.Type;

const LinearTeamWebhook = Schema.Struct({
  key: TrimmedNonEmptyString,
});

const LinearIssueWebhook = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  team: LinearTeamWebhook,
});

const LinearCommentWebhook = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: TrimmedString,
});

const LinearUserWebhook = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedString),
  displayName: Schema.optional(TrimmedString),
  email: Schema.optional(TrimmedString),
});

const LinearGuidanceOriginWebhook = Schema.Struct({
  __typename: Schema.optional(TrimmedString),
  team: Schema.optional(
    Schema.Struct({
      displayName: Schema.optional(TrimmedString),
    }),
  ),
});

const LinearGuidanceWebhook = Schema.Struct({
  body: TrimmedString,
  origin: Schema.optional(LinearGuidanceOriginWebhook),
});

const LinearAgentActivityContentWebhook = Schema.Struct({
  body: TrimmedString,
});

const LinearAgentActivityWebhook = Schema.Struct({
  id: TrimmedNonEmptyString,
  signal: Schema.optional(TrimmedNonEmptyString),
  content: Schema.optional(LinearAgentActivityContentWebhook),
});

const LinearAgentSessionWebhook = Schema.Struct({
  id: TrimmedNonEmptyString,
  issue: LinearIssueWebhook,
  issueId: Schema.optional(TrimmedNonEmptyString),
  comment: Schema.optional(LinearCommentWebhook),
  creator: Schema.optional(LinearUserWebhook),
});

export const LinearAgentSessionCreatedWebhook = Schema.Struct({
  type: Schema.Literal("AgentSessionEvent"),
  action: Schema.Literal("created"),
  createdAt: IsoDateTime,
  organizationId: TrimmedNonEmptyString,
  agentSession: LinearAgentSessionWebhook,
  guidance: Schema.optional(Schema.Array(LinearGuidanceWebhook)),
});
export type LinearAgentSessionCreatedWebhook = typeof LinearAgentSessionCreatedWebhook.Type;

export const LinearAgentSessionPromptedWebhook = Schema.Struct({
  type: Schema.Literal("AgentSessionEvent"),
  action: Schema.Literal("prompted"),
  createdAt: IsoDateTime,
  organizationId: TrimmedNonEmptyString,
  agentSession: LinearAgentSessionWebhook,
  agentActivity: Schema.optional(LinearAgentActivityWebhook),
  guidance: Schema.optional(Schema.Array(LinearGuidanceWebhook)),
});
export type LinearAgentSessionPromptedWebhook = typeof LinearAgentSessionPromptedWebhook.Type;

export const LinearIssueStateChangeWebhook = Schema.Struct({
  type: Schema.Literal("Issue"),
  action: Schema.Literal("update"),
  createdAt: IsoDateTime,
  organizationId: TrimmedNonEmptyString,
  data: Schema.Struct({
    id: TrimmedNonEmptyString,
    identifier: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    description: Schema.optional(TrimmedString),
    url: Schema.optional(TrimmedString),
    stateId: TrimmedNonEmptyString,
    team: LinearTeamWebhook,
  }),
  updatedFrom: Schema.optional(
    Schema.Struct({
      stateId: Schema.optional(TrimmedNonEmptyString),
      description: Schema.optional(TrimmedString),
      title: Schema.optional(TrimmedString),
    }),
  ),
});
export type LinearIssueStateChangeWebhook = typeof LinearIssueStateChangeWebhook.Type;

export const LinearIssueUnassignedWebhook = Schema.Struct({
  type: Schema.Literal("AppUserNotification"),
  action: Schema.Literal("issueUnassignedFromYou"),
  createdAt: IsoDateTime,
  organizationId: TrimmedNonEmptyString,
  notification: Schema.Struct({
    type: Schema.Literal("issueUnassignedFromYou"),
    issueId: TrimmedNonEmptyString,
    issue: LinearIssueWebhook,
  }),
});
export type LinearIssueUnassignedWebhook = typeof LinearIssueUnassignedWebhook.Type;

export const LinearWebhookEnvelope = Schema.Union([
  LinearAgentSessionCreatedWebhook,
  LinearAgentSessionPromptedWebhook,
  LinearIssueUnassignedWebhook,
  LinearIssueStateChangeWebhook,
]);
export type LinearWebhookEnvelope = typeof LinearWebhookEnvelope.Type;

export const LinearSessionRow = Schema.Struct({
  linearSessionId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  issueId: TrimmedNonEmptyString,
  issueIdentifier: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type LinearSessionRow = typeof LinearSessionRow.Type;

export const ThreadRelationshipType = Schema.Literal("delegated-task");
export type ThreadRelationshipType = typeof ThreadRelationshipType.Type;

export const ThreadRelationshipRow = Schema.Struct({
  id: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  childLinearSessionId: TrimmedNonEmptyString,
  childIssueIdentifier: Schema.NullOr(TrimmedNonEmptyString),
  childWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  relationshipType: ThreadRelationshipType,
  lastResumedChildTurnId: Schema.NullOr(TrimmedNonEmptyString),
  attachedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadRelationshipRow = typeof ThreadRelationshipRow.Type;

export class LinearWebhookVerificationError extends Schema.TaggedErrorClass<LinearWebhookVerificationError>()(
  "LinearWebhookVerificationError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Linear webhook verification failed: ${this.detail}`;
  }
}

export class LinearWebhookHandlerError extends Schema.TaggedErrorClass<LinearWebhookHandlerError>()(
  "LinearWebhookHandlerError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Linear webhook handling failed: ${this.detail}`;
  }
}

export class LinearActivitySinkError extends Schema.TaggedErrorClass<LinearActivitySinkError>()(
  "LinearActivitySinkError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Linear activity sink failed: ${this.detail}`;
  }
}
