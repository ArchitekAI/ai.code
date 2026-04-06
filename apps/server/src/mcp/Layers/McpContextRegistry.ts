import { Effect, Layer, Option, Ref } from "effect";

import {
  McpContextRegistry,
  type McpContextRegistration,
  type McpContextRegistryShape,
} from "../Services/McpContextRegistry.ts";

const makeMcpContextRegistry = Effect.gen(function* () {
  const contextsRef = yield* Ref.make(new Map<string, McpContextRegistration>());

  const register: McpContextRegistryShape["register"] = (registration) =>
    Ref.update(contextsRef, (contexts) => {
      const next = new Map(contexts);
      next.set(registration.contextId, registration);
      return next;
    });

  const lookup: McpContextRegistryShape["lookup"] = (contextId) =>
    Ref.get(contextsRef).pipe(
      Effect.map((contexts) => {
        const registration = contexts.get(contextId);
        return registration === undefined ? Option.none() : Option.some(registration);
      }),
    );

  const remove: McpContextRegistryShape["remove"] = (contextId) =>
    Ref.update(contextsRef, (contexts) => {
      if (!contexts.has(contextId)) {
        return contexts;
      }
      const next = new Map(contexts);
      next.delete(contextId);
      return next;
    });

  return {
    register,
    lookup,
    remove,
  } satisfies McpContextRegistryShape;
});

export const McpContextRegistryLive = Layer.effect(McpContextRegistry, makeMcpContextRegistry);
