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
  teamKey: Schema.optional(TrimmedNonEmptyString),
  labelName: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: TrimmedNonEmptyString,
  // Linear webhooks do not carry enough Git metadata to derive this reliably.
  baseBranch: Schema.optional(TrimmedNonEmptyString),
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
});

export const LinearAgentSessionCreatedWebhook = Schema.Struct({
  type: Schema.Literal("AgentSessionEvent"),
  action: Schema.Literal("created"),
  createdAt: IsoDateTime,
  organizationId: TrimmedNonEmptyString,
  agentSession: LinearAgentSessionWebhook,
});
export type LinearAgentSessionCreatedWebhook = typeof LinearAgentSessionCreatedWebhook.Type;

export const LinearAgentSessionPromptedWebhook = Schema.Struct({
  type: Schema.Literal("AgentSessionEvent"),
  action: Schema.Literal("prompted"),
  createdAt: IsoDateTime,
  organizationId: TrimmedNonEmptyString,
  agentSession: LinearAgentSessionWebhook,
  agentActivity: Schema.optional(LinearAgentActivityWebhook),
});
export type LinearAgentSessionPromptedWebhook = typeof LinearAgentSessionPromptedWebhook.Type;

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
