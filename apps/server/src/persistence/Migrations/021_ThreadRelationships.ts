import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_relationships (
      id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT,
      child_linear_session_id TEXT NOT NULL UNIQUE,
      child_issue_identifier TEXT,
      child_worktree_path TEXT,
      relationship_type TEXT NOT NULL DEFAULT 'delegated-task',
      last_resumed_child_turn_id TEXT,
      attached_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_relationships_parent
    ON thread_relationships(parent_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_relationships_child
    ON thread_relationships(child_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_relationships_child_session
    ON thread_relationships(child_linear_session_id)
  `;
});
