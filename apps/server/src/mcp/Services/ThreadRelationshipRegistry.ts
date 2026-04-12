import { type ThreadId, type ThreadRelationshipRow } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type ThreadRelationshipRegistryError = PersistenceSqlError | PersistenceDecodeError;

export interface ThreadRelationshipRegistryShape {
  readonly registerFromMcp: (input: {
    readonly id: string;
    readonly parentThreadId: ThreadId;
    readonly childLinearSessionId: string;
    readonly childIssueIdentifier?: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, ThreadRelationshipRegistryError>;
  readonly attachChildThread: (input: {
    readonly childLinearSessionId: string;
    readonly childThreadId: ThreadId;
    readonly childIssueIdentifier?: string;
    readonly childWorktreePath?: string | null;
    readonly attachedAt: string;
  }) => Effect.Effect<void, ThreadRelationshipRegistryError>;
  readonly listChildren: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadRelationshipRow>, ThreadRelationshipRegistryError>;
  readonly findParent: (
    childThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadRelationshipRow>, ThreadRelationshipRegistryError>;
  readonly findParentByLinearSession: (
    childLinearSessionId: string,
  ) => Effect.Effect<Option.Option<ThreadRelationshipRow>, ThreadRelationshipRegistryError>;
  readonly markResumed: (
    childThreadId: ThreadId,
    childTurnId: string,
  ) => Effect.Effect<boolean, ThreadRelationshipRegistryError>;
  readonly updateChildWorktree: (
    childThreadId: ThreadId,
    childWorktreePath: string,
  ) => Effect.Effect<void, ThreadRelationshipRegistryError>;
  readonly remove: (
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
  ) => Effect.Effect<void, ThreadRelationshipRegistryError>;
}

export class ThreadRelationshipRegistry extends ServiceMap.Service<
  ThreadRelationshipRegistry,
  ThreadRelationshipRegistryShape
>()("t3/mcp/Services/ThreadRelationshipRegistry") {}
