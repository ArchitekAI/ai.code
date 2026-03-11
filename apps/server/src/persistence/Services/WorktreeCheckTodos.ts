import { ProjectId, WorktreeChecksTodo, WorktreeId } from "@repo/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const UpsertWorktreeCheckTodoInput = WorktreeChecksTodo;
export type UpsertWorktreeCheckTodoInput = typeof UpsertWorktreeCheckTodoInput.Type;

export const GetWorktreeCheckTodoInput = Schema.Struct({
  worktreeId: WorktreeId,
  todoId: Schema.String,
});
export type GetWorktreeCheckTodoInput = typeof GetWorktreeCheckTodoInput.Type;

export const ListWorktreeCheckTodosInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type ListWorktreeCheckTodosInput = typeof ListWorktreeCheckTodosInput.Type;

export const DeleteWorktreeCheckTodoInput = GetWorktreeCheckTodoInput;
export type DeleteWorktreeCheckTodoInput = typeof DeleteWorktreeCheckTodoInput.Type;

export const DeleteWorktreeCheckTodosByWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type DeleteWorktreeCheckTodosByWorktreeInput =
  typeof DeleteWorktreeCheckTodosByWorktreeInput.Type;

export const DeleteWorktreeCheckTodosByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteWorktreeCheckTodosByProjectInput =
  typeof DeleteWorktreeCheckTodosByProjectInput.Type;

export interface WorktreeCheckTodoRepositoryShape {
  readonly upsert: (
    row: UpsertWorktreeCheckTodoInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetWorktreeCheckTodoInput,
  ) => Effect.Effect<Option.Option<WorktreeChecksTodo>, ProjectionRepositoryError>;
  readonly listByWorktreeId: (
    input: ListWorktreeCheckTodosInput,
  ) => Effect.Effect<ReadonlyArray<WorktreeChecksTodo>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteWorktreeCheckTodoInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByWorktreeId: (
    input: DeleteWorktreeCheckTodosByWorktreeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByProjectId: (
    input: DeleteWorktreeCheckTodosByProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class WorktreeCheckTodoRepository extends ServiceMap.Service<
  WorktreeCheckTodoRepository,
  WorktreeCheckTodoRepositoryShape
>()("t3/persistence/Services/WorktreeCheckTodos/WorktreeCheckTodoRepository") {}
