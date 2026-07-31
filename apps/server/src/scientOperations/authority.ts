/**
 * Host-independent authority contract for Scient operations.
 *
 * Ingress adapters resolve this authority from trusted host state. Operation
 * handlers may inspect it, but client-, model-, page-, and prompt-supplied
 * fields never become authority merely by matching this shape.
 *
 * @module scientOperations/authority
 */

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

export type ScientOperationActor =
  | {
      readonly kind: "manual-user";
      readonly userId: string;
    }
  | {
      readonly kind: "provider-thread";
      readonly threadId: string;
      readonly provider: string;
      readonly sessionKey: string;
    }
  | {
      readonly kind: "external-integration";
      readonly integrationId: string;
    }
  | {
      readonly kind: "automation-run";
      readonly automationId: string;
      readonly runId: string;
    };

export type ScientOperationActorKind = ScientOperationActor["kind"];

export interface ScientOperationAuthority {
  readonly authorityId: string;
  /** Changes whenever the host replaces, narrows, or revokes the grant. */
  readonly generation: string;
  readonly actor: ScientOperationActor;
  readonly projectIds: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<ScientOperationCapability>;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export type ScientOperationIngress =
  | "manual-ui"
  | "provider-gateway"
  | "external-mcp"
  | "automation"
  | "browser";

export interface ScientOperationRequestEnvelope {
  readonly operationId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly capability: ScientOperationCapability;
  readonly projectId: string;
  readonly actor: ScientOperationActor;
  readonly authorityId: string;
  readonly authorityGeneration: string;
  readonly ingress: ScientOperationIngress;
  readonly parentOperationId: string | null;
  /** Hash of the canonical operation payload; raw inputs are not duplicated. */
  readonly payloadFingerprint: string;
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

export function authorizeScientOperation(input: {
  readonly authority: ScientOperationAuthority;
  readonly capability: ScientOperationCapability;
  readonly projectId: string;
  readonly allowedActorKinds: ReadonlySet<ScientOperationActorKind>;
  readonly now: number;
}): ScientOperationAuthorizationDecision {
  const { authority } = input;
  if (authority.revokedAt !== null) {
    return {
      allow: false,
      code: "authority_revoked",
      message: "This Scient operation authority has been revoked.",
    };
  }
  if (input.now < authority.issuedAt) {
    return {
      allow: false,
      code: "authority_not_yet_valid",
      message: "This Scient operation authority is not valid yet.",
    };
  }
  if (authority.expiresAt !== null && input.now >= authority.expiresAt) {
    return {
      allow: false,
      code: "authority_expired",
      message: "This Scient operation authority has expired.",
    };
  }
  if (!input.allowedActorKinds.has(authority.actor.kind)) {
    return {
      allow: false,
      code: "actor_kind_denied",
      message: "This actor kind is not authorized for the Scient operation.",
      details: { actorKind: authority.actor.kind },
    };
  }
  if (!authority.projectIds.has(input.projectId)) {
    return {
      allow: false,
      code: "project_scope_denied",
      message: "This Scient operation authority does not include the requested project.",
    };
  }
  if (!authority.capabilities.has(input.capability)) {
    return {
      allow: false,
      code: "capability_denied",
      message: `This Scient operation authority does not include ${input.capability}.`,
      details: { requiredCapability: input.capability },
    };
  }
  return { allow: true };
}

export function makeScientOperationRequestEnvelope(input: {
  readonly authority: ScientOperationAuthority;
  readonly operationId: string;
  readonly operation: string;
  readonly capability: ScientOperationCapability;
  readonly projectId: string;
  readonly ingress: ScientOperationIngress;
  readonly idempotencyIdentity: string;
  readonly payloadFingerprint: string;
  readonly receivedAt: number;
  readonly parentOperationId?: string | null;
}): ScientOperationRequestEnvelope {
  const actorIdentity = (() => {
    switch (input.authority.actor.kind) {
      case "manual-user":
        return `manual-user:${input.authority.actor.userId}`;
      case "provider-thread":
        return `provider-thread:${input.authority.actor.provider}:${input.authority.actor.threadId}:${input.authority.actor.sessionKey}`;
      case "external-integration":
        return `external-integration:${input.authority.actor.integrationId}`;
      case "automation-run":
        return `automation-run:${input.authority.actor.automationId}:${input.authority.actor.runId}`;
    }
  })();
  const idempotencyKey = [
    input.authority.authorityId,
    input.authority.generation,
    actorIdentity,
    input.projectId,
    input.operation,
    input.capability,
    input.idempotencyIdentity,
    input.payloadFingerprint,
  ].join(":");
  return {
    operationId: input.operationId,
    operation: input.operation,
    idempotencyKey,
    capability: input.capability,
    projectId: input.projectId,
    actor: input.authority.actor,
    authorityId: input.authority.authorityId,
    authorityGeneration: input.authority.generation,
    ingress: input.ingress,
    parentOperationId: input.parentOperationId ?? null,
    payloadFingerprint: input.payloadFingerprint,
    receivedAt: input.receivedAt,
  };
}
