import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId } from "@repo/contracts";

import {
  normalizeWorktreeWorkspacePath,
  rootWorktreeIdForProject,
  secondaryWorktreeIdForProjectPath,
} from "../../orchestration/worktrees.ts";

interface ProjectRow {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface LegacyThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly model: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurnId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

function normalizeLegacyWorktreePath(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = normalizeWorktreeWorkspacePath(value);
  return normalized.length > 0 ? normalized : null;
}

function compareIsoDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectRows = yield* sql<ProjectRow>`
    SELECT
      project_id AS "projectId",
      workspace_root AS "workspaceRoot",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM projection_projects
    ORDER BY created_at ASC, project_id ASC
  `;

  const legacyThreadRows = yield* sql<LegacyThreadRow>`
    SELECT
      thread_id AS "threadId",
      project_id AS "projectId",
      title,
      model,
      runtime_mode AS "runtimeMode",
      interaction_mode AS "interactionMode",
      branch,
      worktree_path AS "worktreePath",
      latest_turn_id AS "latestTurnId",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM projection_threads
    ORDER BY created_at ASC, thread_id ASC
  `;

  yield* sql`ALTER TABLE projection_threads RENAME TO projection_threads_legacy`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_worktrees (
      worktree_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      branch TEXT,
      is_root INTEGER NOT NULL DEFAULT 0,
      branch_rename_pending INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktrees_project_id
    ON projection_worktrees(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktrees_project_branch
    ON projection_worktrees(project_id, branch)
  `;

  const latestRootBranchByProject = new Map<string, string | null>();
  const latestSecondaryBranchByLocation = new Map<string, string | null>();
  const sortedLiveRows = [...legacyThreadRows]
    .filter((row) => row.deletedAt === null)
    .toSorted(
      (left, right) =>
        compareIsoDescending(left.updatedAt, right.updatedAt) ||
        compareIsoDescending(left.createdAt, right.createdAt) ||
        left.threadId.localeCompare(right.threadId),
    );

  for (const row of sortedLiveRows) {
    const normalizedWorktreePath = normalizeLegacyWorktreePath(row.worktreePath);
    if (normalizedWorktreePath === null) {
      if (!latestRootBranchByProject.has(row.projectId)) {
        latestRootBranchByProject.set(row.projectId, row.branch);
      }
      continue;
    }
    const key = `${row.projectId}\u0000${normalizedWorktreePath}`;
    if (!latestSecondaryBranchByLocation.has(key)) {
      latestSecondaryBranchByLocation.set(key, row.branch);
    }
  }

  for (const project of projectRows) {
    const projectId = ProjectId.makeUnsafe(project.projectId);
    yield* sql`
      INSERT INTO projection_worktrees (
        worktree_id,
        project_id,
        workspace_path,
        branch,
        is_root,
        branch_rename_pending,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${rootWorktreeIdForProject(projectId)},
        ${project.projectId},
        ${normalizeWorktreeWorkspacePath(project.workspaceRoot)},
        ${latestRootBranchByProject.get(project.projectId) ?? null},
        1,
        0,
        ${project.createdAt},
        ${project.updatedAt},
        ${project.deletedAt}
      )
    `;
  }

  const insertedSecondaryWorktreeKeys = new Set<string>();
  for (const row of legacyThreadRows) {
    const normalizedWorktreePath = normalizeLegacyWorktreePath(row.worktreePath);
    if (normalizedWorktreePath === null) {
      continue;
    }

    const locationKey = `${row.projectId}\u0000${normalizedWorktreePath}`;
    if (insertedSecondaryWorktreeKeys.has(locationKey)) {
      continue;
    }
    insertedSecondaryWorktreeKeys.add(locationKey);

    const projectId = ProjectId.makeUnsafe(row.projectId);
    yield* sql`
      INSERT INTO projection_worktrees (
        worktree_id,
        project_id,
        workspace_path,
        branch,
        is_root,
        branch_rename_pending,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${secondaryWorktreeIdForProjectPath({
          projectId,
          workspacePath: normalizedWorktreePath,
        })},
        ${row.projectId},
        ${normalizedWorktreePath},
        ${latestSecondaryBranchByLocation.get(locationKey) ?? null},
        0,
        0,
        ${row.createdAt},
        ${row.updatedAt},
        ${row.deletedAt}
      )
    `;
  }

  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_worktree_id
    ON projection_threads(worktree_id)
  `;

  for (const row of legacyThreadRows) {
    const projectId = ProjectId.makeUnsafe(row.projectId);
    const normalizedWorktreePath = normalizeLegacyWorktreePath(row.worktreePath);
    const worktreeId =
      normalizedWorktreePath === null
        ? rootWorktreeIdForProject(projectId)
        : secondaryWorktreeIdForProjectPath({
            projectId,
            workspacePath: normalizedWorktreePath,
          });

    yield* sql`
      INSERT INTO projection_threads (
        thread_id,
        worktree_id,
        title,
        model,
        runtime_mode,
        interaction_mode,
        latest_turn_id,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${row.threadId},
        ${worktreeId},
        ${row.title},
        ${row.model},
        ${row.runtimeMode},
        ${row.interactionMode},
        ${row.latestTurnId},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.deletedAt}
      )
    `;
  }

  yield* sql`DROP TABLE projection_threads_legacy`;
});
