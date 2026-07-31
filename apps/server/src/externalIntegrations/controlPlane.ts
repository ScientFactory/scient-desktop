/**
 * Secret-free, transport-independent authority for external read integrations.
 *
 * No network listener consumes this module. A future local transport must first
 * prove its peer through an OS-owned verifier, then present only the resulting
 * stable peer identity here. Provider sessions and provider MCP credentials are
 * deliberately outside this trust boundary.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeScientOperationAuthority,
  type ScientOperationAuthority,
  type ScientOperationCapability,
  type ScientOperationId,
} from "../scientOperations/authority.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

export const EXTERNAL_INTEGRATION_READ_CAPABILITIES = [
  "project:context:read",
  "thread:list",
  "thread:read",
] as const satisfies ReadonlyArray<ScientOperationCapability>;

export type ExternalIntegrationReadCapability =
  (typeof EXTERNAL_INTEGRATION_READ_CAPABILITIES)[number];
export type ExternalIntegrationPairingState = "pending" | "paired" | "revoked";

export type ExternalIntegrationControlErrorCode =
  | "invalid_configuration"
  | "integration_not_found"
  | "pairing_denied"
  | "pairing_expired"
  | "integration_not_paired"
  | "integration_revoked"
  | "credential_reference_mismatch"
  | "integration_access_denied"
  | "peer_identity_mismatch"
  | "project_scope_denied"
  | "thread_scope_denied"
  | "capability_denied"
  | "rate_limit_exceeded"
  | "stale_authority";

export class ExternalIntegrationControlError extends Schema.TaggedErrorClass<ExternalIntegrationControlError>()(
  "ExternalIntegrationControlError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

export interface ExternalIntegrationProjectScope {
  readonly projectId: string;
  /** Thread reads are always explicit; an empty list grants no thread body access. */
  readonly threadIds: ReadonlyArray<string>;
}

export interface CreateExternalIntegrationInput {
  readonly externalIdentity: string;
  readonly credentialReference: string;
  readonly peerIdentity: string;
  readonly projects: ReadonlyArray<ExternalIntegrationProjectScope>;
  readonly capabilities: ReadonlyArray<ExternalIntegrationReadCapability>;
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
}

export interface CompleteExternalIntegrationPairingInput {
  readonly externalIdentity: string;
  readonly pairingToken: string;
  readonly credentialReference: string;
  readonly peerIdentity: string;
}

export interface RecoverExternalIntegrationPairingInput {
  readonly externalIdentity: string;
  /** Owner-controlled durable reference; plaintext secret material is never accepted. */
  readonly credentialReference: string;
  readonly peerIdentity: string;
}

export interface ExternalIntegrationReadAdmissionInput {
  readonly externalIdentity: string;
  readonly credentialReference: string;
  /** Integration-owned secret returned once by successful pairing. */
  readonly accessToken: string;
  /** Stable identity emitted by a trusted OS-local peer verifier. */
  readonly verifiedPeerIdentity: string;
  readonly operation: Extract<
    ScientOperationId,
    "project.context.read" | "project.list" | "thread.list" | "thread.read"
  >;
  readonly projectId: string;
  readonly threadId?: string;
}

export interface ExternalIntegrationReadAdmission {
  readonly integrationHash: string;
  readonly credentialReferenceHash: string;
  readonly accessTokenHash: string;
  readonly peerIdentityHash: string;
  readonly authorityGeneration: number;
  readonly authority: ScientOperationAuthority;
  readonly projectHash: string;
  readonly threadHash: string | null;
  readonly scopedThreadHashes: ReadonlyArray<string>;
}

export interface ExternalIntegrationSecurityEvent {
  readonly eventId: string;
  readonly eventType: "created" | "paired" | "recovery" | "admission" | "release" | "revoked";
  readonly outcome: "allowed" | "denied" | "recorded";
  readonly reasonCode: string;
  readonly operation: string | null;
  readonly projectHash: string | null;
  readonly threadHash: string | null;
  readonly occurredAt: number;
}

export interface ExternalIntegrationSecurityEventPage {
  readonly events: ReadonlyArray<ExternalIntegrationSecurityEvent>;
  readonly nextCursor: string | null;
  /** Durable evidence that older repetitive events were compacted, not silently lost. */
  readonly retention: {
    readonly retainedLimit: number;
    readonly compactedCount: number;
    readonly compactedThrough: number | null;
  };
}

export interface ExternalIntegrationControlPlane {
  readonly createPending: (
    input: CreateExternalIntegrationInput,
  ) => Effect.Effect<
    { readonly integrationHash: string; readonly pairingToken: string },
    ExternalIntegrationControlError | PersistenceSqlError
  >;
  readonly completePairing: (
    input: CompleteExternalIntegrationPairingInput,
  ) => Effect.Effect<
    { readonly accessToken: string },
    ExternalIntegrationControlError | PersistenceSqlError
  >;
  /** Owner-only recovery seam. It is deliberately not exposed by the read adapter. */
  readonly beginRecoveryPairing: (
    input: RecoverExternalIntegrationPairingInput,
  ) => Effect.Effect<
    { readonly pairingToken: string; readonly authorityGeneration: number },
    ExternalIntegrationControlError | PersistenceSqlError
  >;
  readonly admitRead: (
    input: ExternalIntegrationReadAdmissionInput,
  ) => Effect.Effect<
    ExternalIntegrationReadAdmission,
    ExternalIntegrationControlError | PersistenceSqlError
  >;
  readonly releaseRead: (
    admission: ExternalIntegrationReadAdmission,
  ) => Effect.Effect<void, ExternalIntegrationControlError | PersistenceSqlError>;
  readonly revoke: (
    externalIdentity: string,
  ) => Effect.Effect<void, ExternalIntegrationControlError | PersistenceSqlError>;
  readonly listSecurityEvents: (
    externalIdentity: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ) => Effect.Effect<
    ExternalIntegrationSecurityEventPage,
    ExternalIntegrationControlError | PersistenceSqlError | PersistenceDecodeError
  >;
}

const operationCapability: Record<
  ExternalIntegrationReadAdmissionInput["operation"],
  ExternalIntegrationReadCapability
> = {
  "project.context.read": "project:context:read",
  "project.list": "project:context:read",
  "thread.list": "thread:list",
  "thread.read": "thread:read",
};

function hashField(tag: string, value: string): string {
  return `sha256:v1:${createHash("sha256")
    .update(JSON.stringify(["scient-external-integration-v1", tag, value]))
    .digest("hex")}`;
}

function constantTimeDigestEqual(left: string | null, right: string): boolean {
  if (left === null) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function externalIntegrationIdentityHash(value: string): string {
  return hashField("integration", value);
}

export function externalIntegrationProjectHash(value: string): string {
  return hashField("project", value);
}

export function externalIntegrationThreadHash(value: string): string {
  return hashField("thread", value);
}

function bounded(value: string, field: string, maxBytes = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value.trim(), "utf8") > maxBytes
  ) {
    throw controlError("invalid_configuration", `${field} must be a bounded non-empty string.`);
  }
  return value.trim();
}

function controlError(
  code: ExternalIntegrationControlErrorCode,
  message: string,
): ExternalIntegrationControlError {
  return new ExternalIntegrationControlError({ code, message });
}

function validatedEffect<A, E>(make: () => Effect.Effect<A, E>) {
  return Effect.suspend((): Effect.Effect<A, E | ExternalIntegrationControlError> => {
    try {
      return make();
    } catch (cause) {
      return Effect.fail(
        cause instanceof ExternalIntegrationControlError
          ? cause
          : controlError("invalid_configuration", "External integration input is invalid."),
      );
    }
  });
}

function sqlError(operation: string, cause: unknown): PersistenceSqlError {
  return new PersistenceSqlError({ operation, detail: `Failed to execute ${operation}`, cause });
}

interface IntegrationRow {
  readonly integrationHash: string;
  readonly credentialReferenceHash: string;
  readonly pairingTokenHash: string | null;
  readonly accessTokenHash: string | null;
  readonly pairingExpiresAt: number;
  readonly peerIdentityHash: string;
  readonly pairingState: ExternalIntegrationPairingState;
  readonly authorityGeneration: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly rateWindowStartedAt: number;
  readonly rateWindowCount: number;
  readonly pairedAt: number | null;
  readonly securityEventsCompactedCount: number;
  readonly securityEventsCompactedThrough: number | null;
}

const integrationSelect = (
  sql: SqlClient.SqlClient,
  integrationHash: string,
) => sql<IntegrationRow>`
  SELECT
    integration_hash AS "integrationHash",
    credential_reference_hash AS "credentialReferenceHash",
    pairing_token_hash AS "pairingTokenHash",
    integration_access_token_hash AS "accessTokenHash",
    pairing_expires_at AS "pairingExpiresAt",
    peer_identity_hash AS "peerIdentityHash",
    pairing_state AS "pairingState",
    authority_generation AS "authorityGeneration",
    rate_limit_max AS "rateLimitMax",
    rate_limit_window_ms AS "rateLimitWindowMs",
    rate_window_started_at AS "rateWindowStartedAt",
    rate_window_count AS "rateWindowCount",
    paired_at AS "pairedAt",
    security_events_compacted_count AS "securityEventsCompactedCount",
    security_events_compacted_through AS "securityEventsCompactedThrough"
  FROM scient_external_integrations
  WHERE integration_hash = ${integrationHash}
`;

function validateCreate(input: CreateExternalIntegrationInput) {
  const externalIdentity = bounded(input.externalIdentity, "externalIdentity");
  const credentialReference = bounded(input.credentialReference, "credentialReference", 1024);
  const peerIdentity = bounded(input.peerIdentity, "peerIdentity", 1024);
  if (
    !Number.isInteger(input.rateLimit.maxRequests) ||
    input.rateLimit.maxRequests < 1 ||
    input.rateLimit.maxRequests > 1000 ||
    !Number.isInteger(input.rateLimit.windowMs) ||
    input.rateLimit.windowMs < 1000 ||
    input.rateLimit.windowMs > 86_400_000
  ) {
    throw controlError("invalid_configuration", "Rate limit is outside the supported bounds.");
  }
  if (input.projects.length < 1 || input.projects.length > 100) {
    throw controlError("invalid_configuration", "One to 100 exact project scopes are required.");
  }
  const capabilities = [...new Set(input.capabilities)];
  if (
    capabilities.length < 1 ||
    capabilities.some(
      (capability) =>
        !EXTERNAL_INTEGRATION_READ_CAPABILITIES.includes(
          capability as ExternalIntegrationReadCapability,
        ),
    )
  ) {
    throw controlError("invalid_configuration", "Only bounded read capabilities may be granted.");
  }
  const projects = input.projects.map((scope) => ({
    projectId: bounded(scope.projectId, "projectId"),
    threadIds: [...new Set(scope.threadIds.map((id) => bounded(id, "threadId")))],
  }));
  if (new Set(projects.map(({ projectId }) => projectId)).size !== projects.length) {
    throw controlError("invalid_configuration", "Project scopes must be unique and exact.");
  }
  if (projects.some(({ threadIds }) => threadIds.length > 1000)) {
    throw controlError("invalid_configuration", "A project may scope at most 1000 exact threads.");
  }
  return { externalIdentity, credentialReference, peerIdentity, capabilities, projects };
}

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1_000;
export const EXTERNAL_INTEGRATION_SECURITY_EVENT_RETAINED_LIMIT = 1_024;
const EXTERNAL_INTEGRATION_SECURITY_EVENT_COMPACTION_TRIGGER = 1_152;
const EXTERNAL_INTEGRATION_SECURITY_EVENT_PAGE_MAX = 100;

function securityEventCursor(
  event: Pick<ExternalIntegrationSecurityEvent, "occurredAt" | "eventId">,
) {
  return Buffer.from(JSON.stringify([event.occurredAt, event.eventId]), "utf8").toString(
    "base64url",
  );
}

function parseSecurityEventCursor(cursor: string | undefined): {
  readonly occurredAt: number;
  readonly eventId: string;
} | null {
  if (cursor === undefined) return null;
  const boundedCursor = bounded(cursor, "cursor", 512);
  try {
    const decoded: unknown = JSON.parse(Buffer.from(boundedCursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      (decoded[0] as number) < 0 ||
      typeof decoded[1] !== "string" ||
      decoded[1].length < 1 ||
      Buffer.byteLength(decoded[1], "utf8") > 128
    ) {
      throw new Error("invalid cursor shape");
    }
    return { occurredAt: decoded[0] as number, eventId: decoded[1] };
  } catch {
    throw controlError("invalid_configuration", "Security event cursor is invalid.");
  }
}

export function makeExternalIntegrationControlPlane(options?: { readonly now?: () => number }) {
  const now = options?.now ?? Date.now;
  const randomToken = () => randomBytes(32).toString("base64url");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /**
     * Append and compact in the caller's transaction. Compaction preserves the
     * creation receipt, the newest pairing/recovery/revocation receipts, and the
     * newest remaining events. Durable counters retain evidence of the removed
     * repetitive history without allowing an unbounded local database.
     */
    const recordSecurityEvent = (event: {
      readonly integrationHash: string;
      readonly eventType: ExternalIntegrationSecurityEvent["eventType"];
      readonly outcome: ExternalIntegrationSecurityEvent["outcome"];
      readonly reasonCode: string;
      readonly operation?: string | null;
      readonly projectHash?: string | null;
      readonly threadHash?: string | null;
      readonly occurredAt: number;
    }) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO scient_external_integration_security_events (
            event_id, integration_hash, event_type, outcome, reason_code,
            operation, project_hash, thread_hash, occurred_at
          ) VALUES (
            ${randomUUID()}, ${event.integrationHash}, ${event.eventType}, ${event.outcome},
            ${event.reasonCode}, ${event.operation ?? null}, ${event.projectHash ?? null},
            ${event.threadHash ?? null}, ${event.occurredAt}
          )
        `;
        const count = Number(
          (yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM scient_external_integration_security_events
              WHERE integration_hash = ${event.integrationHash}
            `)[0]?.count ?? 0,
        );
        if (count <= EXTERNAL_INTEGRATION_SECURITY_EVENT_COMPACTION_TRIGGER) return;
        const compacted = yield* sql<{ readonly occurredAt: number }>`
          WITH retained AS (
            SELECT candidate.event_id
            FROM scient_external_integration_security_events AS candidate
            WHERE candidate.integration_hash = ${event.integrationHash}
            ORDER BY
              CASE
                WHEN candidate.event_type = 'created' THEN 0
                WHEN candidate.event_type IN ('paired', 'recovery', 'revoked')
                  AND candidate.event_id = (
                    SELECT lifecycle.event_id
                    FROM scient_external_integration_security_events AS lifecycle
                    WHERE lifecycle.integration_hash = candidate.integration_hash
                      AND lifecycle.event_type = candidate.event_type
                    ORDER BY lifecycle.occurred_at DESC, lifecycle.event_id DESC
                    LIMIT 1
                  ) THEN 0
                ELSE 1
              END,
              candidate.occurred_at DESC,
              candidate.event_id DESC
            LIMIT ${EXTERNAL_INTEGRATION_SECURITY_EVENT_RETAINED_LIMIT}
          )
          DELETE FROM scient_external_integration_security_events
          WHERE integration_hash = ${event.integrationHash}
            AND event_id NOT IN (SELECT event_id FROM retained)
          RETURNING occurred_at AS "occurredAt"
        `;
        if (compacted.length > 0) {
          const compactedThrough = Math.max(...compacted.map(({ occurredAt }) => occurredAt));
          yield* sql`
            UPDATE scient_external_integrations
            SET security_events_compacted_count = security_events_compacted_count + ${compacted.length},
                security_events_compacted_through = CASE
                  WHEN security_events_compacted_through IS NULL
                    OR security_events_compacted_through < ${compactedThrough}
                  THEN ${compactedThrough}
                  ELSE security_events_compacted_through
                END
            WHERE integration_hash = ${event.integrationHash}
          `;
        }
      });

    const createPending: ExternalIntegrationControlPlane["createPending"] = (input) =>
      Effect.try({
        try: () => validateCreate(input),
        catch: (cause) =>
          cause instanceof ExternalIntegrationControlError
            ? cause
            : controlError(
                "invalid_configuration",
                "External integration configuration is invalid.",
              ),
      }).pipe(
        Effect.flatMap((validated) => {
          const createdAt = now();
          const integrationHash = externalIntegrationIdentityHash(validated.externalIdentity);
          const credentialReferenceHash = hashField(
            "credential-reference",
            validated.credentialReference,
          );
          const peerIdentityHash = hashField("peer", validated.peerIdentity);
          const pairingToken = randomToken();
          const pairingTokenHash = hashField("pairing-token", pairingToken);
          return sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                INSERT INTO scient_external_integrations (
                  integration_hash, credential_reference_hash, pairing_token_hash,
                  integration_access_token_hash, pairing_issued_at, pairing_expires_at,
                  peer_identity_hash, pairing_state, authority_generation,
                  rate_limit_max, rate_limit_window_ms, rate_window_started_at,
                  rate_window_count, created_at, updated_at
                ) VALUES (
                  ${integrationHash}, ${credentialReferenceHash}, ${pairingTokenHash},
                  NULL, ${createdAt}, ${createdAt + PAIRING_TOKEN_TTL_MS},
                  ${peerIdentityHash}, 'pending', 1,
                  ${input.rateLimit.maxRequests}, ${input.rateLimit.windowMs}, ${createdAt},
                  0, ${createdAt}, ${createdAt}
                )
              `;
                for (const project of validated.projects) {
                  const projectHash = externalIntegrationProjectHash(project.projectId);
                  yield* sql`
                  INSERT INTO scient_external_integration_projects (integration_hash, project_hash)
                  VALUES (${integrationHash}, ${projectHash})
                `;
                  for (const threadId of project.threadIds) {
                    yield* sql`
                    INSERT INTO scient_external_integration_threads (
                      integration_hash, project_hash, thread_hash
                    ) VALUES (
                      ${integrationHash}, ${projectHash}, ${externalIntegrationThreadHash(threadId)}
                    )
                  `;
                  }
                }
                for (const capability of validated.capabilities) {
                  yield* sql`
                  INSERT INTO scient_external_integration_capabilities (integration_hash, capability)
                  VALUES (${integrationHash}, ${capability})
                `;
                }
                yield* recordSecurityEvent({
                  integrationHash,
                  eventType: "created",
                  outcome: "recorded",
                  reasonCode: "pending_pairing",
                  occurredAt: createdAt,
                });
                return { integrationHash, pairingToken } as const;
              }),
            )
            .pipe(Effect.mapError((cause) => sqlError("ExternalIntegration.createPending", cause)));
        }),
      );

    const completePairing: ExternalIntegrationControlPlane["completePairing"] = (input) =>
      validatedEffect(() => {
        const integrationHash = externalIntegrationIdentityHash(
          bounded(input.externalIdentity, "externalIdentity"),
        );
        const tokenHash = hashField("pairing-token", bounded(input.pairingToken, "pairingToken"));
        const credentialHash = hashField(
          "credential-reference",
          bounded(input.credentialReference, "credentialReference", 1024),
        );
        const peerHash = hashField("peer", bounded(input.peerIdentity, "peerIdentity", 1024));
        const pairedAt = now();
        const accessToken = randomToken();
        const accessTokenHash = hashField("integration-access-token", accessToken);
        return sql
          .withTransaction(
            Effect.gen(function* () {
              const row = (yield* integrationSelect(sql, integrationHash))[0];
              if (
                row === undefined ||
                row.pairingState !== "pending" ||
                pairedAt >= row.pairingExpiresAt ||
                !constantTimeDigestEqual(row.pairingTokenHash, tokenHash) ||
                row.credentialReferenceHash !== credentialHash ||
                row.peerIdentityHash !== peerHash
              ) {
                return yield* controlError(
                  row !== undefined && pairedAt >= row.pairingExpiresAt
                    ? "pairing_expired"
                    : "pairing_denied",
                  "Pairing proof was rejected.",
                );
              }
              yield* sql`
            UPDATE scient_external_integrations
            SET pairing_state = 'paired', pairing_token_hash = NULL,
                integration_access_token_hash = ${accessTokenHash},
                paired_at = ${pairedAt}, updated_at = ${pairedAt}
            WHERE integration_hash = ${integrationHash} AND pairing_state = 'pending'
          `;
              yield* recordSecurityEvent({
                integrationHash,
                eventType: "paired",
                outcome: "recorded",
                reasonCode: "owner_pairing_completed",
                occurredAt: pairedAt,
              });
              return { accessToken } as const;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof ExternalIntegrationControlError
                ? cause
                : sqlError("ExternalIntegration.completePairing", cause),
            ),
          );
      });

    const beginRecoveryPairing: ExternalIntegrationControlPlane["beginRecoveryPairing"] = (input) =>
      validatedEffect(() => {
        const integrationHash = externalIntegrationIdentityHash(
          bounded(input.externalIdentity, "externalIdentity"),
        );
        const credentialReferenceHash = hashField(
          "credential-reference",
          bounded(input.credentialReference, "credentialReference", 1024),
        );
        const peerIdentityHash = hashField(
          "peer",
          bounded(input.peerIdentity, "peerIdentity", 1024),
        );
        const pairingToken = randomToken();
        const pairingTokenHash = hashField("pairing-token", pairingToken);
        const issuedAt = now();
        return sql
          .withTransaction(
            Effect.gen(function* () {
              const row = (yield* integrationSelect(sql, integrationHash))[0];
              if (
                row === undefined ||
                row.credentialReferenceHash !== credentialReferenceHash ||
                row.peerIdentityHash !== peerIdentityHash
              ) {
                return yield* controlError("pairing_denied", "Owner recovery proof was rejected.");
              }
              if (row.pairingState === "revoked") {
                return yield* controlError(
                  "integration_revoked",
                  "A revoked integration cannot be recovered or re-paired.",
                );
              }
              const authorityGeneration = row.authorityGeneration + 1;
              yield* sql`
                UPDATE scient_external_integrations
                SET pairing_state = 'pending', pairing_token_hash = ${pairingTokenHash},
                    integration_access_token_hash = NULL,
                    pairing_issued_at = ${issuedAt},
                    pairing_expires_at = ${issuedAt + PAIRING_TOKEN_TTL_MS},
                    authority_generation = ${authorityGeneration},
                    rate_window_started_at = ${issuedAt}, rate_window_count = 0,
                    paired_at = NULL, revoked_at = NULL, updated_at = ${issuedAt}
                WHERE integration_hash = ${integrationHash}
              `;
              yield* recordSecurityEvent({
                integrationHash,
                eventType: "recovery",
                outcome: "recorded",
                reasonCode: "owner_recovery_started",
                occurredAt: issuedAt,
              });
              return { pairingToken, authorityGeneration } as const;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof ExternalIntegrationControlError
                ? cause
                : sqlError("ExternalIntegration.beginRecoveryPairing", cause),
            ),
          );
      });

    const admitRead: ExternalIntegrationControlPlane["admitRead"] = (input) =>
      validatedEffect(() => {
        const integrationHash = externalIntegrationIdentityHash(
          bounded(input.externalIdentity, "externalIdentity"),
        );
        const credentialReferenceHash = hashField(
          "credential-reference",
          bounded(input.credentialReference, "credentialReference", 1024),
        );
        const accessTokenHash = hashField(
          "integration-access-token",
          bounded(input.accessToken, "accessToken", 1024),
        );
        const peerIdentityHash = hashField(
          "peer",
          bounded(input.verifiedPeerIdentity, "verifiedPeerIdentity", 1024),
        );
        const projectId = bounded(input.projectId, "projectId");
        const projectHash = externalIntegrationProjectHash(projectId);
        const threadHash =
          input.threadId === undefined
            ? null
            : externalIntegrationThreadHash(bounded(input.threadId, "threadId"));
        const admittedAt = now();
        const capability = operationCapability[input.operation];

        return sql
          .withTransaction(
            Effect.gen(function* () {
              const row = (yield* integrationSelect(sql, integrationHash))[0];
              let denial: ExternalIntegrationControlError | null = null;
              if (row === undefined) {
                denial = controlError(
                  "integration_not_found",
                  "External integration was not found.",
                );
              } else if (row.pairingState === "revoked") {
                denial = controlError("integration_revoked", "External integration is revoked.");
              } else if (row.pairingState !== "paired") {
                denial = controlError(
                  "integration_not_paired",
                  "External integration is not paired.",
                );
              } else if (row.credentialReferenceHash !== credentialReferenceHash) {
                denial = controlError(
                  "credential_reference_mismatch",
                  "Credential reference does not match this integration.",
                );
              } else if (!constantTimeDigestEqual(row.accessTokenHash, accessTokenHash)) {
                denial = controlError(
                  "integration_access_denied",
                  "Integration access proof was rejected.",
                );
              } else if (row.peerIdentityHash !== peerIdentityHash) {
                denial = controlError(
                  "peer_identity_mismatch",
                  "Verified local peer does not match this integration.",
                );
              }

              const projects =
                row === undefined
                  ? []
                  : yield* sql<{ readonly projectHash: string }>`
                  SELECT project_hash AS "projectHash"
                  FROM scient_external_integration_projects
                  WHERE integration_hash = ${integrationHash}
                `;
              const capabilities =
                row === undefined
                  ? []
                  : yield* sql<{ readonly capability: ExternalIntegrationReadCapability }>`
                  SELECT capability
                  FROM scient_external_integration_capabilities
                  WHERE integration_hash = ${integrationHash}
                `;
              const threads =
                row === undefined
                  ? []
                  : yield* sql<{ readonly threadHash: string }>`
                  SELECT thread_hash AS "threadHash"
                  FROM scient_external_integration_threads
                  WHERE integration_hash = ${integrationHash} AND project_hash = ${projectHash}
                  ORDER BY thread_hash
                `;
              if (denial === null && !projects.some((entry) => entry.projectHash === projectHash)) {
                denial = controlError(
                  "project_scope_denied",
                  "Project is outside the exact grant.",
                );
              }
              if (
                denial === null &&
                threadHash !== null &&
                !threads.some((entry) => entry.threadHash === threadHash)
              ) {
                denial = controlError("thread_scope_denied", "Thread is outside the exact grant.");
              }
              if (
                denial === null &&
                !capabilities.some((entry) => entry.capability === capability)
              ) {
                denial = controlError("capability_denied", "Read capability is not granted.");
              }

              let nextWindowStart = row?.rateWindowStartedAt ?? admittedAt;
              let nextCount = row?.rateWindowCount ?? 0;
              if (
                row !== undefined &&
                admittedAt - row.rateWindowStartedAt >= row.rateLimitWindowMs
              ) {
                nextWindowStart = admittedAt;
                nextCount = 0;
              }
              if (denial === null && row !== undefined && nextCount >= row.rateLimitMax) {
                denial = controlError(
                  "rate_limit_exceeded",
                  "External integration rate limit exceeded.",
                );
              }
              if (denial === null && row !== undefined) {
                nextCount += 1;
                yield* sql`
              UPDATE scient_external_integrations
              SET rate_window_started_at = ${nextWindowStart}, rate_window_count = ${nextCount},
                  updated_at = ${admittedAt}
              WHERE integration_hash = ${integrationHash}
            `;
              }
              if (row !== undefined) {
                yield* recordSecurityEvent({
                  integrationHash,
                  eventType: "admission",
                  outcome: denial === null ? "allowed" : "denied",
                  reasonCode: denial?.code ?? "authority_current",
                  operation: input.operation,
                  projectHash,
                  threadHash,
                  occurredAt: admittedAt,
                });
              }
              if (denial !== null || row === undefined) return { denial } as const;
              const authority = makeScientOperationAuthority({
                authorityId: `external.${integrationHash.slice(10)}`,
                generation: `external.${row.authorityGeneration}`,
                actor: { kind: "external-integration", integrationId: integrationHash },
                projectIds: [projectId],
                capabilities: capabilities.map(({ capability: granted }) => granted),
                issuedAt: row.pairedAt ?? admittedAt,
                expiresAt: null,
                revokedAt: null,
              });
              return {
                denial: null,
                admission: {
                  integrationHash,
                  credentialReferenceHash,
                  accessTokenHash,
                  peerIdentityHash,
                  authorityGeneration: row.authorityGeneration,
                  authority,
                  projectHash,
                  threadHash,
                  scopedThreadHashes: threads.map(({ threadHash: hash }) => hash),
                } satisfies ExternalIntegrationReadAdmission,
              } as const;
            }),
          )
          .pipe(
            Effect.mapError((cause) => sqlError("ExternalIntegration.admitRead", cause)),
            Effect.flatMap((decision) =>
              "admission" in decision
                ? Effect.succeed(decision.admission)
                : Effect.fail(
                    decision.denial ??
                      controlError("integration_not_found", "External integration was not found."),
                  ),
            ),
          );
      });

    const releaseRead: ExternalIntegrationControlPlane["releaseRead"] = (admission) => {
      const releasedAt = now();
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const row = (yield* integrationSelect(sql, admission.integrationHash))[0];
            const current =
              row !== undefined &&
              row.pairingState === "paired" &&
              row.authorityGeneration === admission.authorityGeneration &&
              row.credentialReferenceHash === admission.credentialReferenceHash &&
              constantTimeDigestEqual(row.accessTokenHash, admission.accessTokenHash) &&
              row.peerIdentityHash === admission.peerIdentityHash;
            if (row !== undefined) {
              yield* recordSecurityEvent({
                integrationHash: admission.integrationHash,
                eventType: "release",
                outcome: current ? "allowed" : "denied",
                reasonCode: current ? "authority_current" : "stale_authority",
                projectHash: admission.projectHash,
                threadHash: admission.threadHash,
                occurredAt: releasedAt,
              });
            }
            return current;
          }),
        )
        .pipe(
          Effect.mapError((cause) => sqlError("ExternalIntegration.releaseRead", cause)),
          Effect.flatMap((current) =>
            current
              ? Effect.void
              : Effect.fail(
                  controlError(
                    "stale_authority",
                    "External integration authority is no longer current.",
                  ),
                ),
          ),
        );
    };

    const revoke: ExternalIntegrationControlPlane["revoke"] = (externalIdentity) =>
      validatedEffect(() => {
        const revokedAt = now();
        const integrationHash = externalIntegrationIdentityHash(
          bounded(externalIdentity, "externalIdentity"),
        );
        return sql
          .withTransaction(
            Effect.gen(function* () {
              const row = (yield* integrationSelect(sql, integrationHash))[0];
              if (row === undefined) {
                return yield* controlError(
                  "integration_not_found",
                  "External integration was not found.",
                );
              }
              if (row.pairingState !== "revoked") {
                yield* sql`
              UPDATE scient_external_integrations
              SET pairing_state = 'revoked', pairing_token_hash = NULL,
                  integration_access_token_hash = NULL,
                  authority_generation = authority_generation + 1,
                  revoked_at = ${revokedAt}, updated_at = ${revokedAt}
              WHERE integration_hash = ${integrationHash}
            `;
                yield* recordSecurityEvent({
                  integrationHash,
                  eventType: "revoked",
                  outcome: "recorded",
                  reasonCode: "owner_revoked",
                  occurredAt: revokedAt,
                });
              }
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof ExternalIntegrationControlError
                ? cause
                : sqlError("ExternalIntegration.revoke", cause),
            ),
          );
      });

    const listSecurityEvents: ExternalIntegrationControlPlane["listSecurityEvents"] = (
      externalIdentity,
      options,
    ) =>
      validatedEffect(() => {
        const integrationHash = externalIntegrationIdentityHash(
          bounded(externalIdentity, "externalIdentity"),
        );
        if (
          options?.limit !== undefined &&
          (!Number.isInteger(options.limit) ||
            options.limit < 1 ||
            options.limit > EXTERNAL_INTEGRATION_SECURITY_EVENT_PAGE_MAX)
        ) {
          throw controlError(
            "invalid_configuration",
            `Security event limit must be between 1 and ${EXTERNAL_INTEGRATION_SECURITY_EVENT_PAGE_MAX}.`,
          );
        }
        const limit = options?.limit ?? 50;
        const cursor = parseSecurityEventCursor(options?.cursor);
        return Effect.gen(function* () {
          const integration = (yield* integrationSelect(sql, integrationHash))[0];
          if (integration === undefined) {
            return yield* controlError(
              "integration_not_found",
              "External integration was not found.",
            );
          }
          const rows =
            cursor === null
              ? yield* sql<ExternalIntegrationSecurityEvent>`
                  SELECT
                    event_id AS "eventId", event_type AS "eventType", outcome,
                    reason_code AS "reasonCode", operation,
                    project_hash AS "projectHash", thread_hash AS "threadHash",
                    occurred_at AS "occurredAt"
                  FROM scient_external_integration_security_events
                  WHERE integration_hash = ${integrationHash}
                  ORDER BY occurred_at, event_id
                  LIMIT ${limit + 1}
                `
              : yield* sql<ExternalIntegrationSecurityEvent>`
                  SELECT
                    event_id AS "eventId", event_type AS "eventType", outcome,
                    reason_code AS "reasonCode", operation,
                    project_hash AS "projectHash", thread_hash AS "threadHash",
                    occurred_at AS "occurredAt"
                  FROM scient_external_integration_security_events
                  WHERE integration_hash = ${integrationHash}
                    AND (
                      occurred_at > ${cursor.occurredAt}
                      OR (occurred_at = ${cursor.occurredAt} AND event_id > ${cursor.eventId})
                    )
                  ORDER BY occurred_at, event_id
                  LIMIT ${limit + 1}
                `;
          const events = rows.slice(0, limit);
          return {
            events,
            nextCursor:
              rows.length > limit && events.length > 0
                ? securityEventCursor(events[events.length - 1]!)
                : null,
            retention: {
              retainedLimit: EXTERNAL_INTEGRATION_SECURITY_EVENT_RETAINED_LIMIT,
              compactedCount: integration.securityEventsCompactedCount,
              compactedThrough: integration.securityEventsCompactedThrough,
            },
          } satisfies ExternalIntegrationSecurityEventPage;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof ExternalIntegrationControlError
              ? cause
              : sqlError("ExternalIntegration.listSecurityEvents", cause),
          ),
        );
      });

    return {
      createPending,
      completePairing,
      beginRecoveryPairing,
      admitRead,
      releaseRead,
      revoke,
      listSecurityEvents,
    } satisfies ExternalIntegrationControlPlane;
  });
}
