import { IsoDateTime, ProjectId, WorktreeId } from "@repo/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const WorktreeArchiveMetadata = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  repoCwd: Schema.String,
  workspacePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headCommit: Schema.String,
  stashRef: Schema.NullOr(Schema.String),
  archivedAt: IsoDateTime,
});
export type WorktreeArchiveMetadata = typeof WorktreeArchiveMetadata.Type;

export const GetWorktreeArchiveMetadataInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type GetWorktreeArchiveMetadataInput = typeof GetWorktreeArchiveMetadataInput.Type;

export const DeleteWorktreeArchiveMetadataInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type DeleteWorktreeArchiveMetadataInput = typeof DeleteWorktreeArchiveMetadataInput.Type;

export const DeleteWorktreeArchiveMetadataByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteWorktreeArchiveMetadataByProjectInput =
  typeof DeleteWorktreeArchiveMetadataByProjectInput.Type;

export interface WorktreeArchiveMetadataRepositoryShape {
  readonly upsert: (row: WorktreeArchiveMetadata) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetWorktreeArchiveMetadataInput,
  ) => Effect.Effect<Option.Option<WorktreeArchiveMetadata>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteWorktreeArchiveMetadataInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByProjectId: (
    input: DeleteWorktreeArchiveMetadataByProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class WorktreeArchiveMetadataRepository extends ServiceMap.Service<
  WorktreeArchiveMetadataRepository,
  WorktreeArchiveMetadataRepositoryShape
>()("t3/persistence/Services/WorktreeArchiveMetadata/WorktreeArchiveMetadataRepository") {}
