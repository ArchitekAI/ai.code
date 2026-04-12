import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ChildCompletionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ChildCompletionReactor extends ServiceMap.Service<
  ChildCompletionReactor,
  ChildCompletionReactorShape
>()("t3/mcp/Services/ChildCompletionReactor") {}
