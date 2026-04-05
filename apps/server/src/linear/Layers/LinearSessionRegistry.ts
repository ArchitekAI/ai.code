import { LinearSessionRow, ThreadId } from "@t3tools/contracts";
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
  LinearSessionRegistry,
  type LinearSessionRegistryShape,
} from "../Services/LinearSessionRegistry.ts";

const LinearSessionRowDbSchema = LinearSessionRow;
const decodeRow = Schema.decodeUnknownEffect(LinearSessionRow);

const GetBySessionIdRequestSchema = Schema.Struct({
  linearSessionId: Schema.String,
});

const GetByThreadIdRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const GetByIssueIdRequestSchema = Schema.Struct({
  issueId: Schema.String,
});

function toSqlOrDecodeError(operation: string) {
  return (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const makeLinearSessionRegistry = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: LinearSessionRowDbSchema,
    execute: (row) =>
      sql`
        INSERT INTO linear_sessions (
          linear_session_id,
          thread_id,
          project_id,
          issue_id,
          issue_identifier,
          created_at
        ) VALUES (
          ${row.linearSessionId},
          ${row.threadId},
          ${row.projectId},
          ${row.issueId},
          ${row.issueIdentifier},
          ${row.createdAt}
        )
        ON CONFLICT (linear_session_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          project_id = excluded.project_id,
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          created_at = excluded.created_at
      `,
  });

  const findBySessionId = SqlSchema.findOneOption({
    Request: GetBySessionIdRequestSchema,
    Result: LinearSessionRowDbSchema,
    execute: ({ linearSessionId }) =>
      sql`
        SELECT
          linear_session_id AS "linearSessionId",
          thread_id AS "threadId",
          project_id AS "projectId",
          issue_id AS "issueId",
          issue_identifier AS "issueIdentifier",
          created_at AS "createdAt"
        FROM linear_sessions
        WHERE linear_session_id = ${linearSessionId}
      `,
  });

  const findByThreadId = SqlSchema.findAll({
    Request: GetByThreadIdRequestSchema,
    Result: LinearSessionRowDbSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          linear_session_id AS "linearSessionId",
          thread_id AS "threadId",
          project_id AS "projectId",
          issue_id AS "issueId",
          issue_identifier AS "issueIdentifier",
          created_at AS "createdAt"
        FROM linear_sessions
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, linear_session_id ASC
      `,
  });

  const findByIssueId = SqlSchema.findAll({
    Request: GetByIssueIdRequestSchema,
    Result: LinearSessionRowDbSchema,
    execute: ({ issueId }) =>
      sql`
        SELECT
          linear_session_id AS "linearSessionId",
          thread_id AS "threadId",
          project_id AS "projectId",
          issue_id AS "issueId",
          issue_identifier AS "issueIdentifier",
          created_at AS "createdAt"
        FROM linear_sessions
        WHERE issue_id = ${issueId}
        ORDER BY created_at ASC, linear_session_id ASC
      `,
  });

  const deleteBySessionId = SqlSchema.void({
    Request: GetBySessionIdRequestSchema,
    execute: ({ linearSessionId }) =>
      sql`
        DELETE FROM linear_sessions
        WHERE linear_session_id = ${linearSessionId}
      `,
  });

  const deleteByIssueId = SqlSchema.void({
    Request: GetByIssueIdRequestSchema,
    execute: ({ issueId }) =>
      sql`
        DELETE FROM linear_sessions
        WHERE issue_id = ${issueId}
      `,
  });

  const register: LinearSessionRegistryShape["register"] = (entry) =>
    upsertRow(entry).pipe(Effect.mapError(toSqlOrDecodeError("LinearSessionRegistry.register")));

  const lookupBySessionId: LinearSessionRegistryShape["lookupBySessionId"] = (linearSessionId) =>
    findBySessionId({ linearSessionId }).pipe(
      Effect.mapError(toSqlOrDecodeError("LinearSessionRegistry.lookupBySessionId")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("LinearSessionRegistry.lookupBySessionId:row"),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const listByThreadId: LinearSessionRegistryShape["listByThreadId"] = (threadId) =>
    findByThreadId({ threadId }).pipe(
      Effect.mapError(toSqlOrDecodeError("LinearSessionRegistry.listByThreadId")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRow(row).pipe(
              Effect.mapError(toPersistenceDecodeError("LinearSessionRegistry.listByThreadId:row")),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const listByIssueId: LinearSessionRegistryShape["listByIssueId"] = (issueId) =>
    findByIssueId({ issueId }).pipe(
      Effect.mapError(toSqlOrDecodeError("LinearSessionRegistry.listByIssueId")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRow(row).pipe(
              Effect.mapError(toPersistenceDecodeError("LinearSessionRegistry.listByIssueId:row")),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const remove: LinearSessionRegistryShape["remove"] = (linearSessionId) =>
    deleteBySessionId({ linearSessionId }).pipe(
      Effect.mapError(toPersistenceSqlError("LinearSessionRegistry.remove:query")),
    );

  const removeByIssueId: LinearSessionRegistryShape["removeByIssueId"] = (issueId) =>
    deleteByIssueId({ issueId }).pipe(
      Effect.mapError(toPersistenceSqlError("LinearSessionRegistry.removeByIssueId:query")),
    );

  return {
    register,
    lookupBySessionId,
    listByThreadId,
    listByIssueId,
    remove,
    removeByIssueId,
  } satisfies LinearSessionRegistryShape;
});

export const LinearSessionRegistryLive = Layer.effect(
  LinearSessionRegistry,
  makeLinearSessionRegistry,
);
