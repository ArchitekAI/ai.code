import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionWorktreeInput,
  GetProjectionWorktreeInput,
  ListProjectionWorktreesByProjectInput,
  ProjectionWorktree,
  ProjectionWorktreeRepository,
  type ProjectionWorktreeRepositoryShape,
} from "../Services/ProjectionWorktrees.ts";

const ProjectionWorktreeDbRowSchema = ProjectionWorktree.mapFields(
  Struct.assign({
    isRoot: Schema.Number,
    branchRenamePending: Schema.Number,
  }),
);

const toProjectionWorktree = (
  row: Schema.Schema.Type<typeof ProjectionWorktreeDbRowSchema>,
): ProjectionWorktree => ({
  worktreeId: row.worktreeId,
  projectId: row.projectId,
  workspacePath: row.workspacePath,
  branch: row.branch,
  isRoot: row.isRoot === 1,
  branchRenamePending: row.branchRenamePending === 1,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  archivedAt: row.archivedAt,
  deletedAt: row.deletedAt,
});

const makeProjectionWorktreeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorktreeRow = SqlSchema.void({
    Request: ProjectionWorktree,
    execute: (row) =>
      sql`
        INSERT INTO projection_worktrees (
          worktree_id,
          project_id,
          workspace_path,
          branch,
          is_root,
          branch_rename_pending,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${row.worktreeId},
          ${row.projectId},
          ${row.workspacePath},
          ${row.branch},
          ${row.isRoot ? 1 : 0},
          ${row.branchRenamePending ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (worktree_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          workspace_path = excluded.workspace_path,
          branch = excluded.branch,
          is_root = excluded.is_root,
          branch_rename_pending = excluded.branch_rename_pending,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionWorktreeRow = SqlSchema.findOneOption({
    Request: GetProjectionWorktreeInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ worktreeId }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          workspace_path AS "workspacePath",
          branch,
          CASE WHEN is_root = 0 THEN 0 ELSE 1 END AS "isRoot",
          CASE WHEN branch_rename_pending = 0 THEN 0 ELSE 1 END AS "branchRenamePending",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_worktrees
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const listProjectionWorktreeRows = SqlSchema.findAll({
    Request: ListProjectionWorktreesByProjectInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          workspace_path AS "workspacePath",
          branch,
          CASE WHEN is_root = 0 THEN 0 ELSE 1 END AS "isRoot",
          CASE WHEN branch_rename_pending = 0 THEN 0 ELSE 1 END AS "branchRenamePending",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_worktrees
        WHERE project_id = ${projectId}
        ORDER BY is_root DESC, created_at ASC, worktree_id ASC
      `,
  });

  const listAllProjectionWorktreeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorktreeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          workspace_path AS "workspacePath",
          branch,
          CASE WHEN is_root = 0 THEN 0 ELSE 1 END AS "isRoot",
          CASE WHEN branch_rename_pending = 0 THEN 0 ELSE 1 END AS "branchRenamePending",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_worktrees
        ORDER BY project_id ASC, is_root DESC, created_at ASC, worktree_id ASC
      `,
  });

  const deleteProjectionWorktreeRow = SqlSchema.void({
    Request: DeleteProjectionWorktreeInput,
    execute: ({ worktreeId }) =>
      sql`
        DELETE FROM projection_worktrees
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const upsert: ProjectionWorktreeRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorktreeRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.upsert:query")),
    );

  const getById: ProjectionWorktreeRepositoryShape["getById"] = (input) =>
    getProjectionWorktreeRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.getById:query")),
      Effect.map((row) => row.pipe(Option.map(toProjectionWorktree))),
    );

  const listByProjectId: ProjectionWorktreeRepositoryShape["listByProjectId"] = (input) =>
    listProjectionWorktreeRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.listByProjectId:query")),
      Effect.map((rows) => rows.map(toProjectionWorktree)),
    );

  const listAll: ProjectionWorktreeRepositoryShape["listAll"] = () =>
    listAllProjectionWorktreeRows(void 0).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.listAll:query")),
      Effect.map((rows) => rows.map(toProjectionWorktree)),
    );

  const deleteById: ProjectionWorktreeRepositoryShape["deleteById"] = (input) =>
    deleteProjectionWorktreeRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    listAll,
    deleteById,
  } satisfies ProjectionWorktreeRepositoryShape;
});

export const ProjectionWorktreeRepositoryLive = Layer.effect(
  ProjectionWorktreeRepository,
  makeProjectionWorktreeRepository,
);
