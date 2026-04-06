import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

export interface McpContextRegistration {
  readonly contextId: string;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId;
}

export interface McpContextRegistryShape {
  readonly register: (registration: McpContextRegistration) => Effect.Effect<void>;
  readonly lookup: (contextId: string) => Effect.Effect<Option.Option<McpContextRegistration>>;
  readonly remove: (contextId: string) => Effect.Effect<void>;
}

export class McpContextRegistry extends ServiceMap.Service<
  McpContextRegistry,
  McpContextRegistryShape
>()("t3/mcp/Services/McpContextRegistry") {}
