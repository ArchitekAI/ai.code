import { LinearActivitySinkError } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface LinearIssueDetails {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly teamKey: string;
  readonly labelNames: ReadonlyArray<string>;
}

export interface LinearAgentActivityInput {
  readonly agentSessionId: string;
  readonly content: Record<string, unknown>;
  readonly ephemeral?: boolean;
  readonly signal?: string;
  readonly signalMetadata?: Record<string, unknown>;
}

export interface LinearClientShape {
  readonly createAgentActivity: (
    input: LinearAgentActivityInput,
  ) => Effect.Effect<{ readonly activityId: string }, LinearActivitySinkError>;
  readonly fetchIssue: (
    issueId: string,
  ) => Effect.Effect<LinearIssueDetails, LinearActivitySinkError>;
}

export class LinearClient extends ServiceMap.Service<LinearClient, LinearClientShape>()(
  "t3/linear/Services/LinearClient",
) {}
