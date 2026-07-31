/** Durable, redacted claims and terminal receipts for governed Scient operations. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_operation_claims (
      claim_key TEXT PRIMARY KEY,
      claim_key_version INTEGER NOT NULL CHECK (claim_key_version = 2),
      semantic_identity_hash TEXT NOT NULL,
      actor_scope_hash TEXT NOT NULL,
      attempt_sequence INTEGER NOT NULL DEFAULT 1,
      operation_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      project_id TEXT NOT NULL,
      grant_hash TEXT NOT NULL,
      authority_generation_hash TEXT NOT NULL,
      authority_id_hash TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('manual-user', 'provider-thread', 'external-integration', 'automation-run')
      ),
      actor_ref_hash TEXT NOT NULL,
      provider_thread_hash TEXT,
      provider TEXT,
      provider_turn_hash TEXT,
      automation_hash TEXT,
      automation_run_hash TEXT,
      integration_hash TEXT,
      manual_user_hash TEXT,
      parent_operation_hash TEXT,
      ingress TEXT NOT NULL,
      idempotency_mode TEXT NOT NULL CHECK (idempotency_mode IN ('unique', 'semantic')),
      payload_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'in_progress',
          'succeeded',
          'failed',
          'uncertain',
          'reconciled_succeeded',
          'reconciled_failed'
        )
      ),
      replay_result_json TEXT,
      error_code TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      receipt_sequence INTEGER NOT NULL DEFAULT 0,
      CHECK (
        length(authority_generation_hash) = 74 AND substr(authority_generation_hash, 1, 10) = 'sha256:v1:'
          AND substr(authority_generation_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(authority_id_hash) = 74 AND substr(authority_id_hash, 1, 10) = 'sha256:v1:'
          AND substr(authority_id_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(actor_ref_hash) = 74 AND substr(actor_ref_hash, 1, 10) = 'sha256:v1:'
          AND substr(actor_ref_hash, 11) NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (
        (provider_thread_hash IS NULL OR (length(provider_thread_hash) = 74 AND substr(provider_thread_hash, 1, 10) = 'sha256:v1:' AND substr(provider_thread_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (provider_turn_hash IS NULL OR (length(provider_turn_hash) = 74 AND substr(provider_turn_hash, 1, 10) = 'sha256:v1:' AND substr(provider_turn_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (automation_hash IS NULL OR (length(automation_hash) = 74 AND substr(automation_hash, 1, 10) = 'sha256:v1:' AND substr(automation_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (automation_run_hash IS NULL OR (length(automation_run_hash) = 74 AND substr(automation_run_hash, 1, 10) = 'sha256:v1:' AND substr(automation_run_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (integration_hash IS NULL OR (length(integration_hash) = 74 AND substr(integration_hash, 1, 10) = 'sha256:v1:' AND substr(integration_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (manual_user_hash IS NULL OR (length(manual_user_hash) = 74 AND substr(manual_user_hash, 1, 10) = 'sha256:v1:' AND substr(manual_user_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (parent_operation_hash IS NULL OR (length(parent_operation_hash) = 74 AND substr(parent_operation_hash, 1, 10) = 'sha256:v1:' AND substr(parent_operation_hash, 11) NOT GLOB '*[^0-9a-f]*'))
      ),
      CHECK (
        (actor_kind = 'provider-thread' AND provider_thread_hash IS NOT NULL AND provider IS NOT NULL
          AND actor_ref_hash = provider_thread_hash AND automation_hash IS NULL AND automation_run_hash IS NULL
          AND integration_hash IS NULL AND manual_user_hash IS NULL)
        OR (actor_kind = 'automation-run' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NOT NULL AND automation_run_hash IS NOT NULL AND actor_ref_hash = automation_hash
          AND integration_hash IS NULL AND manual_user_hash IS NULL)
        OR (actor_kind = 'external-integration' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NULL AND automation_run_hash IS NULL AND integration_hash IS NOT NULL
          AND actor_ref_hash = integration_hash AND manual_user_hash IS NULL)
        OR (actor_kind = 'manual-user' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NULL AND automation_run_hash IS NULL AND integration_hash IS NULL
          AND manual_user_hash IS NOT NULL AND actor_ref_hash = manual_user_hash)
      )
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_operation_attempt_receipts (
      operation_id TEXT PRIMARY KEY,
      claim_key TEXT NOT NULL,
      attempt_sequence INTEGER NOT NULL,
      operation TEXT NOT NULL,
      project_id TEXT NOT NULL,
      actor_scope_hash TEXT NOT NULL,
      grant_hash TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (
        decision IN ('acquired', 'replay-eligible', 'payload-conflict', 'uncertain')
      ),
      replay_release_status TEXT CHECK (
        replay_release_status IN ('pending', 'allowed', 'denied', 'unknown', 'reconstruction-failed')
      ),
      replay_release_error_code TEXT,
      attempt_owner_id TEXT NOT NULL,
      terminal_receipt_id TEXT,
      replay_of_receipt_id TEXT,
      actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('manual-user', 'provider-thread', 'external-integration', 'automation-run')
      ),
      ingress TEXT NOT NULL,
      parent_operation_hash TEXT,
      authority_id_hash TEXT NOT NULL,
      authority_generation_hash TEXT NOT NULL,
      actor_ref_hash TEXT NOT NULL,
      provider_thread_hash TEXT,
      provider TEXT,
      provider_turn_hash TEXT,
      automation_hash TEXT,
      automation_run_hash TEXT,
      integration_hash TEXT,
      manual_user_hash TEXT,
      received_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY (claim_key) REFERENCES scient_operation_claims(claim_key) ON DELETE CASCADE,
      UNIQUE (claim_key, attempt_sequence),
      CHECK (
        (decision = 'replay-eligible' AND replay_release_status IS NOT NULL)
        OR (decision != 'replay-eligible' AND replay_release_status IS NULL
          AND replay_release_error_code IS NULL)
      ),
      CHECK (
        (replay_release_status = 'pending' AND finished_at IS NULL
          AND replay_release_error_code IS NULL)
        OR (replay_release_status IN ('allowed', 'denied', 'unknown', 'reconstruction-failed')
          AND finished_at IS NOT NULL)
        OR replay_release_status IS NULL
      ),
      CHECK (
        (replay_release_status IS NULL AND replay_release_error_code IS NULL)
        OR (replay_release_status IN ('pending', 'allowed') AND replay_release_error_code IS NULL)
        OR (replay_release_status = 'denied' AND replay_release_error_code = 'replay_release_denied')
        OR (replay_release_status = 'unknown' AND replay_release_error_code = 'replay_release_audit_unknown')
        OR (replay_release_status = 'reconstruction-failed'
          AND replay_release_error_code IN ('replay_result_unavailable', 'replay_reconstruction_failed'))
      ),
      CHECK (
        length(authority_generation_hash) = 74 AND substr(authority_generation_hash, 1, 10) = 'sha256:v1:'
          AND substr(authority_generation_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(authority_id_hash) = 74 AND substr(authority_id_hash, 1, 10) = 'sha256:v1:'
          AND substr(authority_id_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(actor_ref_hash) = 74 AND substr(actor_ref_hash, 1, 10) = 'sha256:v1:'
          AND substr(actor_ref_hash, 11) NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (
        (provider_thread_hash IS NULL OR (length(provider_thread_hash) = 74 AND substr(provider_thread_hash, 1, 10) = 'sha256:v1:' AND substr(provider_thread_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (provider_turn_hash IS NULL OR (length(provider_turn_hash) = 74 AND substr(provider_turn_hash, 1, 10) = 'sha256:v1:' AND substr(provider_turn_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (automation_hash IS NULL OR (length(automation_hash) = 74 AND substr(automation_hash, 1, 10) = 'sha256:v1:' AND substr(automation_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (automation_run_hash IS NULL OR (length(automation_run_hash) = 74 AND substr(automation_run_hash, 1, 10) = 'sha256:v1:' AND substr(automation_run_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (integration_hash IS NULL OR (length(integration_hash) = 74 AND substr(integration_hash, 1, 10) = 'sha256:v1:' AND substr(integration_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (manual_user_hash IS NULL OR (length(manual_user_hash) = 74 AND substr(manual_user_hash, 1, 10) = 'sha256:v1:' AND substr(manual_user_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (parent_operation_hash IS NULL OR (length(parent_operation_hash) = 74 AND substr(parent_operation_hash, 1, 10) = 'sha256:v1:' AND substr(parent_operation_hash, 11) NOT GLOB '*[^0-9a-f]*'))
      ),
      CHECK (
        (actor_kind = 'provider-thread' AND provider_thread_hash IS NOT NULL AND provider IS NOT NULL
          AND actor_ref_hash = provider_thread_hash AND automation_hash IS NULL AND automation_run_hash IS NULL
          AND integration_hash IS NULL AND manual_user_hash IS NULL)
        OR (actor_kind = 'automation-run' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NOT NULL AND automation_run_hash IS NOT NULL AND actor_ref_hash = automation_hash
          AND integration_hash IS NULL AND manual_user_hash IS NULL)
        OR (actor_kind = 'external-integration' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NULL AND automation_run_hash IS NULL AND integration_hash IS NOT NULL
          AND actor_ref_hash = integration_hash AND manual_user_hash IS NULL)
        OR (actor_kind = 'manual-user' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NULL AND automation_run_hash IS NULL AND integration_hash IS NULL
          AND manual_user_hash IS NOT NULL AND actor_ref_hash = manual_user_hash)
      )
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_operation_intents (
      operation_id TEXT PRIMARY KEY,
      claim_key TEXT NOT NULL,
      effect_kind TEXT NOT NULL CHECK (effect_kind = 'orchestration-command'),
      effect_identity TEXT NOT NULL,
      expected_aggregate_kind TEXT NOT NULL CHECK (expected_aggregate_kind IN ('thread', 'project')),
      expected_aggregate_id TEXT NOT NULL,
      safe_replay_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (claim_key) REFERENCES scient_operation_claims(claim_key) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_operation_executor_owner (
      owner_key TEXT PRIMARY KEY CHECK (owner_key = 'executor'),
      owner_id TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_operation_receipts (
      receipt_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      claim_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      project_id TEXT NOT NULL,
      grant_hash TEXT NOT NULL,
      authority_generation_hash TEXT NOT NULL,
      authority_id_hash TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('manual-user', 'provider-thread', 'external-integration', 'automation-run')
      ),
      actor_ref_hash TEXT NOT NULL,
      provider_thread_hash TEXT,
      provider TEXT,
      provider_turn_hash TEXT,
      automation_hash TEXT,
      automation_run_hash TEXT,
      integration_hash TEXT,
      manual_user_hash TEXT,
      ingress TEXT NOT NULL,
      parent_operation_hash TEXT,
      receipt_sequence INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (
        outcome IN ('succeeded', 'failed', 'uncertain/reconciliation-required')
      ),
      error_code TEXT,
      effects_json TEXT NOT NULL,
      reconciles_receipt_id TEXT,
      FOREIGN KEY (claim_key) REFERENCES scient_operation_claims(claim_key) ON DELETE CASCADE,
      UNIQUE (claim_key, receipt_sequence),
      CHECK (
        length(authority_generation_hash) = 74 AND substr(authority_generation_hash, 1, 10) = 'sha256:v1:'
          AND substr(authority_generation_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(authority_id_hash) = 74 AND substr(authority_id_hash, 1, 10) = 'sha256:v1:'
          AND substr(authority_id_hash, 11) NOT GLOB '*[^0-9a-f]*'
          AND length(actor_ref_hash) = 74 AND substr(actor_ref_hash, 1, 10) = 'sha256:v1:'
          AND substr(actor_ref_hash, 11) NOT GLOB '*[^0-9a-f]*'
      ),
      CHECK (
        (provider_thread_hash IS NULL OR (length(provider_thread_hash) = 74 AND substr(provider_thread_hash, 1, 10) = 'sha256:v1:' AND substr(provider_thread_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (provider_turn_hash IS NULL OR (length(provider_turn_hash) = 74 AND substr(provider_turn_hash, 1, 10) = 'sha256:v1:' AND substr(provider_turn_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (automation_hash IS NULL OR (length(automation_hash) = 74 AND substr(automation_hash, 1, 10) = 'sha256:v1:' AND substr(automation_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (automation_run_hash IS NULL OR (length(automation_run_hash) = 74 AND substr(automation_run_hash, 1, 10) = 'sha256:v1:' AND substr(automation_run_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (integration_hash IS NULL OR (length(integration_hash) = 74 AND substr(integration_hash, 1, 10) = 'sha256:v1:' AND substr(integration_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (manual_user_hash IS NULL OR (length(manual_user_hash) = 74 AND substr(manual_user_hash, 1, 10) = 'sha256:v1:' AND substr(manual_user_hash, 11) NOT GLOB '*[^0-9a-f]*'))
        AND (parent_operation_hash IS NULL OR (length(parent_operation_hash) = 74 AND substr(parent_operation_hash, 1, 10) = 'sha256:v1:' AND substr(parent_operation_hash, 11) NOT GLOB '*[^0-9a-f]*'))
      ),
      CHECK (
        (actor_kind = 'provider-thread' AND provider_thread_hash IS NOT NULL AND provider IS NOT NULL
          AND actor_ref_hash = provider_thread_hash AND automation_hash IS NULL AND automation_run_hash IS NULL
          AND integration_hash IS NULL AND manual_user_hash IS NULL)
        OR (actor_kind = 'automation-run' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NOT NULL AND automation_run_hash IS NOT NULL AND actor_ref_hash = automation_hash
          AND integration_hash IS NULL AND manual_user_hash IS NULL)
        OR (actor_kind = 'external-integration' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NULL AND automation_run_hash IS NULL AND integration_hash IS NOT NULL
          AND actor_ref_hash = integration_hash AND manual_user_hash IS NULL)
        OR (actor_kind = 'manual-user' AND provider_thread_hash IS NULL AND provider IS NULL AND provider_turn_hash IS NULL
          AND automation_hash IS NULL AND automation_run_hash IS NULL AND integration_hash IS NULL
          AND manual_user_hash IS NOT NULL AND actor_ref_hash = manual_user_hash)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_operation_claims_retention
    ON scient_operation_claims(status, finished_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_operation_attempts_claim
    ON scient_operation_attempt_receipts(claim_key, attempt_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_operation_intents_claim
    ON scient_operation_intents(claim_key, operation_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_operation_receipts_claim
    ON scient_operation_receipts(claim_key, receipt_sequence)
  `;
});
