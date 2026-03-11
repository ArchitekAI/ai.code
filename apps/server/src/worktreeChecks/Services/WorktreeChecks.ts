import {
  type WorktreeChecksAddTodoInput,
  type WorktreeChecksAddTodoResult,
  type WorktreeChecksDeleteTodoInput,
  type WorktreeChecksDeleteTodoResult,
  type WorktreeChecksGetInput,
  type WorktreeChecksGetResult,
  type WorktreeChecksTodo,
  type WorktreeChecksUpdateTodoInput,
  type WorktreeChecksUpdateTodoResult,
} from "@repo/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { GitManagerServiceError } from "../../git/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { WorktreeChecksError } from "../Errors.ts";

export type WorktreeChecksServiceError =
  | GitManagerServiceError
  | ProjectionRepositoryError
  | WorktreeChecksError;

export interface WorktreeChecksShape {
  readonly get: (
    input: WorktreeChecksGetInput,
  ) => Effect.Effect<WorktreeChecksGetResult, WorktreeChecksServiceError>;
  readonly addTodo: (
    input: WorktreeChecksAddTodoInput,
  ) => Effect.Effect<WorktreeChecksAddTodoResult, WorktreeChecksServiceError>;
  readonly updateTodo: (
    input: WorktreeChecksUpdateTodoInput,
  ) => Effect.Effect<WorktreeChecksUpdateTodoResult, WorktreeChecksServiceError>;
  readonly deleteTodo: (
    input: WorktreeChecksDeleteTodoInput,
  ) => Effect.Effect<WorktreeChecksDeleteTodoResult, WorktreeChecksServiceError>;
  readonly listTodosByWorktreeId: (
    worktreeId: WorktreeChecksTodo["worktreeId"],
  ) => Effect.Effect<ReadonlyArray<WorktreeChecksTodo>, WorktreeChecksServiceError>;
}

export class WorktreeChecks extends ServiceMap.Service<WorktreeChecks, WorktreeChecksShape>()(
  "t3/worktreeChecks/Services/WorktreeChecks",
) {}
