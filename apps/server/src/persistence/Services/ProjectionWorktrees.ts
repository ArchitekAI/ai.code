import { IsoDateTime, ProjectId, WorktreeId } from "@repo/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorktree = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  workspacePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  isRoot: Schema.Boolean,
  branchRenamePending: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionWorktree = typeof ProjectionWorktree.Type;

export const GetProjectionWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type GetProjectionWorktreeInput = typeof GetProjectionWorktreeInput.Type;

export const DeleteProjectionWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type DeleteProjectionWorktreeInput = typeof DeleteProjectionWorktreeInput.Type;

export const ListProjectionWorktreesByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionWorktreesByProjectInput =
  typeof ListProjectionWorktreesByProjectInput.Type;

export interface ProjectionWorktreeRepositoryShape {
  readonly upsert: (row: ProjectionWorktree) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionWorktreeInput,
  ) => Effect.Effect<Option.Option<ProjectionWorktree>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionWorktreesByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorktree>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionWorktree>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: DeleteProjectionWorktreeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionWorktreeRepository extends ServiceMap.Service<
  ProjectionWorktreeRepository,
  ProjectionWorktreeRepositoryShape
>()("t3/persistence/Services/ProjectionWorktrees/ProjectionWorktreeRepository") {}
