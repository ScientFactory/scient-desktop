import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_browser_history (
      profile_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      last_visited_at INTEGER NOT NULL,
      visit_count INTEGER NOT NULL,
      PRIMARY KEY (profile_id, url)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_browser_history_recent
    ON scient_browser_history (profile_id, last_visited_at DESC, url DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_browser_history_age
    ON scient_browser_history (last_visited_at)
  `;
});
