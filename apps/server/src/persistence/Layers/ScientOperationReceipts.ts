import { createHash, randomUUID } from "node:crypto";

import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  ScientOperationEffectIdentity,
  ScientOperationRequestEnvelope,
  ScientOperationResultReceipt,
} from "../../scientOperations/authority.ts";
import { PersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ScientOperationReceiptRepository,
  type ScientOperationDurableIntent,
  type ScientOperationPersistedReceipt,
  type ScientOperationReceiptAttribution,
  type ScientOperationReceiptRepositoryShape,
  type ScientOperationSafeReplay,
} from "../Services/ScientOperationReceipts.ts";

const MAX_REPLAY_RESULT_BYTES = 16 * 1024;
const MAX_EFFECTS_BYTES = 32 * 1024;

type ClaimStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "reconciled_succeeded"
  | "reconciled_failed";

interface ClaimRow {
  readonly claimKey: string;
  readonly claimKeyVersion: number;
  readonly semanticIdentityHash: string;
  readonly actorScopeHash: string;
  readonly attemptSequence: number;
  readonly operationId: string;
  readonly ownerId: string;
  readonly operation: string;
  readonly projectId: string;
  readonly grantHash: string;
  readonly authorityGenerationHash: string;
  readonly authorityIdHash: string;
  readonly actorKind: string;
  readonly actorRefHash: string;
  readonly providerThreadHash: string | null;
  readonly provider: string | null;
  readonly providerTurnHash: string | null;
  readonly automationHash: string | null;
  readonly automationRunHash: string | null;
  readonly integrationHash: string | null;
  readonly manualUserHash: string | null;
  readonly ingress: string;
  readonly parentOperationHash: string | null;
  readonly payloadFingerprint: string;
  readonly status: string;
  readonly replayResultJson: string | null;
  readonly errorCode: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly receiptSequence: number;
}

interface ReceiptRow {
  readonly receiptId: string;
  readonly operationId: string;
  readonly claimKey: string;
  readonly operation: string;
  readonly projectId: string;
  readonly grantHash: string;
  readonly authorityGenerationHash: string;
  readonly authorityIdHash: string;
  readonly actorKind: string;
  readonly actorRefHash: string;
  readonly providerThreadHash: string | null;
  readonly provider: string | null;
  readonly providerTurnHash: string | null;
  readonly automationHash: string | null;
  readonly automationRunHash: string | null;
  readonly integrationHash: string | null;
  readonly manualUserHash: string | null;
  readonly ingress: string;
  readonly parentOperationHash: string | null;
  readonly receiptSequence: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly effectsJson: string;
  readonly reconcilesReceiptId: string | null;
}

interface IntentRow {
  readonly operationId: string;
  readonly claimKey: string;
  readonly effectKind: string;
  readonly effectIdentity: string;
  readonly expectedAggregateKind: string;
  readonly expectedAggregateId: string;
  readonly safeReplayJson: string;
}

function decodeError(operation: string, issue: string, cause?: unknown) {
  return new PersistenceDecodeError({
    operation,
    issue,
    ...(cause === undefined ? {} : { cause }),
  });
}

function claimStatus(value: string): ClaimStatus {
  switch (value) {
    case "in_progress":
    case "succeeded":
    case "failed":
    case "uncertain":
    case "reconciled_succeeded":
    case "reconciled_failed":
      return value;
    default:
      throw decodeError("ScientOperationReceipts.decodeClaim", `Unknown claim status: ${value}`);
  }
}

function validateReplay(value: unknown): ScientOperationSafeReplay {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { readonly kind?: unknown }).kind !== "thread.message.send.v1" ||
    typeof (value as { readonly threadId?: unknown }).threadId !== "string" ||
    !["queue", "steer"].includes(String((value as { readonly dispatched?: unknown }).dispatched))
  ) {
    throw decodeError(
      "ScientOperationReceipts.validateReplay",
      "Replay data does not match an approved operation-specific schema.",
    );
  }
  const replay = value as ScientOperationSafeReplay;
  if (replay.threadId.length === 0 || Buffer.byteLength(replay.threadId, "utf8") > 512) {
    throw decodeError(
      "ScientOperationReceipts.validateReplay",
      "Replay thread identity is invalid.",
    );
  }
  return Object.freeze({
    kind: replay.kind,
    threadId: replay.threadId,
    dispatched: replay.dispatched,
  });
}

function encodeBoundedJson(
  value: unknown | null,
  operation: string,
  maxBytes: number,
): string | null {
  if (value === null) return null;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw decodeError(operation, "Value is not JSON serializable.", cause);
  }
  if (encoded === undefined) throw decodeError(operation, "Value is not JSON serializable.");
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw decodeError(operation, `JSON value exceeds the ${maxBytes}-byte persistence limit.`);
  }
  return encoded;
}

function encodeReplay(value: ScientOperationSafeReplay | null, operation: string): string | null {
  return value === null
    ? null
    : encodeBoundedJson(validateReplay(value), operation, MAX_REPLAY_RESULT_BYTES);
}

function decodeStoredJson(value: string | null, operation: string): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw decodeError(operation, "Stored JSON is invalid.", cause);
  }
}

function decodeReplay(value: string | null, operation: string): ScientOperationSafeReplay | null {
  const decoded = decodeStoredJson(value, operation);
  return decoded === null ? null : validateReplay(decoded);
}

function hashIdentity(identity: string): string {
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

/**
 * Domain-separated pseudonym used only for persisted local operation attribution.
 * If low-entropy actor identifiers are ever exported, replace this with a
 * per-install HMAC; an unkeyed digest is correlation-safe, not anonymization.
 */
export function scientOperationAttributionHash(tag: string, ...parts: ReadonlyArray<string>) {
  const canonical = JSON.stringify(["scient-operation-attribution-v1", tag, ...parts]);
  return `sha256:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

function attributionForEnvelope(
  envelope: ScientOperationRequestEnvelope,
): ScientOperationReceiptAttribution {
  const actor = envelope.authority.actor;
  const base = {
    actorKind: actor.kind,
    ingress: envelope.ingress,
    parentOperationHash:
      envelope.parentOperationId === null
        ? null
        : scientOperationAttributionHash("operation-id", envelope.parentOperationId),
    authorityIdHash: scientOperationAttributionHash("authority-id", envelope.authority.authorityId),
    providerThreadHash: null,
    provider: null,
    providerTurnHash: null,
    automationHash: null,
    automationRunHash: null,
    integrationHash: null,
    manualUserHash: null,
  } satisfies Omit<ScientOperationReceiptAttribution, "actorRefHash">;
  switch (actor.kind) {
    case "provider-thread": {
      const providerThreadHash = scientOperationAttributionHash(
        "provider-thread",
        actor.provider,
        actor.threadId,
      );
      const providerTurnHash =
        envelope.providerAuthorizingTurnId === null
          ? null
          : scientOperationAttributionHash(
              "provider-turn",
              actor.provider,
              actor.threadId,
              envelope.providerAuthorizingTurnId,
            );
      return {
        ...base,
        actorRefHash: providerThreadHash,
        providerThreadHash,
        provider: actor.provider,
        providerTurnHash,
      };
    }
    case "automation-run": {
      const automationHash = scientOperationAttributionHash("automation", actor.automationId);
      return {
        ...base,
        actorRefHash: automationHash,
        automationHash,
        automationRunHash: scientOperationAttributionHash(
          "automation-run",
          actor.automationId,
          actor.runId,
        ),
      };
    }
    case "external-integration": {
      const integrationHash = scientOperationAttributionHash("integration", actor.integrationId);
      return {
        ...base,
        actorRefHash: integrationHash,
        integrationHash,
      };
    }
    case "manual-user": {
      const manualUserHash = scientOperationAttributionHash("manual-user", actor.userId);
      return { ...base, actorRefHash: manualUserHash, manualUserHash };
    }
  }
}

function attributionFromClaimRow(row: ClaimRow): ScientOperationReceiptAttribution {
  return {
    actorKind: row.actorKind as ScientOperationReceiptAttribution["actorKind"],
    ingress: row.ingress as ScientOperationReceiptAttribution["ingress"],
    parentOperationHash: row.parentOperationHash,
    authorityIdHash: row.authorityIdHash,
    actorRefHash: row.actorRefHash,
    providerThreadHash: row.providerThreadHash,
    provider: row.provider,
    providerTurnHash: row.providerTurnHash,
    automationHash: row.automationHash,
    automationRunHash: row.automationRunHash,
    integrationHash: row.integrationHash,
    manualUserHash: row.manualUserHash,
  };
}

const EFFECT_KINDS = new Set<ScientOperationEffectIdentity["kind"]>([
  "orchestration-command",
  "record",
  "artifact",
  "external-effect",
]);

function validateEffect(value: unknown): ScientOperationEffectIdentity {
  if (typeof value !== "object" || value === null) {
    throw decodeError("ScientOperationReceipts.validateEffect", "Effect must be an object.");
  }
  const candidate = value as Partial<ScientOperationEffectIdentity>;
  if (
    typeof candidate.kind !== "string" ||
    !EFFECT_KINDS.has(candidate.kind as ScientOperationEffectIdentity["kind"]) ||
    typeof candidate.identity !== "string" ||
    candidate.identity.length === 0 ||
    Buffer.byteLength(candidate.identity, "utf8") > 1024 ||
    (candidate.contentHash !== undefined &&
      (typeof candidate.contentHash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(candidate.contentHash)))
  ) {
    throw decodeError(
      "ScientOperationReceipts.validateEffect",
      "Effect identity does not match the durable receipt schema.",
    );
  }
  if (
    candidate.kind === "orchestration-command" &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(candidate.identity)
  ) {
    throw decodeError(
      "ScientOperationReceipts.validateEffect",
      "Orchestration command identity must be a structured command ID, not free text or a path.",
    );
  }
  return {
    kind: candidate.kind as ScientOperationEffectIdentity["kind"],
    identity: candidate.identity,
    ...(candidate.contentHash === undefined ? {} : { contentHash: candidate.contentHash }),
  };
}

function validateIntent(
  intent: ScientOperationDurableIntent | null,
  envelope?: ScientOperationRequestEnvelope,
) {
  if (intent === null) return null;
  const keys = Object.keys(intent).toSorted();
  if (
    keys.length !== 4 ||
    keys[0] !== "effect" ||
    keys[1] !== "expectedAggregateId" ||
    keys[2] !== "expectedAggregateKind" ||
    keys[3] !== "replayResult"
  ) {
    throw decodeError(
      "ScientOperationReceipts.validateIntent",
      "Durable intent must contain exactly one effect, expected aggregate, and safe replay.",
    );
  }
  const effect = validateEffect(intent.effect);
  if (effect.kind !== "orchestration-command") {
    throw decodeError(
      "ScientOperationReceipts.validateIntent",
      "Only one typed orchestration command intent is supported.",
    );
  }
  if (
    (intent.expectedAggregateKind !== "thread" && intent.expectedAggregateKind !== "project") ||
    typeof intent.expectedAggregateId !== "string" ||
    intent.expectedAggregateId.length === 0 ||
    Buffer.byteLength(intent.expectedAggregateId, "utf8") > 512
  ) {
    throw decodeError(
      "ScientOperationReceipts.validateIntent",
      "Durable intent has an invalid expected aggregate.",
    );
  }
  const replay = validateReplay(intent.replayResult);
  if (
    intent.expectedAggregateKind !== "thread" ||
    replay.threadId !== intent.expectedAggregateId ||
    (envelope !== undefined &&
      effect.identity !== `scient-operation:v2:${envelope.idempotency.claimKey}:thread-send`)
  ) {
    throw decodeError(
      "ScientOperationReceipts.validateIntent",
      "Durable intent effect, aggregate, and replay do not describe one exact thread send.",
    );
  }
  return {
    effect: { ...effect, kind: "orchestration-command" as const },
    expectedAggregateKind: intent.expectedAggregateKind,
    expectedAggregateId: intent.expectedAggregateId,
    safeReplayJson: encodeReplay(replay, "ScientOperationReceipts.encodeIntentReplay")!,
  };
}

/**
 * Current wired effects are orchestration command IDs generated by Scient and
 * needed for reconciliation. Other effect identities may contain donor URLs,
 * paths, or external IDs, so persist only a one-way digest by default.
 */
function redactEffects(effects: ReadonlyArray<ScientOperationEffectIdentity>) {
  return effects.map((rawEffect) => {
    const effect = validateEffect(rawEffect);
    return {
      kind: effect.kind,
      identity:
        effect.kind === "orchestration-command" ? effect.identity : hashIdentity(effect.identity),
      ...(effect.contentHash === undefined ? {} : { contentHash: effect.contentHash }),
    };
  });
}

function decodeReceipt(row: ReceiptRow): ScientOperationPersistedReceipt {
  const effects = decodeStoredJson(row.effectsJson, "ScientOperationReceipts.decodeEffects");
  if (!Array.isArray(effects)) {
    throw decodeError("ScientOperationReceipts.decodeEffects", "Stored effects must be an array.");
  }
  if (
    row.outcome !== "succeeded" &&
    row.outcome !== "failed" &&
    row.outcome !== "uncertain/reconciliation-required"
  ) {
    throw decodeError(
      "ScientOperationReceipts.decodeReceipt",
      `Unknown receipt outcome: ${row.outcome}`,
    );
  }
  return Object.freeze({
    receiptId: row.receiptId,
    operationId: row.operationId,
    operation: row.operation as ScientOperationPersistedReceipt["operation"],
    projectId: row.projectId,
    grantHash: row.grantHash,
    authorityGenerationHash: row.authorityGenerationHash,
    authorization: "allowed",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    outcome: row.outcome,
    errorCode: row.errorCode,
    effects: Object.freeze(effects.map((effect) => Object.freeze(validateEffect(effect)))),
    claimKey: row.claimKey,
    receiptSequence: row.receiptSequence,
    reconcilesReceiptId: row.reconcilesReceiptId,
    attribution: Object.freeze({
      actorKind: row.actorKind as ScientOperationReceiptAttribution["actorKind"],
      ingress: row.ingress as ScientOperationReceiptAttribution["ingress"],
      parentOperationHash: row.parentOperationHash,
      authorityIdHash: row.authorityIdHash,
      actorRefHash: row.actorRefHash,
      providerThreadHash: row.providerThreadHash,
      provider: row.provider,
      providerTurnHash: row.providerTurnHash,
      automationHash: row.automationHash,
      automationRunHash: row.automationRunHash,
      integrationHash: row.integrationHash,
      manualUserHash: row.manualUserHash,
    }),
  });
}

function receiptValues(input: {
  readonly claimKey: string;
  readonly receipt: ScientOperationResultReceipt;
  readonly receiptSequence: number;
  readonly authorityGenerationHash: string;
  readonly attribution: ScientOperationReceiptAttribution;
  readonly effectsJson?: string;
  readonly reconcilesReceiptId?: string | null;
}) {
  return {
    receiptId: input.receipt.receiptId,
    operationId: input.receipt.operationId,
    operation: input.receipt.operation,
    projectId: input.receipt.projectId,
    grantHash: input.receipt.grantHash,
    authorityGenerationHash: input.authorityGenerationHash,
    receiptSequence: input.receiptSequence,
    ...input.attribution,
    startedAt: input.receipt.startedAt,
    finishedAt: input.receipt.finishedAt,
    outcome: input.receipt.outcome,
    errorCode: input.receipt.errorCode,
    claimKey: input.claimKey,
    effectsJson:
      input.effectsJson ??
      encodeBoundedJson(
        redactEffects(input.receipt.effects),
        "ScientOperationReceipts.encodeEffects",
        MAX_EFFECTS_BYTES,
      )!,
    reconcilesReceiptId: input.reconcilesReceiptId ?? null,
  };
}

export const makeScientOperationReceiptRepository = (options?: { readonly ownerId?: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ownerId = options?.ownerId ?? `scient-executor:${randomUUID()}`;

    const selectClaim = (claimKey: string) =>
      sql<ClaimRow>`
      SELECT
        claim_key AS "claimKey",
        claim_key_version AS "claimKeyVersion",
        semantic_identity_hash AS "semanticIdentityHash",
        actor_scope_hash AS "actorScopeHash",
        attempt_sequence AS "attemptSequence",
        operation_id AS "operationId",
        owner_id AS "ownerId",
        operation,
        project_id AS "projectId",
        grant_hash AS "grantHash",
        authority_generation_hash AS "authorityGenerationHash",
        authority_id_hash AS "authorityIdHash",
        actor_kind AS "actorKind",
        actor_ref_hash AS "actorRefHash",
        provider_thread_hash AS "providerThreadHash",
        provider,
        provider_turn_hash AS "providerTurnHash",
        automation_hash AS "automationHash",
        automation_run_hash AS "automationRunHash",
        integration_hash AS "integrationHash",
        manual_user_hash AS "manualUserHash",
        ingress,
        parent_operation_hash AS "parentOperationHash",
        payload_fingerprint AS "payloadFingerprint",
        status,
        replay_result_json AS "replayResultJson",
        error_code AS "errorCode",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        receipt_sequence AS "receiptSequence"
      FROM scient_operation_claims
      WHERE claim_key = ${claimKey}
    `;

    const selectLatestReceipt = (claimKey: string) =>
      sql<ReceiptRow>`
      SELECT
        receipt_id AS "receiptId",
        operation_id AS "operationId",
        claim_key AS "claimKey",
        operation,
        project_id AS "projectId",
        grant_hash AS "grantHash",
        authority_generation_hash AS "authorityGenerationHash",
        authority_id_hash AS "authorityIdHash",
        actor_kind AS "actorKind",
        actor_ref_hash AS "actorRefHash",
        provider_thread_hash AS "providerThreadHash",
        provider,
        provider_turn_hash AS "providerTurnHash",
        automation_hash AS "automationHash",
        automation_run_hash AS "automationRunHash",
        integration_hash AS "integrationHash",
        manual_user_hash AS "manualUserHash",
        ingress,
        parent_operation_hash AS "parentOperationHash",
        receipt_sequence AS "receiptSequence",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        outcome,
        error_code AS "errorCode",
        effects_json AS "effectsJson",
        reconciles_receipt_id AS "reconcilesReceiptId"
      FROM scient_operation_receipts
      WHERE claim_key = ${claimKey}
      ORDER BY receipt_sequence DESC
      LIMIT 1
    `;

    const insertReceipt = (input: ReturnType<typeof receiptValues>) =>
      sql`
      INSERT INTO scient_operation_receipts (
        receipt_id,
        operation_id,
        claim_key,
        operation,
        project_id,
        grant_hash,
        authority_generation_hash,
        authority_id_hash,
        actor_kind,
        actor_ref_hash,
        provider_thread_hash,
        provider,
        provider_turn_hash,
        automation_hash,
        automation_run_hash,
        integration_hash,
        manual_user_hash,
        ingress,
        parent_operation_hash,
        receipt_sequence,
        started_at,
        finished_at,
        outcome,
        error_code,
        effects_json,
        reconciles_receipt_id
      ) VALUES (
        ${input.receiptId},
        ${input.operationId},
        ${input.claimKey},
        ${input.operation},
        ${input.projectId},
        ${input.grantHash},
        ${input.authorityGenerationHash},
        ${input.authorityIdHash},
        ${input.actorKind},
        ${input.actorRefHash},
        ${input.providerThreadHash},
        ${input.provider},
        ${input.providerTurnHash},
        ${input.automationHash},
        ${input.automationRunHash},
        ${input.integrationHash},
        ${input.manualUserHash},
        ${input.ingress},
        ${input.parentOperationHash},
        ${input.receiptSequence},
        ${input.startedAt},
        ${input.finishedAt},
        ${input.outcome},
        ${input.errorCode},
        ${input.effectsJson},
        ${input.reconcilesReceiptId}
      )
    `;

    const insertAttempt = (input: {
      readonly envelope: ScientOperationRequestEnvelope;
      readonly attribution: ScientOperationReceiptAttribution;
      readonly attemptSequence: number;
      readonly decision: "acquired" | "replay-eligible" | "payload-conflict" | "uncertain";
      readonly replayOfReceiptId?: string | null;
    }) => sql`
      INSERT INTO scient_operation_attempt_receipts (
        operation_id, claim_key, attempt_sequence, operation, project_id,
        actor_scope_hash, grant_hash, payload_fingerprint, decision, replay_release_status,
        replay_release_error_code, attempt_owner_id, replay_of_receipt_id,
        actor_kind, ingress, parent_operation_hash, authority_id_hash,
        authority_generation_hash, actor_ref_hash, provider_thread_hash, provider,
        provider_turn_hash, automation_hash, automation_run_hash, integration_hash,
        manual_user_hash, received_at, finished_at
      ) VALUES (
        ${input.envelope.operationId}, ${input.envelope.idempotency.claimKey},
        ${input.attemptSequence}, ${input.envelope.operation}, ${input.envelope.projectId},
        ${input.envelope.idempotency.actorScopeHash}, ${input.envelope.authority.grantHash},
        ${input.envelope.idempotency.payloadFingerprint}, ${input.decision},
        ${input.decision === "replay-eligible" ? "pending" : null}, NULL, ${ownerId},
        ${input.replayOfReceiptId ?? null},
        ${input.attribution.actorKind}, ${input.attribution.ingress},
        ${input.attribution.parentOperationHash}, ${input.attribution.authorityIdHash},
        ${scientOperationAttributionHash(
          "authority-generation",
          input.envelope.authority.authorityId,
          input.envelope.authority.generation,
        )}, ${input.attribution.actorRefHash},
        ${input.attribution.providerThreadHash}, ${input.attribution.provider},
        ${input.attribution.providerTurnHash}, ${input.attribution.automationHash},
        ${input.attribution.automationRunHash}, ${input.attribution.integrationHash},
        ${input.attribution.manualUserHash}, ${input.envelope.receivedAt},
        ${
          input.decision === "acquired" || input.decision === "replay-eligible"
            ? null
            : input.envelope.receivedAt
        }
      )
    `;

    const insertIntent = (input: {
      readonly envelope: ScientOperationRequestEnvelope;
      readonly intent: ReturnType<typeof validateIntent>;
    }) =>
      input.intent === null
        ? Effect.void
        : sql`
            INSERT INTO scient_operation_intents (
              operation_id, claim_key, effect_kind, effect_identity,
              expected_aggregate_kind, expected_aggregate_id, safe_replay_json, created_at
            ) VALUES (
              ${input.envelope.operationId}, ${input.envelope.idempotency.claimKey},
              ${input.intent.effect.kind}, ${input.intent.effect.identity},
              ${input.intent.expectedAggregateKind}, ${input.intent.expectedAggregateId},
              ${input.intent.safeReplayJson}, ${input.envelope.receivedAt}
            )
          `;

    const acquireOwner: ScientOperationReceiptRepositoryShape["acquireOwner"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO scient_operation_executor_owner (owner_key, owner_id, heartbeat_at)
            VALUES ('executor', ${ownerId}, ${input.now})
            ON CONFLICT (owner_key) DO NOTHING
          `;
            const rows = yield* sql<{
              readonly ownerId: string;
              readonly heartbeatAt: number;
            }>`
            SELECT owner_id AS "ownerId", heartbeat_at AS "heartbeatAt"
            FROM scient_operation_executor_owner
            WHERE owner_key = 'executor'
          `;
            const current = rows[0];
            if (!current) {
              return yield* Effect.fail(
                decodeError("ScientOperationReceipts.acquireOwner", "Owner row disappeared."),
              );
            }
            if (current.ownerId === ownerId) {
              yield* sql`
              UPDATE scient_operation_executor_owner
              SET heartbeat_at = ${input.now}
              WHERE owner_key = 'executor' AND owner_id = ${ownerId}
            `;
              return;
            }
            if (current.heartbeatAt >= input.staleBefore) {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.acquireOwner",
                  "Another live Scient operation executor owns this database.",
                ),
              );
            }
            const replaced = yield* sql<{ readonly ownerId: string }>`
            UPDATE scient_operation_executor_owner
            SET owner_id = ${ownerId}, heartbeat_at = ${input.now}
            WHERE owner_key = 'executor'
              AND owner_id = ${current.ownerId}
              AND heartbeat_at = ${current.heartbeatAt}
            RETURNING owner_id AS "ownerId"
          `;
            if (replaced.length !== 1) {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.acquireOwner",
                  "Executor ownership changed during acquisition.",
                ),
              );
            }
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ScientOperationReceipts.acquireOwner")));

    const heartbeatOwner: ScientOperationReceiptRepositoryShape["heartbeatOwner"] = (input) =>
      sql<{ readonly ownerId: string }>`
      UPDATE scient_operation_executor_owner
      SET heartbeat_at = ${input.now}
      WHERE owner_key = 'executor' AND owner_id = ${ownerId}
      RETURNING owner_id AS "ownerId"
    `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.void
            : Effect.fail(
                decodeError(
                  "ScientOperationReceipts.heartbeatOwner",
                  "Scient operation executor ownership was lost.",
                ),
              ),
        ),
        Effect.mapError((error) =>
          error instanceof PersistenceDecodeError
            ? error
            : toPersistenceSqlError("ScientOperationReceipts.heartbeatOwner")(error),
        ),
      );

    const releaseOwner: ScientOperationReceiptRepositoryShape["releaseOwner"] = () =>
      sql`
      DELETE FROM scient_operation_executor_owner
      WHERE owner_key = 'executor' AND owner_id = ${ownerId}
    `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ScientOperationReceipts.releaseOwner")),
      );

    const claim: ScientOperationReceiptRepositoryShape["claim"] = (input) =>
      Effect.try({
        try: () => {
          const intent = validateIntent(input.intent, input.envelope);
          const requiresIntent = input.envelope.operation === "thread.message.send";
          if ((requiresIntent && intent === null) || (!requiresIntent && intent !== null)) {
            throw decodeError(
              "ScientOperationReceipts.claim",
              "Exactly one supported durable intent is required for thread send only.",
            );
          }
          return {
            envelope: input.envelope,
            attribution: attributionForEnvelope(input.envelope),
            intent,
          };
        },
        catch: (error) =>
          error instanceof PersistenceDecodeError
            ? error
            : decodeError("ScientOperationReceipts.claim", "Invalid durable claim.", error),
      }).pipe(
        Effect.flatMap(({ envelope, attribution, intent }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const owner = yield* sql<{ readonly ownerId: string }>`
            SELECT owner_id AS "ownerId"
            FROM scient_operation_executor_owner
            WHERE owner_key = 'executor' AND owner_id = ${ownerId}
          `;
              if (owner.length !== 1) {
                return yield* Effect.fail(
                  decodeError(
                    "ScientOperationReceipts.claim",
                    "Scient operation executor does not own this database.",
                  ),
                );
              }
              const inserted = yield* sql<{ readonly operationId: string }>`
            INSERT INTO scient_operation_claims (
              claim_key,
              claim_key_version,
              semantic_identity_hash,
              actor_scope_hash,
              attempt_sequence,
              operation_id,
              owner_id,
              operation,
              project_id,
              grant_hash,
              authority_generation_hash,
              authority_id_hash,
              actor_kind,
              actor_ref_hash,
              provider_thread_hash,
              provider,
              provider_turn_hash,
              automation_hash,
              automation_run_hash,
              integration_hash,
              manual_user_hash,
              parent_operation_hash,
              ingress,
              idempotency_mode,
              payload_fingerprint,
              status,
              replay_result_json,
              error_code,
              started_at,
              finished_at,
              updated_at,
              receipt_sequence
            ) VALUES (
              ${envelope.idempotency.claimKey},
              ${envelope.idempotency.claimKeyVersion},
              ${envelope.idempotency.semanticIdentityHash},
              ${envelope.idempotency.actorScopeHash},
              1,
              ${envelope.operationId},
              ${ownerId},
              ${envelope.operation},
              ${envelope.projectId},
              ${envelope.authority.grantHash},
              ${scientOperationAttributionHash(
                "authority-generation",
                envelope.authority.authorityId,
                envelope.authority.generation,
              )},
              ${attribution.authorityIdHash},
              ${attribution.actorKind},
              ${attribution.actorRefHash},
              ${attribution.providerThreadHash},
              ${attribution.provider},
              ${attribution.providerTurnHash},
              ${attribution.automationHash},
              ${attribution.automationRunHash},
              ${attribution.integrationHash},
              ${attribution.manualUserHash},
              ${attribution.parentOperationHash},
              ${envelope.ingress},
              ${envelope.idempotency.mode},
              ${envelope.idempotency.payloadFingerprint},
              'in_progress',
              NULL,
              NULL,
              ${envelope.receivedAt},
              NULL,
              ${envelope.receivedAt},
              0
            )
            ON CONFLICT (claim_key) DO NOTHING
            RETURNING operation_id AS "operationId"
          `;
              if (inserted.length > 0) {
                yield* insertIntent({ envelope, intent });
                yield* insertAttempt({
                  envelope,
                  attribution,
                  attemptSequence: 1,
                  decision: "acquired",
                });
                return { kind: "acquired" } as const;
              }

              const existing = (yield* selectClaim(envelope.idempotency.claimKey))[0];
              if (!existing) {
                return yield* Effect.fail(
                  decodeError(
                    "ScientOperationReceipts.claim",
                    "Claim disappeared after an idempotency conflict.",
                  ),
                );
              }
              if (existing.payloadFingerprint !== envelope.idempotency.payloadFingerprint) {
                const attemptSequence = existing.attemptSequence + 1;
                const advanced = yield* sql<{ readonly attemptSequence: number }>`
                UPDATE scient_operation_claims
                SET attempt_sequence = ${attemptSequence}
                WHERE claim_key = ${envelope.idempotency.claimKey}
                  AND attempt_sequence = ${existing.attemptSequence}
                RETURNING attempt_sequence AS "attemptSequence"
              `;
                if (advanced.length !== 1) {
                  return yield* Effect.fail(
                    decodeError(
                      "ScientOperationReceipts.claim",
                      "Claim attempt changed during payload-conflict recording.",
                    ),
                  );
                }
                yield* insertAttempt({
                  envelope,
                  attribution,
                  attemptSequence,
                  decision: "payload-conflict",
                });
                return { kind: "payload-conflict" } as const;
              }
              const status = claimStatus(existing.status);
              if (status === "failed" || status === "reconciled_failed") {
                const reacquired = yield* sql<{
                  readonly operationId: string;
                  readonly attemptSequence: number;
                }>`
              UPDATE scient_operation_claims
              SET
                operation_id = ${envelope.operationId},
                owner_id = ${ownerId},
                operation = ${envelope.operation},
                project_id = ${envelope.projectId},
                grant_hash = ${envelope.authority.grantHash},
                authority_generation_hash = ${scientOperationAttributionHash(
                  "authority-generation",
                  envelope.authority.authorityId,
                  envelope.authority.generation,
                )},
                authority_id_hash = ${attribution.authorityIdHash},
                actor_kind = ${attribution.actorKind},
                actor_ref_hash = ${attribution.actorRefHash},
                provider_thread_hash = ${attribution.providerThreadHash},
                provider = ${attribution.provider},
                provider_turn_hash = ${attribution.providerTurnHash},
                automation_hash = ${attribution.automationHash},
                automation_run_hash = ${attribution.automationRunHash},
                integration_hash = ${attribution.integrationHash},
                manual_user_hash = ${attribution.manualUserHash},
                parent_operation_hash = ${attribution.parentOperationHash},
                ingress = ${envelope.ingress},
                attempt_sequence = attempt_sequence + 1,
                status = 'in_progress',
                replay_result_json = NULL,
                error_code = NULL,
                started_at = ${envelope.receivedAt},
                finished_at = NULL,
                updated_at = ${envelope.receivedAt}
              WHERE claim_key = ${envelope.idempotency.claimKey}
                AND operation_id = ${existing.operationId}
                AND owner_id = ${existing.ownerId}
                AND status = ${status}
                AND payload_fingerprint = ${existing.payloadFingerprint}
              RETURNING operation_id AS "operationId", attempt_sequence AS "attemptSequence"
            `;
                if (reacquired.length !== 1) {
                  return yield* Effect.fail(
                    decodeError(
                      "ScientOperationReceipts.claim",
                      "Terminal claim changed during retry acquisition.",
                    ),
                  );
                }
                yield* insertIntent({ envelope, intent });
                yield* insertAttempt({
                  envelope,
                  attribution,
                  attemptSequence: reacquired[0]!.attemptSequence,
                  decision: "acquired",
                });
                return { kind: "acquired" } as const;
              }
              const latestReceipt = (yield* selectLatestReceipt(envelope.idempotency.claimKey))[0];
              if (status === "succeeded" || status === "reconciled_succeeded") {
                if (!latestReceipt) {
                  return yield* Effect.fail(
                    decodeError(
                      "ScientOperationReceipts.claim",
                      "A successful claim is missing its terminal receipt.",
                    ),
                  );
                }
                const attemptSequence = existing.attemptSequence + 1;
                const advanced = yield* sql<{ readonly attemptSequence: number }>`
                UPDATE scient_operation_claims
                SET attempt_sequence = ${attemptSequence}
                WHERE claim_key = ${envelope.idempotency.claimKey}
                  AND attempt_sequence = ${existing.attemptSequence}
                RETURNING attempt_sequence AS "attemptSequence"
              `;
                if (advanced.length !== 1) {
                  return yield* Effect.fail(
                    decodeError(
                      "ScientOperationReceipts.claim",
                      "Claim attempt changed during replay recording.",
                    ),
                  );
                }
                yield* insertAttempt({
                  envelope,
                  attribution,
                  attemptSequence,
                  decision: "replay-eligible",
                  replayOfReceiptId: latestReceipt.receiptId,
                });
                return {
                  kind: "replay",
                  status,
                  attempt: {
                    operationId: envelope.operationId,
                    claimKey: envelope.idempotency.claimKey,
                    attemptSequence,
                  },
                  receipt: decodeReceipt(latestReceipt),
                  replayResult: decodeReplay(
                    existing.replayResultJson,
                    "ScientOperationReceipts.decodeReplayResult",
                  ),
                } as const;
              }
              const attemptSequence = existing.attemptSequence + 1;
              const advanced = yield* sql<{ readonly attemptSequence: number }>`
              UPDATE scient_operation_claims
              SET attempt_sequence = ${attemptSequence}
              WHERE claim_key = ${envelope.idempotency.claimKey}
                AND attempt_sequence = ${existing.attemptSequence}
              RETURNING attempt_sequence AS "attemptSequence"
            `;
              if (advanced.length !== 1) {
                return yield* Effect.fail(
                  decodeError(
                    "ScientOperationReceipts.claim",
                    "Claim attempt changed during uncertain-attempt recording.",
                  ),
                );
              }
              yield* insertAttempt({
                envelope,
                attribution,
                attemptSequence,
                decision: "uncertain",
              });
              return {
                kind: "uncertain",
                receipt: latestReceipt ? decodeReceipt(latestReceipt) : null,
              } as const;
            }),
          ),
        ),
        Effect.mapError((error) =>
          error instanceof PersistenceDecodeError
            ? error
            : toPersistenceSqlError("ScientOperationReceipts.claim")(error),
        ),
      );

    const finish: ScientOperationReceiptRepositoryShape["finish"] = (input) =>
      Effect.try({
        try: () => ({
          replayResultJson: encodeReplay(
            input.replayResult,
            "ScientOperationReceipts.encodeReplayResult",
          ),
          effectsJson: encodeBoundedJson(
            redactEffects(input.receipt.effects),
            "ScientOperationReceipts.encodeEffects",
            MAX_EFFECTS_BYTES,
          )!,
        }),
        catch: (error) =>
          error instanceof PersistenceDecodeError
            ? error
            : decodeError("ScientOperationReceipts.finish", "Failed to encode receipt.", error),
      }).pipe(
        Effect.flatMap(({ replayResultJson, effectsJson }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const intents = yield* sql<IntentRow>`
                SELECT
                  operation_id AS "operationId", claim_key AS "claimKey",
                  effect_kind AS "effectKind", effect_identity AS "effectIdentity",
                  expected_aggregate_kind AS "expectedAggregateKind",
                  expected_aggregate_id AS "expectedAggregateId",
                  safe_replay_json AS "safeReplayJson"
                FROM scient_operation_intents
                WHERE claim_key = ${input.envelope.idempotency.claimKey}
                  AND operation_id = ${input.envelope.operationId}
              `;
              const intent = intents[0];
              if (intents.length > 1) {
                return yield* Effect.fail(
                  decodeError(
                    "ScientOperationReceipts.finish",
                    "An operation has more than one durable intent.",
                  ),
                );
              }
              if (intent) {
                const exactEffect =
                  input.receipt.effects.length === 1 &&
                  input.receipt.effects[0]?.kind === "orchestration-command" &&
                  input.receipt.effects[0].identity === intent.effectIdentity;
                if (
                  (input.receipt.effects.length > 0 && !exactEffect) ||
                  (input.receipt.outcome === "succeeded" && !exactEffect) ||
                  (input.receipt.outcome === "succeeded" &&
                    replayResultJson !== intent.safeReplayJson)
                ) {
                  return yield* Effect.fail(
                    decodeError(
                      "ScientOperationReceipts.finish",
                      "The terminal effect and replay must exactly match the persisted intent.",
                    ),
                  );
                }
              }
              const status =
                input.receipt.outcome === "succeeded"
                  ? "succeeded"
                  : input.receipt.outcome === "failed"
                    ? "failed"
                    : "uncertain";
              const updated = yield* sql<{ readonly receiptSequence: number }>`
              UPDATE scient_operation_claims
              SET
                status = ${status},
                replay_result_json = ${replayResultJson},
                error_code = ${input.receipt.errorCode},
                finished_at = ${input.receipt.finishedAt},
                updated_at = ${input.receipt.finishedAt},
                receipt_sequence = receipt_sequence + 1
              WHERE
                claim_key = ${input.envelope.idempotency.claimKey}
                AND operation_id = ${input.envelope.operationId}
                AND owner_id = ${ownerId}
                AND status = 'in_progress'
                AND EXISTS (
                  SELECT 1 FROM scient_operation_executor_owner
                  WHERE owner_key = 'executor' AND owner_id = ${ownerId}
                )
              RETURNING receipt_sequence AS "receiptSequence"
            `;
              const receiptSequence = updated[0]?.receiptSequence;
              if (receiptSequence === undefined) {
                return yield* Effect.fail(
                  decodeError(
                    "ScientOperationReceipts.finish",
                    "The exact in-progress claim attempt no longer owns terminal completion.",
                  ),
                );
              }
              yield* insertReceipt(
                receiptValues({
                  claimKey: input.envelope.idempotency.claimKey,
                  receipt: input.receipt,
                  receiptSequence,
                  effectsJson,
                  attribution: attributionForEnvelope(input.envelope),
                  authorityGenerationHash: scientOperationAttributionHash(
                    "authority-generation",
                    input.envelope.authority.authorityId,
                    input.envelope.authority.generation,
                  ),
                }),
              );
              yield* sql`
              UPDATE scient_operation_attempt_receipts
              SET terminal_receipt_id = ${input.receipt.receiptId}
                ,finished_at = ${input.receipt.finishedAt}
              WHERE operation_id = ${input.envelope.operationId}
                AND claim_key = ${input.envelope.idempotency.claimKey}
                AND decision = 'acquired'
            `;
            }),
          ),
        ),
        Effect.mapError((error) =>
          error instanceof PersistenceDecodeError
            ? error
            : toPersistenceSqlError("ScientOperationReceipts.finish")(error),
        ),
      );

    const recoverInterrupted: ScientOperationReceiptRepositoryShape["recoverInterrupted"] = (
      input,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const liveOwner = yield* sql<{ readonly ownerId: string }>`
              SELECT owner_id AS "ownerId"
              FROM scient_operation_executor_owner
              WHERE owner_key = 'executor' AND owner_id = ${ownerId}
            `;
            if (liveOwner.length !== 1) {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.recoverInterrupted",
                  "Scient operation executor does not own this database.",
                ),
              );
            }
            const interrupted = yield* sql<ClaimRow>`
            SELECT
              claim_key AS "claimKey",
              claim_key_version AS "claimKeyVersion",
              semantic_identity_hash AS "semanticIdentityHash",
              actor_scope_hash AS "actorScopeHash",
              attempt_sequence AS "attemptSequence",
              operation_id AS "operationId",
              owner_id AS "ownerId",
              operation,
              project_id AS "projectId",
              grant_hash AS "grantHash",
              authority_generation_hash AS "authorityGenerationHash",
              authority_id_hash AS "authorityIdHash",
              actor_kind AS "actorKind",
              actor_ref_hash AS "actorRefHash",
              provider_thread_hash AS "providerThreadHash",
              provider,
              provider_turn_hash AS "providerTurnHash",
              automation_hash AS "automationHash",
              automation_run_hash AS "automationRunHash",
              integration_hash AS "integrationHash",
              manual_user_hash AS "manualUserHash",
              ingress,
              parent_operation_hash AS "parentOperationHash",
              payload_fingerprint AS "payloadFingerprint",
              status,
              replay_result_json AS "replayResultJson",
              error_code AS "errorCode",
              started_at AS "startedAt",
              finished_at AS "finishedAt",
              receipt_sequence AS "receiptSequence"
            FROM scient_operation_claims
            WHERE status = 'in_progress' AND owner_id != ${ownerId}
          `;
            let recoveredCount = 0;
            for (const claim of interrupted) {
              const receipt: ScientOperationResultReceipt = {
                receiptId: `scient-recovery:${claim.operationId}`,
                operationId: claim.operationId,
                operation: claim.operation as ScientOperationResultReceipt["operation"],
                projectId: claim.projectId,
                grantHash: claim.grantHash,
                // Persisted recovery receipts keep the already-redacted digest.
                authorityGeneration: claim.authorityGenerationHash,
                authorization: "allowed",
                startedAt: claim.startedAt,
                finishedAt: input.recoveredAt,
                outcome: "uncertain/reconciliation-required",
                errorCode: "operation_interrupted_before_terminal_receipt",
                effects: [],
              };
              const updated = yield* sql<{ readonly receiptSequence: number }>`
              UPDATE scient_operation_claims
              SET
                status = 'uncertain',
                error_code = 'operation_interrupted_before_terminal_receipt',
                finished_at = ${input.recoveredAt},
                updated_at = ${input.recoveredAt},
                receipt_sequence = receipt_sequence + 1
              WHERE claim_key = ${claim.claimKey} AND operation_id = ${claim.operationId}
                AND owner_id = ${claim.ownerId}
                AND status = 'in_progress'
                AND EXISTS (
                  SELECT 1 FROM scient_operation_executor_owner
                  WHERE owner_key = 'executor' AND owner_id = ${ownerId}
                )
              RETURNING receipt_sequence AS "receiptSequence"
            `;
              const receiptSequence = updated[0]?.receiptSequence;
              if (receiptSequence !== undefined) {
                recoveredCount += 1;
                yield* insertReceipt(
                  receiptValues({
                    claimKey: claim.claimKey,
                    receipt,
                    receiptSequence,
                    authorityGenerationHash: claim.authorityGenerationHash,
                    attribution: attributionFromClaimRow(claim),
                  }),
                );
                yield* sql`
                UPDATE scient_operation_attempt_receipts
                SET terminal_receipt_id = ${receipt.receiptId}
                  ,finished_at = ${input.recoveredAt}
                WHERE operation_id = ${claim.operationId} AND decision = 'acquired'
              `;
              }
            }
            yield* sql`
              UPDATE scient_operation_attempt_receipts
              SET
                replay_release_status = 'unknown',
                replay_release_error_code = 'replay_release_audit_unknown',
                finished_at = ${input.recoveredAt}
              WHERE decision = 'replay-eligible'
                AND replay_release_status = 'pending'
                AND attempt_owner_id != ${ownerId}
                AND EXISTS (
                  SELECT 1 FROM scient_operation_executor_owner
                  WHERE owner_key = 'executor' AND owner_id = ${ownerId}
                )
            `;
            return recoveredCount;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ScientOperationReceipts.recoverInterrupted")));

    const finalizeReplayAttempt: ScientOperationReceiptRepositoryShape["finalizeReplayAttempt"] = (
      input,
    ) => {
      const validErrorCode =
        (input.disposition === "allowed" && input.errorCode === null) ||
        (input.disposition === "denied" && input.errorCode === "replay_release_denied") ||
        (input.disposition === "reconstruction-failed" &&
          (input.errorCode === "replay_result_unavailable" ||
            input.errorCode === "replay_reconstruction_failed"));
      if (!validErrorCode) {
        return Effect.fail(
          decodeError(
            "ScientOperationReceipts.finalizeReplayAttempt",
            "Replay disposition has an invalid fixed error code.",
          ),
        );
      }
      return sql<{ readonly operationId: string }>`
          UPDATE scient_operation_attempt_receipts
          SET replay_release_status = ${input.disposition},
              replay_release_error_code = ${input.errorCode},
              finished_at = ${input.finishedAt}
          WHERE operation_id = ${input.operationId}
            AND claim_key = ${input.claimKey}
            AND attempt_sequence = ${input.attemptSequence}
            AND decision = 'replay-eligible'
            AND replay_release_status = 'pending'
            AND finished_at IS NULL
            AND attempt_owner_id = ${ownerId}
            AND EXISTS (
              SELECT 1 FROM scient_operation_executor_owner
              WHERE owner_key = 'executor' AND owner_id = ${ownerId}
            )
          RETURNING operation_id AS "operationId"
        `.pipe(
        Effect.flatMap((rows) => {
          if (rows.length === 1) return Effect.void;
          return sql<{
            readonly disposition: string;
            readonly errorCode: string | null;
            readonly finishedAt: number | null;
          }>`
              SELECT replay_release_status AS "disposition",
                     replay_release_error_code AS "errorCode",
                     finished_at AS "finishedAt"
              FROM scient_operation_attempt_receipts
              WHERE operation_id = ${input.operationId}
                AND claim_key = ${input.claimKey}
                AND attempt_sequence = ${input.attemptSequence}
                AND decision = 'replay-eligible'
                AND attempt_owner_id = ${ownerId}
            `.pipe(
            Effect.flatMap((existing) =>
              existing.length === 1 &&
              existing[0]!.disposition === input.disposition &&
              existing[0]!.errorCode === input.errorCode &&
              existing[0]!.finishedAt !== null
                ? Effect.void
                : Effect.fail(
                    decodeError(
                      "ScientOperationReceipts.finalizeReplayAttempt",
                      "Replay eligibility is missing, stale-owned, or terminalized differently.",
                    ),
                  ),
            ),
          );
        }),
        Effect.mapError((error) =>
          error instanceof PersistenceDecodeError
            ? error
            : toPersistenceSqlError("ScientOperationReceipts.finalizeReplayAttempt")(error),
        ),
      );
    };

    const listUncertainIntents: ScientOperationReceiptRepositoryShape["listUncertainIntents"] = (
      input,
    ) =>
      sql<IntentRow>`
        SELECT
          i.operation_id AS "operationId",
          i.claim_key AS "claimKey",
          i.effect_kind AS "effectKind",
          i.effect_identity AS "effectIdentity",
          i.expected_aggregate_kind AS "expectedAggregateKind",
          i.expected_aggregate_id AS "expectedAggregateId",
          i.safe_replay_json AS "safeReplayJson"
        FROM scient_operation_intents i
        JOIN scient_operation_claims c
          ON c.claim_key = i.claim_key AND c.operation_id = i.operation_id
        WHERE c.status = 'uncertain'
        ORDER BY c.updated_at ASC
        LIMIT ${Math.max(0, input.limit)}
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            const effect = validateEffect({ kind: row.effectKind, identity: row.effectIdentity });
            if (effect.kind !== "orchestration-command") {
              throw decodeError(
                "ScientOperationReceipts.listUncertainIntents",
                "Stored intent has an unsupported effect kind.",
              );
            }
            return {
              claimKey: row.claimKey,
              operationId: row.operationId,
              effect: { ...effect, kind: "orchestration-command" as const },
              expectedAggregateKind: row.expectedAggregateKind as "thread" | "project",
              expectedAggregateId: row.expectedAggregateId,
            };
          }),
        ),
        Effect.mapError(toPersistenceSqlError("ScientOperationReceipts.listUncertainIntents")),
      );

    const reconcileIntent: ScientOperationReceiptRepositoryShape["reconcileIntent"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const claim = (yield* selectClaim(input.claimKey))[0];
            if (!claim || claimStatus(claim.status) !== "uncertain") {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.reconcileIntent",
                  "Only an existing uncertain claim can be reconciled.",
                ),
              );
            }
            const intents = yield* sql<IntentRow>`
            SELECT
              operation_id AS "operationId", claim_key AS "claimKey",
              effect_kind AS "effectKind", effect_identity AS "effectIdentity",
              expected_aggregate_kind AS "expectedAggregateKind",
              expected_aggregate_id AS "expectedAggregateId",
              safe_replay_json AS "safeReplayJson"
            FROM scient_operation_intents
            WHERE claim_key = ${input.claimKey} AND operation_id = ${claim.operationId}
          `;
            const intent = intents[0];
            if (!intent || intents.length !== 1 || intent.effectKind !== "orchestration-command") {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.reconcileIntent",
                  "The uncertain attempt has no single trusted command intent.",
                ),
              );
            }
            if (
              input.commandId !== intent.effectIdentity ||
              input.aggregateKind !== intent.expectedAggregateKind ||
              input.aggregateId !== intent.expectedAggregateId ||
              !Number.isSafeInteger(input.resultSequence) ||
              input.resultSequence < 0 ||
              (input.commandStatus === "accepted" &&
                (input.commandError !== null || input.resultSequence <= 0)) ||
              (input.commandError !== null &&
                (typeof input.commandError !== "string" ||
                  Buffer.byteLength(input.commandError, "utf8") > 4_096))
            ) {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.reconcileIntent",
                  "The command receipt does not exactly match the trusted durable intent.",
                ),
              );
            }
            const replayResult = decodeReplay(
              intent.safeReplayJson,
              "ScientOperationReceipts.decodeIntentReplay",
            );
            if (replayResult === null) {
              return yield* Effect.fail(
                decodeError("ScientOperationReceipts.reconcileIntent", "Intent replay is missing."),
              );
            }
            const succeeded = input.commandStatus === "accepted";
            const errorCode = succeeded ? null : "orchestration_command_rejected";
            const previous = (yield* selectLatestReceipt(input.claimKey))[0];
            const receipt: ScientOperationResultReceipt = {
              receiptId: input.receiptId,
              operationId: claim.operationId,
              operation: claim.operation as ScientOperationResultReceipt["operation"],
              projectId: claim.projectId,
              grantHash: claim.grantHash,
              authorityGeneration: claim.authorityGenerationHash,
              authorization: "allowed",
              startedAt: claim.startedAt,
              finishedAt: input.finishedAt,
              outcome: succeeded ? "succeeded" : "failed",
              errorCode,
              effects: [{ kind: "orchestration-command", identity: intent.effectIdentity }],
            };
            const updated = yield* sql<{ readonly receiptSequence: number }>`
            UPDATE scient_operation_claims
            SET
              status = ${succeeded ? "reconciled_succeeded" : "reconciled_failed"},
              replay_result_json = ${succeeded ? intent.safeReplayJson : null},
              error_code = ${errorCode},
              finished_at = ${input.finishedAt},
              updated_at = ${input.finishedAt},
              receipt_sequence = receipt_sequence + 1
            WHERE claim_key = ${input.claimKey} AND operation_id = ${intent.operationId}
              AND status = 'uncertain'
            RETURNING receipt_sequence AS "receiptSequence"
          `;
            const receiptSequence = updated[0]?.receiptSequence;
            if (receiptSequence === undefined) {
              return yield* Effect.fail(
                decodeError(
                  "ScientOperationReceipts.reconcileIntent",
                  "Intent ownership changed during reconciliation.",
                ),
              );
            }
            const stored = receiptValues({
              claimKey: input.claimKey,
              receipt,
              receiptSequence,
              authorityGenerationHash: claim.authorityGenerationHash,
              attribution: attributionFromClaimRow(claim),
              reconcilesReceiptId: previous?.receiptId ?? null,
            });
            yield* insertReceipt(stored);
            return decodeReceipt({ ...stored });
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof PersistenceDecodeError
              ? error
              : toPersistenceSqlError("ScientOperationReceipts.reconcileIntent")(error),
          ),
        );

    const getByClaimKey: ScientOperationReceiptRepositoryShape["getByClaimKey"] = (input) =>
      Effect.gen(function* () {
        const claim = (yield* selectClaim(input.claimKey))[0];
        if (!claim) return Option.none();
        const receipt = (yield* selectLatestReceipt(input.claimKey))[0];
        return Option.some({
          status: claimStatus(claim.status),
          receipt: receipt ? decodeReceipt(receipt) : null,
          replayResult: decodeReplay(
            claim.replayResultJson,
            "ScientOperationReceipts.decodeReplayResult",
          ),
        });
      }).pipe(
        Effect.mapError((error) =>
          error instanceof PersistenceDecodeError
            ? error
            : toPersistenceSqlError("ScientOperationReceipts.getByClaimKey")(error),
        ),
      );

    const pruneTerminal: ScientOperationReceiptRepositoryShape["pruneTerminal"] = (input) =>
      sql<{ readonly claimKey: string }>`
      DELETE FROM scient_operation_claims
      WHERE claim_key IN (
        SELECT claim_key
        FROM scient_operation_claims
        WHERE idempotency_mode = 'unique'
          AND status IN ('succeeded', 'failed', 'reconciled_succeeded', 'reconciled_failed')
          AND finished_at < ${input.finishedBefore}
        ORDER BY finished_at ASC
        LIMIT ${Math.max(0, input.limit)}
      )
      RETURNING claim_key AS "claimKey"
    `.pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(toPersistenceSqlError("ScientOperationReceipts.pruneTerminal")),
      );

    return {
      ownerId,
      acquireOwner,
      heartbeatOwner,
      releaseOwner,
      claim,
      finish,
      recoverInterrupted,
      finalizeReplayAttempt,
      listUncertainIntents,
      reconcileIntent,
      getByClaimKey,
      pruneTerminal,
    } satisfies ScientOperationReceiptRepositoryShape;
  });

export const ScientOperationReceiptRepositoryLive = Layer.effect(
  ScientOperationReceiptRepository,
  makeScientOperationReceiptRepository(),
);
