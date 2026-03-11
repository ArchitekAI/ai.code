import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteWorktreeCheckTodoInput,
  DeleteWorktreeCheckTodosByProjectInput,
  DeleteWorktreeCheckTodosByWorktreeInput,
  GetWorktreeCheckTodoInput,
  ListWorktreeCheckTodosInput,
  UpsertWorktreeCheckTodoInput,
  WorktreeCheckTodoRepository,
  type WorktreeCheckTodoRepositoryShape,
} from "../Services/WorktreeCheckTodos.ts";
import { WorktreeChecksTodo } from "@repo/contracts";

const WorktreeChecksTodoDbRowSchema = WorktreeChecksTodo.mapFields(
  Struct.assign({
    completed: Schema.Number,
  }),
);

function toWorktreeChecksTodo(
  row: Schema.Schema.Type<typeof WorktreeChecksTodoDbRowSchema>,
): WorktreeChecksTodo {
  return {
    todoId: row.todoId,
    worktreeId: row.worktreeId,
    text: row.text,
    completed: row.completed !== 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeWorktreeCheckTodoRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertTodoRow = SqlSchema.void({
    Request: UpsertWorktreeCheckTodoInput,
    execute: (row) =>
      sql`
        INSERT INTO worktree_check_todos (
          todo_id,
          worktree_id,
          text,
          completed,
          created_at,
          updated_at
        )
        VALUES (
          ${row.todoId},
          ${row.worktreeId},
          ${row.text},
          ${row.completed ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (todo_id)
        DO UPDATE SET
          worktree_id = excluded.worktree_id,
          text = excluded.text,
          completed = excluded.completed,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getTodoRow = SqlSchema.findOneOption({
    Request: GetWorktreeCheckTodoInput,
    Result: WorktreeChecksTodoDbRowSchema,
    execute: ({ worktreeId, todoId }) =>
      sql`
        SELECT
          todo_id AS "todoId",
          worktree_id AS "worktreeId",
          text,
          CASE WHEN completed = 0 THEN 0 ELSE 1 END AS "completed",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM worktree_check_todos
        WHERE worktree_id = ${worktreeId}
          AND todo_id = ${todoId}
      `,
  });

  const listTodoRows = SqlSchema.findAll({
    Request: ListWorktreeCheckTodosInput,
    Result: WorktreeChecksTodoDbRowSchema,
    execute: ({ worktreeId }) =>
      sql`
        SELECT
          todo_id AS "todoId",
          worktree_id AS "worktreeId",
          text,
          CASE WHEN completed = 0 THEN 0 ELSE 1 END AS "completed",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM worktree_check_todos
        WHERE worktree_id = ${worktreeId}
        ORDER BY created_at ASC, todo_id ASC
      `,
  });

  const deleteTodoRow = SqlSchema.void({
    Request: DeleteWorktreeCheckTodoInput,
    execute: ({ worktreeId, todoId }) =>
      sql`
        DELETE FROM worktree_check_todos
        WHERE worktree_id = ${worktreeId}
          AND todo_id = ${todoId}
      `,
  });

  const deleteTodosByWorktreeRow = SqlSchema.void({
    Request: DeleteWorktreeCheckTodosByWorktreeInput,
    execute: ({ worktreeId }) =>
      sql`
        DELETE FROM worktree_check_todos
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const deleteTodosByProjectRow = SqlSchema.void({
    Request: DeleteWorktreeCheckTodosByProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM worktree_check_todos
        WHERE worktree_id IN (
          SELECT worktree_id
          FROM projection_worktrees
          WHERE project_id = ${projectId}
        )
      `,
  });

  const upsert: WorktreeCheckTodoRepositoryShape["upsert"] = (row) =>
    upsertTodoRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeCheckTodoRepository.upsert:query")),
    );

  const getById: WorktreeCheckTodoRepositoryShape["getById"] = (input) =>
    getTodoRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeCheckTodoRepository.getById:query")),
      Effect.map((row) => row.pipe(Option.map(toWorktreeChecksTodo))),
    );

  const listByWorktreeId: WorktreeCheckTodoRepositoryShape["listByWorktreeId"] = (input) =>
    listTodoRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeCheckTodoRepository.listByWorktreeId:query")),
      Effect.map((rows) => rows.map(toWorktreeChecksTodo)),
    );

  const deleteById: WorktreeCheckTodoRepositoryShape["deleteById"] = (input) =>
    deleteTodoRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeCheckTodoRepository.deleteById:query")),
    );

  const deleteByWorktreeId: WorktreeCheckTodoRepositoryShape["deleteByWorktreeId"] = (input) =>
    deleteTodosByWorktreeRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("WorktreeCheckTodoRepository.deleteByWorktreeId:query"),
      ),
    );

  const deleteByProjectId: WorktreeCheckTodoRepositoryShape["deleteByProjectId"] = (input) =>
    deleteTodosByProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeCheckTodoRepository.deleteByProjectId:query")),
    );

  return {
    upsert,
    getById,
    listByWorktreeId,
    deleteById,
    deleteByWorktreeId,
    deleteByProjectId,
  } satisfies WorktreeCheckTodoRepositoryShape;
});

export const WorktreeCheckTodoRepositoryLive = Layer.effect(
  WorktreeCheckTodoRepository,
  makeWorktreeCheckTodoRepository,
);
