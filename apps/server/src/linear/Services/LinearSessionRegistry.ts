import { type LinearSessionRow, ThreadId } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type LinearSessionRegistryError = PersistenceSqlError | PersistenceDecodeError;

export interface LinearSessionRegistryShape {
  readonly register: (entry: LinearSessionRow) => Effect.Effect<void, LinearSessionRegistryError>;
  readonly lookupBySessionId: (
    linearSessionId: string,
  ) => Effect.Effect<Option.Option<LinearSessionRow>, LinearSessionRegistryError>;
  readonly listByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<LinearSessionRow>, LinearSessionRegistryError>;
  readonly listByIssueId: (
    issueId: string,
  ) => Effect.Effect<ReadonlyArray<LinearSessionRow>, LinearSessionRegistryError>;
  readonly remove: (linearSessionId: string) => Effect.Effect<void, LinearSessionRegistryError>;
  readonly removeByIssueId: (issueId: string) => Effect.Effect<void, LinearSessionRegistryError>;
}

export class LinearSessionRegistry extends ServiceMap.Service<
  LinearSessionRegistry,
  LinearSessionRegistryShape
>()("t3/linear/Services/LinearSessionRegistry") {}
