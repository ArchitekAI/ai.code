import { LinearActivitySinkError } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface LinearIssueDetails {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly teamKey: string;
  readonly state: string;
  readonly priority: number;
  readonly url: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly blockedByIssueIds: ReadonlyArray<string>;
}

export interface LinearIssueComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly author: string;
  readonly parentId?: string;
}

export interface LinearIssueStateDetails {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

export interface LinearAgentActivityInput {
  readonly agentSessionId: string;
  readonly content: Record<string, unknown>;
  readonly ephemeral?: boolean;
  readonly signal?: string;
  readonly signalMetadata?: Record<string, unknown>;
}

export interface LinearFileUploadInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly makePublic?: boolean;
}

export interface LinearFileUploadResult {
  readonly assetUrl: string;
  readonly uploadUrl: string;
}

export interface LinearAgentSessionSummary {
  readonly id: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
}

export interface LinearIssueRelationInput {
  readonly issueId: string;
  readonly relatedIssueId: string;
  readonly type: "blocks" | "related" | "duplicate";
}

export interface LinearChildIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly state?: string;
  readonly archivedAt?: string;
}

export interface LinearClientShape {
  readonly createAgentActivity: (
    input: LinearAgentActivityInput,
  ) => Effect.Effect<{ readonly activityId: string }, LinearActivitySinkError>;
  readonly fetchIssue: (
    issueId: string,
  ) => Effect.Effect<LinearIssueDetails, LinearActivitySinkError>;
  readonly fetchIssueComments: (
    issueId: string,
  ) => Effect.Effect<ReadonlyArray<LinearIssueComment>, LinearActivitySinkError>;
  readonly fetchIssueState: (
    issueId: string,
  ) => Effect.Effect<LinearIssueStateDetails, LinearActivitySinkError>;
  readonly uploadFile: (
    input: LinearFileUploadInput,
  ) => Effect.Effect<LinearFileUploadResult, LinearActivitySinkError>;
  readonly createAgentSessionOnIssue: (
    issueId: string,
    externalLink?: string,
  ) => Effect.Effect<LinearAgentSessionSummary, LinearActivitySinkError>;
  readonly createAgentSessionOnComment: (
    commentId: string,
    externalLink?: string,
  ) => Effect.Effect<LinearAgentSessionSummary, LinearActivitySinkError>;
  readonly listAgentSessions: (input?: {
    readonly first?: number;
    readonly after?: string;
    readonly before?: string;
    readonly last?: number;
    readonly includeArchived?: boolean;
    readonly orderBy?: string;
  }) => Effect.Effect<ReadonlyArray<LinearAgentSessionSummary>, LinearActivitySinkError>;
  readonly getAgentSession: (
    sessionId: string,
  ) => Effect.Effect<LinearAgentSessionSummary, LinearActivitySinkError>;
  readonly createIssueRelation: (
    input: LinearIssueRelationInput,
  ) => Effect.Effect<void, LinearActivitySinkError>;
  readonly listChildIssues: (input: {
    readonly issueId: string;
    readonly limit?: number;
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<LinearChildIssue>, LinearActivitySinkError>;
}

export class LinearClient extends ServiceMap.Service<LinearClient, LinearClientShape>()(
  "t3/linear/Services/LinearClient",
) {}
