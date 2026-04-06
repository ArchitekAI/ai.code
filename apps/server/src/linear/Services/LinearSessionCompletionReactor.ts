import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface LinearSessionCompletionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LinearSessionCompletionReactor extends ServiceMap.Service<
  LinearSessionCompletionReactor,
  LinearSessionCompletionReactorShape
>()("t3/linear/Services/LinearSessionCompletionReactor") {}
