import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_sessions (
      linear_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linear_sessions_thread_id
    ON linear_sessions(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linear_sessions_issue_id
    ON linear_sessions(issue_id)
  `;
});
