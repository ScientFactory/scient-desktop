/** Durable, secret-free authority state for production-dark external integrations. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_external_integrations (
      integration_hash TEXT PRIMARY KEY,
      credential_reference_hash TEXT NOT NULL,
      pairing_token_hash TEXT,
      peer_identity_hash TEXT NOT NULL,
      pairing_state TEXT NOT NULL CHECK (pairing_state IN ('pending', 'paired', 'revoked')),
      authority_generation INTEGER NOT NULL DEFAULT 1 CHECK (authority_generation > 0),
      rate_limit_max INTEGER NOT NULL CHECK (rate_limit_max BETWEEN 1 AND 1000),
      rate_limit_window_ms INTEGER NOT NULL CHECK (rate_limit_window_ms BETWEEN 1000 AND 86400000),
      rate_window_started_at INTEGER NOT NULL,
      rate_window_count INTEGER NOT NULL DEFAULT 0 CHECK (rate_window_count >= 0),
      created_at INTEGER NOT NULL,
      paired_at INTEGER,
      revoked_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK (
        length(integration_hash) = 74 AND substr(integration_hash, 1, 10) = 'sha256:v1:'
          AND substr(integration_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(credential_reference_hash) = 74 AND substr(credential_reference_hash, 1, 10) = 'sha256:v1:'
          AND substr(credential_reference_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(peer_identity_hash) = 74 AND substr(peer_identity_hash, 1, 10) = 'sha256:v1:'
          AND substr(peer_identity_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND (pairing_token_hash IS NULL OR (
            length(pairing_token_hash) = 74 AND substr(pairing_token_hash, 1, 10) = 'sha256:v1:'
              AND substr(pairing_token_hash, 11) NOT GLOB '*[^0-9a-f]*'
          ))
      ),
      CHECK (
        (pairing_state = 'pending' AND pairing_token_hash IS NOT NULL AND paired_at IS NULL AND revoked_at IS NULL)
        OR (pairing_state = 'paired' AND pairing_token_hash IS NULL AND paired_at IS NOT NULL AND revoked_at IS NULL)
        OR (pairing_state = 'revoked' AND pairing_token_hash IS NULL AND revoked_at IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_external_integration_projects (
      integration_hash TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      PRIMARY KEY (integration_hash, project_hash),
      FOREIGN KEY (integration_hash) REFERENCES scient_external_integrations(integration_hash) ON DELETE CASCADE,
      CHECK (length(project_hash) = 74 AND substr(project_hash, 1, 10) = 'sha256:v1:' AND substr(project_hash, 11) NOT GLOB '*[^0-9a-f]*')
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_external_integration_threads (
      integration_hash TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      thread_hash TEXT NOT NULL,
      PRIMARY KEY (integration_hash, project_hash, thread_hash),
      FOREIGN KEY (integration_hash, project_hash)
        REFERENCES scient_external_integration_projects(integration_hash, project_hash) ON DELETE CASCADE,
      CHECK (length(thread_hash) = 74 AND substr(thread_hash, 1, 10) = 'sha256:v1:' AND substr(thread_hash, 11) NOT GLOB '*[^0-9a-f]*')
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_external_integration_capabilities (
      integration_hash TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('project:context:read', 'thread:list', 'thread:read')),
      PRIMARY KEY (integration_hash, capability),
      FOREIGN KEY (integration_hash) REFERENCES scient_external_integrations(integration_hash) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_external_integration_security_events (
      event_id TEXT PRIMARY KEY,
      integration_hash TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'paired', 'admission', 'release', 'revoked')),
      outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'recorded')),
      reason_code TEXT NOT NULL,
      operation TEXT,
      project_hash TEXT,
      thread_hash TEXT,
      occurred_at INTEGER NOT NULL,
      FOREIGN KEY (integration_hash) REFERENCES scient_external_integrations(integration_hash) ON DELETE CASCADE,
      CHECK (project_hash IS NULL OR (length(project_hash) = 74 AND substr(project_hash, 1, 10) = 'sha256:v1:' AND substr(project_hash, 11) NOT GLOB '*[^0-9a-f]*')),
      CHECK (thread_hash IS NULL OR (length(thread_hash) = 74 AND substr(thread_hash, 1, 10) = 'sha256:v1:' AND substr(thread_hash, 11) NOT GLOB '*[^0-9a-f]*'))
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_external_events_integration_time
    ON scient_external_integration_security_events(integration_hash, occurred_at, event_id)
  `;
});
