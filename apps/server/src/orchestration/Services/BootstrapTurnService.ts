import { type OrchestrationCommand, OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface BootstrapTurnServiceShape {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class BootstrapTurnService extends ServiceMap.Service<
  BootstrapTurnService,
  BootstrapTurnServiceShape
>()("t3/orchestration/Services/BootstrapTurnService") {}
