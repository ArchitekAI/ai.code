import { ThreadId, ThreadRelationshipRow } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../../persistence/Errors.ts";
import {
  ThreadRelationshipRegistry,
  type ThreadRelationshipRegistryShape,
} from "../Services/ThreadRelationshipRegistry.ts";

const ThreadRelationshipRowDbSchema = ThreadRelationshipRow;
const decodeRow = Schema.decodeUnknownEffect(ThreadRelationshipRow);

const FindByParentRequestSchema = Schema.Struct({
  parentThreadId: ThreadId,
});

const FindByChildRequestSchema = Schema.Struct({
  childThreadId: ThreadId,
});

const FindByLinearSessionRequestSchema = Schema.Struct({
  childLinearSessionId: Schema.String,
});

const MarkResumedRequestSchema = Schema.Struct({
  childThreadId: ThreadId,
  childTurnId: Schema.String,
  updatedAt: Schema.String,
});

const UpdateChildWorktreeRequestSchema = Schema.Struct({
  childThreadId: ThreadId,
  childWorktreePath: Schema.String,
  updatedAt: Schema.String,
});

const RemoveRelationshipRequestSchema = Schema.Struct({
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
});

function toSqlOrDecodeError(operation: string) {
  return (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const makeThreadRelationshipRegistry = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ThreadRelationshipRowDbSchema,
    execute: (row) =>
      sql`
        INSERT INTO thread_relationships (
          id,
          parent_thread_id,
          child_thread_id,
          child_linear_session_id,
          child_issue_identifier,
          child_worktree_path,
          relationship_type,
          last_resumed_child_turn_id,
          attached_at,
          created_at,
          updated_at
        ) VALUES (
          ${row.id},
          ${row.parentThreadId},
          ${row.childThreadId},
          ${row.childLinearSessionId},
          ${row.childIssueIdentifier},
          ${row.childWorktreePath},
          ${row.relationshipType},
          ${row.lastResumedChildTurnId},
          ${row.attachedAt},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (child_linear_session_id)
        DO UPDATE SET
          parent_thread_id = excluded.parent_thread_id,
          child_thread_id = COALESCE(excluded.child_thread_id, thread_relationships.child_thread_id),
          child_issue_identifier = COALESCE(excluded.child_issue_identifier, thread_relationships.child_issue_identifier),
          child_worktree_path = COALESCE(excluded.child_worktree_path, thread_relationships.child_worktree_path),
          relationship_type = excluded.relationship_type,
          last_resumed_child_turn_id = COALESCE(
            excluded.last_resumed_child_turn_id,
            thread_relationships.last_resumed_child_turn_id
          ),
          attached_at = COALESCE(excluded.attached_at, thread_relationships.attached_at),
          updated_at = excluded.updated_at
      `,
  });

  const findByParentThreadId = SqlSchema.findAll({
    Request: FindByParentRequestSchema,
    Result: ThreadRelationshipRowDbSchema,
    execute: ({ parentThreadId }) =>
      sql`
        SELECT
          id AS "id",
          parent_thread_id AS "parentThreadId",
          child_thread_id AS "childThreadId",
          child_linear_session_id AS "childLinearSessionId",
          child_issue_identifier AS "childIssueIdentifier",
          child_worktree_path AS "childWorktreePath",
          relationship_type AS "relationshipType",
          last_resumed_child_turn_id AS "lastResumedChildTurnId",
          attached_at AS "attachedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM thread_relationships
        WHERE parent_thread_id = ${parentThreadId}
        ORDER BY created_at ASC, id ASC
      `,
  });

  const findByChildThreadId = SqlSchema.findOneOption({
    Request: FindByChildRequestSchema,
    Result: ThreadRelationshipRowDbSchema,
    execute: ({ childThreadId }) =>
      sql`
        SELECT
          id AS "id",
          parent_thread_id AS "parentThreadId",
          child_thread_id AS "childThreadId",
          child_linear_session_id AS "childLinearSessionId",
          child_issue_identifier AS "childIssueIdentifier",
          child_worktree_path AS "childWorktreePath",
          relationship_type AS "relationshipType",
          last_resumed_child_turn_id AS "lastResumedChildTurnId",
          attached_at AS "attachedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM thread_relationships
        WHERE child_thread_id = ${childThreadId}
      `,
  });

  const findByLinearSession = SqlSchema.findOneOption({
    Request: FindByLinearSessionRequestSchema,
    Result: ThreadRelationshipRowDbSchema,
    execute: ({ childLinearSessionId }) =>
      sql`
        SELECT
          id AS "id",
          parent_thread_id AS "parentThreadId",
          child_thread_id AS "childThreadId",
          child_linear_session_id AS "childLinearSessionId",
          child_issue_identifier AS "childIssueIdentifier",
          child_worktree_path AS "childWorktreePath",
          relationship_type AS "relationshipType",
          last_resumed_child_turn_id AS "lastResumedChildTurnId",
          attached_at AS "attachedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM thread_relationships
        WHERE child_linear_session_id = ${childLinearSessionId}
      `,
  });

  const markResumedQuery = SqlSchema.void({
    Request: MarkResumedRequestSchema,
    execute: ({ childThreadId, childTurnId, updatedAt }) =>
      sql`
        UPDATE thread_relationships
        SET last_resumed_child_turn_id = ${childTurnId},
            updated_at = ${updatedAt}
        WHERE child_thread_id = ${childThreadId}
          AND (
            last_resumed_child_turn_id IS NULL
            OR last_resumed_child_turn_id != ${childTurnId}
          )
      `,
  });

  const updateChildWorktreeQuery = SqlSchema.void({
    Request: UpdateChildWorktreeRequestSchema,
    execute: ({ childThreadId, childWorktreePath, updatedAt }) =>
      sql`
        UPDATE thread_relationships
        SET child_worktree_path = ${childWorktreePath},
            updated_at = ${updatedAt}
        WHERE child_thread_id = ${childThreadId}
      `,
  });

  const removeRelationshipQuery = SqlSchema.void({
    Request: RemoveRelationshipRequestSchema,
    execute: ({ parentThreadId, childThreadId }) =>
      sql`
        DELETE FROM thread_relationships
        WHERE parent_thread_id = ${parentThreadId}
          AND child_thread_id = ${childThreadId}
      `,
  });

  const registerFromMcp: ThreadRelationshipRegistryShape["registerFromMcp"] = (input) =>
    upsertRow({
      id: input.id,
      parentThreadId: input.parentThreadId,
      childThreadId: null,
      childLinearSessionId: input.childLinearSessionId,
      childIssueIdentifier: input.childIssueIdentifier?.trim() || null,
      childWorktreePath: null,
      relationshipType: "delegated-task",
      lastResumedChildTurnId: null,
      attachedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }).pipe(Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.registerFromMcp")));

  const attachChildThread: ThreadRelationshipRegistryShape["attachChildThread"] = (input) =>
    findByLinearSession({ childLinearSessionId: input.childLinearSessionId }).pipe(
      Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.attachChildThread")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.void,
          onSome: (row) =>
            upsertRow({
              ...row,
              childThreadId: input.childThreadId,
              childIssueIdentifier: input.childIssueIdentifier?.trim() || row.childIssueIdentifier,
              childWorktreePath: input.childWorktreePath?.trim() || row.childWorktreePath,
              attachedAt: input.attachedAt,
              updatedAt: input.attachedAt,
            }).pipe(
              Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.attachChildThread")),
            ),
        }),
      ),
    );

  const listChildren: ThreadRelationshipRegistryShape["listChildren"] = (parentThreadId) =>
    findByParentThreadId({ parentThreadId }).pipe(
      Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.listChildren")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ThreadRelationshipRegistry.listChildren:row"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const findParent: ThreadRelationshipRegistryShape["findParent"] = (childThreadId) =>
    findByChildThreadId({ childThreadId }).pipe(
      Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.findParent")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ThreadRelationshipRegistry.findParent:row"),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const findParentByLinearSession: ThreadRelationshipRegistryShape["findParentByLinearSession"] = (
    childLinearSessionId,
  ) =>
    findByLinearSession({ childLinearSessionId }).pipe(
      Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.findParentByLinearSession")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ThreadRelationshipRegistry.findParentByLinearSession:row",
                ),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const markResumed: ThreadRelationshipRegistryShape["markResumed"] = (
    childThreadId,
    childTurnId,
  ) =>
    Effect.gen(function* () {
      const existing = yield* findParent(childThreadId);
      if (Option.isNone(existing) || existing.value.lastResumedChildTurnId === childTurnId) {
        return false;
      }

      yield* markResumedQuery({
        childThreadId,
        childTurnId,
        updatedAt: new Date().toISOString(),
      }).pipe(Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.markResumed")));
      return true;
    });

  const updateChildWorktree: ThreadRelationshipRegistryShape["updateChildWorktree"] = (
    childThreadId,
    childWorktreePath,
  ) =>
    updateChildWorktreeQuery({
      childThreadId,
      childWorktreePath,
      updatedAt: new Date().toISOString(),
    }).pipe(Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.updateChildWorktree")));

  const remove: ThreadRelationshipRegistryShape["remove"] = (parentThreadId, childThreadId) =>
    removeRelationshipQuery({ parentThreadId, childThreadId }).pipe(
      Effect.mapError(toSqlOrDecodeError("ThreadRelationshipRegistry.remove")),
    );

  return {
    registerFromMcp,
    attachChildThread,
    listChildren,
    findParent,
    findParentByLinearSession,
    markResumed,
    updateChildWorktree,
    remove,
  } satisfies ThreadRelationshipRegistryShape;
});

export const ThreadRelationshipRegistryLive = Layer.effect(
  ThreadRelationshipRegistry,
  makeThreadRelationshipRegistry,
);
