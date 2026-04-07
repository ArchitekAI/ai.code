import { LinearWebhookHandlerError, type PromptType } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { LinearIssueComment, LinearIssueDetails } from "./LinearClient.ts";

export interface LinearPromptAssemblerGuidanceRule {
  readonly body: string;
  readonly origin?:
    | {
        readonly __typename?: string | undefined;
        readonly team?:
          | {
              readonly displayName?: string | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface LinearPromptAssemblerCommentContext {
  readonly body: string;
  readonly author: string;
  readonly timestamp: string;
}

export interface LinearPromptAssembly {
  readonly prompt: string;
  readonly systemPromptPrefix?: string;
  readonly promptType: PromptType;
}

export interface LinearPromptAssemblerShape {
  readonly assembleNewSessionPrompt: (input: {
    readonly issue: LinearIssueDetails;
    readonly comments: ReadonlyArray<LinearIssueComment>;
    readonly workspaceRoot: string;
    readonly worktreePath: string;
    readonly baseBranch: string;
    readonly newComment?: LinearPromptAssemblerCommentContext;
    readonly guidance?: ReadonlyArray<LinearPromptAssemblerGuidanceRule>;
    readonly promptType?: PromptType;
    readonly repositoryRoutingContext?: string;
    readonly attachmentManifest?: string;
  }) => Effect.Effect<LinearPromptAssembly, LinearWebhookHandlerError>;
  readonly assembleContinuationPrompt: (input: {
    readonly comment: LinearPromptAssemblerCommentContext;
    readonly promptType?: PromptType;
    readonly attachmentManifest?: string;
  }) => Effect.Effect<LinearPromptAssembly, LinearWebhookHandlerError>;
  readonly assembleIssueUpdatePrompt: (input: {
    readonly issue: LinearIssueDetails;
    readonly previousTitle?: string;
    readonly previousDescription?: string;
    readonly promptType?: PromptType;
  }) => Effect.Effect<LinearPromptAssembly, LinearWebhookHandlerError>;
}

export class LinearPromptAssembler extends ServiceMap.Service<
  LinearPromptAssembler,
  LinearPromptAssemblerShape
>()("t3/linear/Services/LinearPromptAssembler") {}
