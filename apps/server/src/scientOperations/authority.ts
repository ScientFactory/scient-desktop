/**
 * Host-independent authority, request, and result contracts for Scient operations.
 *
 * Ingress adapters resolve authority from trusted host state. The only exported
 * request-envelope constructor also performs authorization, preventing an
 * adapter from manufacturing an authoritative-looking envelope without the
 * matching actor, project, capability, and time decision.
 *
 * @module scientOperations/authority
 */
import { createHash } from "node:crypto";

export const SCIENT_OPERATION_CAPABILITIES = [
  "project:context:read",
  "thread:list",
  "thread:read",
  "thread:drive",
  "automation:run",
  "browser:read",
  "browser:capture",
  "browser:action",
  "project-file:read",
  "project-file:write",
  "scientific-record:propose",
  "scientific-record:accept",
  "export:run",
] as const;

export type ScientOperationCapability = (typeof SCIENT_OPERATION_CAPABILITIES)[number];

export const SCIENT_OPERATION_IDS = [
  "project.context.read",
  "project.list",
  "thread.list",
  "thread.read",
  "thread.wait",
  "thread.message.send",
  "thread.interrupt",
  "automation.run",
  "browser.read",
  "browser.capture",
  "browser.action",
  "scientific-record.propose",
  "scientific-record.accept",
  "project-file.read",
  "project-file.write",
  "export.run",
] as const;

export type ScientOperationId = (typeof SCIENT_OPERATION_IDS)[number];

export type ScientOperationActor =
  | { readonly kind: "manual-user"; readonly userId: string }
  | {
      readonly kind: "provider-thread";
      readonly threadId: string;
      readonly provider: string;
      readonly sessionKey: string;
    }
  | { readonly kind: "external-integration"; readonly integrationId: string }
  | {
      readonly kind: "automation-run";
      readonly automationId: string;
      readonly runId: string;
    };

export type ScientOperationActorKind = ScientOperationActor["kind"];

export interface ScientOperationDefinition {
  readonly id: ScientOperationId;
  readonly capability: ScientOperationCapability;
  readonly allowedActorKinds: ReadonlyArray<ScientOperationActorKind>;
  /** Optional validated logical retry identity field exposed by an adapter. */
  readonly idempotencyInputField: string | null;
}

export function defineScientOperation(
  input: Omit<ScientOperationDefinition, "allowedActorKinds" | "idempotencyInputField"> & {
    readonly allowedActorKinds: ReadonlyArray<ScientOperationActorKind>;
    readonly idempotencyInputField?: string | null;
  },
): ScientOperationDefinition {
  return Object.freeze({
    ...input,
    allowedActorKinds: Object.freeze([...new Set(input.allowedActorKinds)]),
    idempotencyInputField: input.idempotencyInputField ?? null,
  });
}

export interface ScientOperationAuthority {
  readonly authorityId: string;
  /** Changes whenever the host replaces, narrows, or revokes the grant. */
  readonly generation: string;
  readonly actor: ScientOperationActor;
  readonly projectIds: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<ScientOperationCapability>;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

function immutableActor(actor: ScientOperationActor): ScientOperationActor {
  return Object.freeze({ ...actor });
}

export function makeScientOperationAuthority(
  input: ScientOperationAuthority,
): ScientOperationAuthority {
  return Object.freeze({
    ...input,
    actor: immutableActor(input.actor),
    projectIds: Object.freeze([...new Set(input.projectIds)].toSorted()),
    capabilities: Object.freeze([...new Set(input.capabilities)].toSorted()),
  });
}

export type ScientOperationIngress =
  | "manual-ui"
  | "provider-gateway"
  | "external-mcp"
  | "automation"
  | "browser";

export interface ScientOperationGrantSnapshot extends ScientOperationAuthority {
  /** Canonical hash of every non-secret field in this resolved grant. */
  readonly grantHash: string;
}

export interface ScientOperationIdempotencyClaim {
  readonly mode: "semantic" | "unique";
  readonly identity: string;
  /** Hash of actor, grant generation, project, operation, and logical identity. */
  readonly claimKey: string;
  /** Compared separately so reuse with different input becomes a conflict. */
  readonly payloadFingerprint: string;
}

export interface ScientOperationRequestEnvelope {
  readonly operationId: string;
  readonly operation: ScientOperationId;
  readonly capability: ScientOperationCapability;
  readonly projectId: string;
  readonly authority: ScientOperationGrantSnapshot;
  readonly ingress: ScientOperationIngress;
  readonly parentOperationId: string | null;
  readonly idempotency: ScientOperationIdempotencyClaim;
  readonly receivedAt: number;
}

export type ScientOperationAuthorizationDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly code:
        | "actor_kind_denied"
        | "authority_expired"
        | "authority_not_yet_valid"
        | "authority_revoked"
        | "capability_denied"
        | "project_scope_denied";
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function authorize(input: {
  readonly authority: ScientOperationAuthority;
  readonly definition: ScientOperationDefinition;
  readonly projectId: string;
  readonly now: number;
}): ScientOperationAuthorizationDecision {
  const { authority, definition } = input;
  if (authority.revokedAt !== null) {
    return { allow: false, code: "authority_revoked", message: "Authority was revoked." };
  }
  if (input.now < authority.issuedAt) {
    return {
      allow: false,
      code: "authority_not_yet_valid",
      message: "Authority is not valid yet.",
    };
  }
  if (authority.expiresAt !== null && input.now >= authority.expiresAt) {
    return { allow: false, code: "authority_expired", message: "Authority has expired." };
  }
  if (!definition.allowedActorKinds.includes(authority.actor.kind)) {
    return {
      allow: false,
      code: "actor_kind_denied",
      message: "This actor kind is not authorized for the Scient operation.",
      details: { actorKind: authority.actor.kind },
    };
  }
  if (!authority.projectIds.includes(input.projectId)) {
    return {
      allow: false,
      code: "project_scope_denied",
      message: "Authority does not include the requested project.",
    };
  }
  if (!authority.capabilities.includes(definition.capability)) {
    return {
      allow: false,
      code: "capability_denied",
      message: `Authority does not include ${definition.capability}.`,
      details: { requiredCapability: definition.capability },
    };
  }
  return { allow: true };
}

function grantSnapshot(authority: ScientOperationAuthority): ScientOperationGrantSnapshot {
  const immutable = makeScientOperationAuthority(authority);
  const grantHash = sha256Canonical(immutable);
  return Object.freeze({ ...immutable, grantHash });
}

export type BeginScientOperationResult =
  | {
      readonly allow: false;
      readonly decision: Exclude<ScientOperationAuthorizationDecision, { readonly allow: true }>;
    }
  | { readonly allow: true; readonly envelope: ScientOperationRequestEnvelope };

/** Authorizes and creates the envelope as one unskippable operation. */
export function beginScientOperation(input: {
  readonly authority: ScientOperationAuthority;
  readonly definition: ScientOperationDefinition;
  readonly projectId: string;
  readonly ingress: ScientOperationIngress;
  readonly operationId: string;
  readonly semanticIdempotencyIdentity?: string | null;
  readonly payloadFingerprint: string;
  readonly receivedAt: number;
  readonly parentOperationId?: string | null;
}): BeginScientOperationResult {
  const resolvedAuthority = makeScientOperationAuthority(input.authority);
  const decision = authorize({
    authority: resolvedAuthority,
    definition: input.definition,
    projectId: input.projectId,
    now: input.receivedAt,
  });
  if (!decision.allow) return { allow: false, decision };

  const authority = grantSnapshot(resolvedAuthority);
  const semanticIdentity = input.semanticIdempotencyIdentity?.trim() || null;
  const identity = semanticIdentity ?? input.operationId;
  const claimKey = sha256Canonical([
    authority.authorityId,
    authority.generation,
    authority.actor,
    input.projectId,
    input.definition.id,
    identity,
  ]);
  const envelope: ScientOperationRequestEnvelope = Object.freeze({
    operationId: input.operationId,
    operation: input.definition.id,
    capability: input.definition.capability,
    projectId: input.projectId,
    authority,
    ingress: input.ingress,
    parentOperationId: input.parentOperationId ?? null,
    idempotency: Object.freeze({
      mode: semanticIdentity === null ? "unique" : "semantic",
      identity,
      claimKey,
      payloadFingerprint: input.payloadFingerprint,
    }),
    receivedAt: input.receivedAt,
  });
  return { allow: true, envelope };
}

export interface ScientOperationEffectIdentity {
  readonly kind: "orchestration-command" | "record" | "artifact" | "external-effect";
  readonly identity: string;
  readonly contentHash?: string;
}

export interface ScientOperationResultReceipt {
  readonly receiptId: string;
  readonly operationId: string;
  readonly operation: ScientOperationId;
  readonly projectId: string;
  readonly grantHash: string;
  readonly authorityGeneration: string;
  readonly authorization: "allowed";
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly outcome: "succeeded" | "failed" | "uncertain/reconciliation-required";
  readonly errorCode: string | null;
  readonly effects: ReadonlyArray<ScientOperationEffectIdentity>;
}

export function completeScientOperation(input: {
  readonly envelope: ScientOperationRequestEnvelope;
  readonly receiptId: string;
  readonly finishedAt: number;
  readonly outcome: ScientOperationResultReceipt["outcome"];
  readonly errorCode?: string | null;
  readonly effects?: ReadonlyArray<ScientOperationEffectIdentity>;
}): ScientOperationResultReceipt {
  return Object.freeze({
    receiptId: input.receiptId,
    operationId: input.envelope.operationId,
    operation: input.envelope.operation,
    projectId: input.envelope.projectId,
    grantHash: input.envelope.authority.grantHash,
    authorityGeneration: input.envelope.authority.generation,
    authorization: "allowed",
    startedAt: input.envelope.receivedAt,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
    effects: Object.freeze((input.effects ?? []).map((effect) => Object.freeze({ ...effect }))),
  });
}
