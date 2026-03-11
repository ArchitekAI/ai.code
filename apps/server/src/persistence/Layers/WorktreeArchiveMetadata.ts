import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteWorktreeArchiveMetadataByProjectInput,
  DeleteWorktreeArchiveMetadataInput,
  GetWorktreeArchiveMetadataInput,
  WorktreeArchiveMetadata,
  WorktreeArchiveMetadataRepository,
  type WorktreeArchiveMetadataRepositoryShape,
} from "../Services/WorktreeArchiveMetadata.ts";

const makeWorktreeArchiveMetadataRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: WorktreeArchiveMetadata,
    execute: (row) =>
      sql`
        INSERT INTO worktree_archive_metadata (
          worktree_id,
          project_id,
          repo_cwd,
          workspace_path,
          branch,
          head_commit,
          stash_ref,
          archived_at
        )
        VALUES (
          ${row.worktreeId},
          ${row.projectId},
          ${row.repoCwd},
          ${row.workspacePath},
          ${row.branch},
          ${row.headCommit},
          ${row.stashRef},
          ${row.archivedAt}
        )
        ON CONFLICT (worktree_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          repo_cwd = excluded.repo_cwd,
          workspace_path = excluded.workspace_path,
          branch = excluded.branch,
          head_commit = excluded.head_commit,
          stash_ref = excluded.stash_ref,
          archived_at = excluded.archived_at
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetWorktreeArchiveMetadataInput,
    Result: WorktreeArchiveMetadata,
    execute: ({ worktreeId }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          repo_cwd AS "repoCwd",
          workspace_path AS "workspacePath",
          branch,
          head_commit AS "headCommit",
          stash_ref AS "stashRef",
          archived_at AS "archivedAt"
        FROM worktree_archive_metadata
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteWorktreeArchiveMetadataInput,
    execute: ({ worktreeId }) =>
      sql`
        DELETE FROM worktree_archive_metadata
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const deleteRowsByProjectId = SqlSchema.void({
    Request: DeleteWorktreeArchiveMetadataByProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM worktree_archive_metadata
        WHERE project_id = ${projectId}
      `,
  });

  const upsert: WorktreeArchiveMetadataRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeArchiveMetadataRepository.upsert:query")),
    );

  const getById: WorktreeArchiveMetadataRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeArchiveMetadataRepository.getById:query")),
    );

  const deleteById: WorktreeArchiveMetadataRepositoryShape["deleteById"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("WorktreeArchiveMetadataRepository.deleteById:query")),
    );

  const deleteByProjectId: WorktreeArchiveMetadataRepositoryShape["deleteByProjectId"] = (input) =>
    deleteRowsByProjectId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("WorktreeArchiveMetadataRepository.deleteByProjectId:query"),
      ),
    );

  return {
    upsert,
    getById,
    deleteById,
    deleteByProjectId,
  } satisfies WorktreeArchiveMetadataRepositoryShape;
});

export const WorktreeArchiveMetadataRepositoryLive = Layer.effect(
  WorktreeArchiveMetadataRepository,
  makeWorktreeArchiveMetadataRepository,
);
