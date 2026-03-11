import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectionWorktreeColumns = yield* sql<{ name: string }>`
    SELECT name
    FROM pragma_table_info('projection_worktrees')
  `;
  if (!projectionWorktreeColumns.some((column) => column.name === "archived_at")) {
    yield* sql`
      ALTER TABLE projection_worktrees
      ADD COLUMN archived_at TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_archive_metadata (
      worktree_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repo_cwd TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      branch TEXT,
      head_commit TEXT NOT NULL,
      stash_ref TEXT,
      archived_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_worktree_archive_metadata_project_id
    ON worktree_archive_metadata(project_id)
  `;
});
