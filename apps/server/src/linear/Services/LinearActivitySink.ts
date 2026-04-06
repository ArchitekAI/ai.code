import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface LinearActivitySinkShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LinearActivitySink extends ServiceMap.Service<
  LinearActivitySink,
  LinearActivitySinkShape
>()("t3/linear/Services/LinearActivitySink") {}
