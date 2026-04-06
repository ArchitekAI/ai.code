import { type LinearProjectMapping, type PromptType } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ResolvedToolPolicy {
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
}

export interface ToolPolicyResolverShape {
  readonly resolve: (input: {
    readonly promptType: PromptType;
    readonly mappings: ReadonlyArray<LinearProjectMapping>;
  }) => Effect.Effect<ResolvedToolPolicy>;
}

export class ToolPolicyResolver extends ServiceMap.Service<
  ToolPolicyResolver,
  ToolPolicyResolverShape
>()("t3/provider/Services/ToolPolicyResolver") {}
