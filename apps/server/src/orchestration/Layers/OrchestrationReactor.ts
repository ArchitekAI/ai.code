import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { LinearActivitySink } from "../../linear/Services/LinearActivitySink.ts";
import { LinearSessionCompletionReactor } from "../../linear/Services/LinearSessionCompletionReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ChildCompletionReactor } from "../../mcp/Services/ChildCompletionReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const linearActivitySink = yield* LinearActivitySink;
  const linearSessionCompletionReactor = yield* LinearSessionCompletionReactor;
  const childCompletionReactor = yield* ChildCompletionReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* linearActivitySink.start();
    yield* linearSessionCompletionReactor.start();
    yield* childCompletionReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
