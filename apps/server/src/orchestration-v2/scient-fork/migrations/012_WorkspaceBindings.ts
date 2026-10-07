import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * App-private authority records for exact Scient workspace bindings.
 *
 * Portable `.scient/project.json` identities are deliberately not unique in
 * this table: trusted worktrees and independent clones may carry the same
 * logical project ID while retaining separate execution authority.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_workspace_bindings (
      binding_id TEXT PRIMARY KEY NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      environment_id TEXT NOT NULL,
      host_project_id TEXT NOT NULL,
      canonical_root TEXT NOT NULL,
      scient_project_id TEXT,
      repository_identity_json TEXT,
      worktree_identity_json TEXT,
      lineage_binding_id TEXT REFERENCES scient_workspace_bindings(binding_id)
        DEFERRABLE INITIALLY DEFERRED,
      trust_state TEXT NOT NULL CHECK (trust_state IN ('verified', 'unseen', 'ambiguous', 'revoked')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation >= 1),
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      superseded_by TEXT REFERENCES scient_workspace_bindings(binding_id)
        DEFERRABLE INITIALLY DEFERRED,
      CHECK (superseded_by IS NULL OR superseded_by <> binding_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS scient_workspace_bindings_active_authority
    ON scient_workspace_bindings(environment_id, host_project_id, canonical_root)
    WHERE superseded_by IS NULL
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS scient_workspace_bindings_active_root
    ON scient_workspace_bindings(environment_id, canonical_root)
    WHERE superseded_by IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS scient_workspace_bindings_logical_project
    ON scient_workspace_bindings(environment_id, scient_project_id, created_at, binding_id)
    WHERE scient_project_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS scient_workspace_bindings_lineage
    ON scient_workspace_bindings(lineage_binding_id)
    WHERE lineage_binding_id IS NOT NULL
  `;
});
