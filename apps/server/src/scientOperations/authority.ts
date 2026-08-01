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
  /** Host admission required before an adapter may execute the operation. */
  readonly admission: "current-authority" | "write-authority";
  /** Effect boundary controls revocation and receipt handling. */
  readonly effectClass: "read" | "transactional-write" | "irreversible-external";
  /** Optional validated logical retry identity field exposed by an adapter. */
  readonly idempotencyInputField: string | null;
  /** Canonical domain input shared by every ingress adapter, or null until specified. */
  readonly canonicalizeInput:
    | ((input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>)
    | null;
}

function defineScientOperation(
  input: Omit<ScientOperationDefinition, "canonicalizeInput">,
): ScientOperationDefinition {
  return Object.freeze({
    ...input,
    allowedActorKinds: Object.freeze([...new Set(input.allowedActorKinds)]),
    canonicalizeInput: canonicalInputForOperation(input.id),
  });
}

const ALL_ACTORS: ReadonlyArray<ScientOperationActorKind> = Object.freeze([
  "manual-user",
  "provider-thread",
  "external-integration",
  "automation-run",
]);
const EXECUTION_ACTORS: ReadonlyArray<ScientOperationActorKind> = Object.freeze([
  "manual-user",
  "provider-thread",
  "external-integration",
  "automation-run",
]);

export class ScientOperationInputError extends Error {}

function canonicalString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  options?: { readonly required?: boolean; readonly maxUtf8Bytes?: number },
): string | undefined {
  const value = input[name];
  if (value === undefined || value === null) {
    if (options?.required) throw new ScientOperationInputError(`Missing required field "${name}".`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScientOperationInputError(`Field "${name}" must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (
    options?.maxUtf8Bytes !== undefined &&
    Buffer.byteLength(normalized, "utf8") > options.maxUtf8Bytes
  ) {
    throw new ScientOperationInputError(
      `Field "${name}" must be at most ${options.maxUtf8Bytes} UTF-8 bytes.`,
    );
  }
  return normalized;
}

function canonicalNumber(
  input: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScientOperationInputError(`Field "${name}" must be a finite number.`);
  }
  return value;
}

function canonicalBoolean(
  input: Readonly<Record<string, unknown>>,
  name: string,
): boolean | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ScientOperationInputError(`Field "${name}" must be a boolean.`);
  }
  return value;
}

const EMPTY_INPUT = () => Object.freeze({});
const canonicalThreadListInput = (input: Readonly<Record<string, unknown>>) => {
  const parentThreadId = canonicalString(input, "parentThreadId");
  return Object.freeze({
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    includeArchived: canonicalBoolean(input, "includeArchived") ?? false,
    limit: Math.max(1, Math.min(canonicalNumber(input, "limit") ?? 50, 200)),
  });
};
const canonicalThreadReadInput = (input: Readonly<Record<string, unknown>>) => {
  const cursor = canonicalString(input, "cursor");
  const messageLimit = canonicalNumber(input, "messageLimit");
  const maxMessageChars = canonicalNumber(input, "maxMessageChars");
  return Object.freeze({
    threadId: canonicalString(input, "threadId", { required: true })!,
    ...(cursor === undefined ? {} : { cursor }),
    ...(messageLimit === undefined ? {} : { messageLimit }),
    ...(maxMessageChars === undefined ? {} : { maxMessageChars }),
  });
};
const canonicalThreadWaitInput = (input: Readonly<Record<string, unknown>>) => {
  const rawThreadIds = input.threadIds;
  if (!Array.isArray(rawThreadIds) || rawThreadIds.length < 1 || rawThreadIds.length > 20) {
    throw new ScientOperationInputError('Field "threadIds" must contain 1 to 20 thread IDs.');
  }
  const threadIds = rawThreadIds.map(
    (value) => canonicalString({ value }, "value", { required: true })!,
  );
  const rawRunIds = input.runIds;
  let runIds: ReadonlyArray<string | null> | undefined;
  if (rawRunIds !== undefined) {
    if (!Array.isArray(rawRunIds) || rawRunIds.length !== threadIds.length) {
      throw new ScientOperationInputError(
        'Field "runIds" must have the same length as "threadIds".',
      );
    }
    runIds = Object.freeze(
      rawRunIds.map((value) =>
        value === null ? null : canonicalString({ value }, "value", { required: true })!,
      ),
    );
  }
  const timeoutMs = canonicalNumber(input, "timeoutMs") ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new ScientOperationInputError('Field "timeoutMs" must be an integer from 0 to 60000.');
  }
  return Object.freeze({
    threadIds: Object.freeze(threadIds),
    ...(runIds === undefined ? {} : { runIds }),
    timeoutMs,
  });
};
const canonicalSendInput = (input: Readonly<Record<string, unknown>>) => {
  const mode = canonicalString(input, "mode") ?? "queue";
  if (mode !== "queue" && mode !== "steer") {
    throw new ScientOperationInputError('Field "mode" must be "queue" or "steer".');
  }
  const requestId = canonicalString(input, "requestId", { maxUtf8Bytes: 256 });
  return Object.freeze({
    threadId: canonicalString(input, "threadId", { required: true })!,
    message: canonicalString(input, "message", {
      required: true,
      maxUtf8Bytes: 512 * 1024,
    })!,
    mode,
    ...(requestId === undefined ? {} : { requestId }),
  });
};
const canonicalInterruptInput = (input: Readonly<Record<string, unknown>>) =>
  Object.freeze({
    threadId: canonicalString(input, "threadId", { required: true })!,
  });

function canonicalInputForOperation(
  operation: ScientOperationId,
): ScientOperationDefinition["canonicalizeInput"] {
  switch (operation) {
    case "project.context.read":
    case "project.list":
      return EMPTY_INPUT;
    case "thread.list":
      return canonicalThreadListInput;
    case "thread.read":
      return canonicalThreadReadInput;
    case "thread.wait":
      return canonicalThreadWaitInput;
    case "thread.message.send":
      return canonicalSendInput;
    case "thread.interrupt":
      return canonicalInterruptInput;
    default:
      // Future operation families stay unexecutable until their Scient-owned
      // domain input contract is deliberately defined here.
      return null;
  }
}

/**
 * Canonical Scient-owned operation policy. Adapters reference these immutable
 * entries; they cannot redefine an operation's capability, actor set,
 * admission rule, or effect class locally.
 */
export const SCIENT_OPERATION_DEFINITIONS: Readonly<
  Record<ScientOperationId, ScientOperationDefinition>
> = Object.freeze({
  "project.context.read": defineScientOperation({
    id: "project.context.read",
    capability: "project:context:read",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "project.list": defineScientOperation({
    id: "project.list",
    capability: "project:context:read",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "thread.list": defineScientOperation({
    id: "thread.list",
    capability: "thread:list",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "thread.read": defineScientOperation({
    id: "thread.read",
    capability: "thread:read",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "thread.wait": defineScientOperation({
    id: "thread.wait",
    capability: "thread:read",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "thread.message.send": defineScientOperation({
    id: "thread.message.send",
    capability: "thread:drive",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "transactional-write",
    idempotencyInputField: "requestId",
  }),
  "thread.interrupt": defineScientOperation({
    id: "thread.interrupt",
    capability: "thread:drive",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "transactional-write",
    idempotencyInputField: null,
  }),
  "automation.run": defineScientOperation({
    id: "automation.run",
    capability: "automation:run",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "transactional-write",
    idempotencyInputField: "requestId",
  }),
  "browser.read": defineScientOperation({
    id: "browser.read",
    capability: "browser:read",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "browser.capture": defineScientOperation({
    id: "browser.capture",
    capability: "browser:capture",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "irreversible-external",
    idempotencyInputField: "requestId",
  }),
  "browser.action": defineScientOperation({
    id: "browser.action",
    capability: "browser:action",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "irreversible-external",
    idempotencyInputField: "requestId",
  }),
  "scientific-record.propose": defineScientOperation({
    id: "scientific-record.propose",
    capability: "scientific-record:propose",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "transactional-write",
    idempotencyInputField: "requestId",
  }),
  "scientific-record.accept": defineScientOperation({
    id: "scientific-record.accept",
    capability: "scientific-record:accept",
    allowedActorKinds: ["manual-user"],
    admission: "write-authority",
    effectClass: "transactional-write",
    idempotencyInputField: "requestId",
  }),
  "project-file.read": defineScientOperation({
    id: "project-file.read",
    capability: "project-file:read",
    allowedActorKinds: ALL_ACTORS,
    admission: "current-authority",
    effectClass: "read",
    idempotencyInputField: null,
  }),
  "project-file.write": defineScientOperation({
    id: "project-file.write",
    capability: "project-file:write",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "irreversible-external",
    idempotencyInputField: "requestId",
  }),
  "export.run": defineScientOperation({
    id: "export.run",
    capability: "export:run",
    allowedActorKinds: EXECUTION_ACTORS,
    admission: "write-authority",
    effectClass: "irreversible-external",
    idempotencyInputField: "requestId",
  }),
});

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

function structuredIdentity(value: string, field: string, maxUtf8Bytes = 512): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > maxUtf8Bytes
  ) {
    throw new ScientOperationInputError(`${field} is not a bounded structured identity.`);
  }
  return value;
}

function validateActorIdentity(actor: ScientOperationActor): void {
  switch (actor.kind) {
    case "provider-thread":
      structuredIdentity(actor.threadId, "actor.threadId");
      structuredIdentity(actor.provider, "actor.provider", 128);
      structuredIdentity(actor.sessionKey, "actor.sessionKey");
      return;
    case "automation-run":
      structuredIdentity(actor.automationId, "actor.automationId");
      structuredIdentity(actor.runId, "actor.runId");
      return;
    case "external-integration":
      structuredIdentity(actor.integrationId, "actor.integrationId");
      return;
    case "manual-user":
      structuredIdentity(actor.userId, "actor.userId");
      return;
  }
}

export function makeScientOperationAuthority(
  input: ScientOperationAuthority,
): ScientOperationAuthority {
  structuredIdentity(input.authorityId, "authorityId");
  structuredIdentity(input.generation, "generation");
  validateActorIdentity(input.actor);
  for (const projectId of input.projectIds) structuredIdentity(projectId, "projectId");
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
  readonly claimKeyVersion: 2;
  readonly semanticIdentityHash: string;
  readonly actorScopeHash: string;
  /**
   * Unique claims include the current grant generation. Semantic v2 claims
   * instead bind project, operation, trusted actor scope, and logical identity
   * so an exact same-turn retry survives credential/session replacement.
   */
  readonly claimKey: string;
  /** Compared separately so reuse with different input becomes a conflict. */
  readonly payloadFingerprint: string;
}

export type ScientOperationSemanticRetryScope =
  | {
      readonly kind: "provider-turn";
      readonly provider: string;
      readonly callerThreadId: string;
      readonly callerTurnId: string;
    }
  | {
      readonly kind: "automation-run";
      readonly automationId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "external-integration";
      readonly integrationId: string;
    }
  | {
      readonly kind: "manual-user";
      readonly userIdHash: string;
    };

function validateSemanticRetryScope(
  scope: ScientOperationSemanticRetryScope | null | undefined,
  actor: ScientOperationActor,
): ScientOperationSemanticRetryScope {
  if (scope === null || scope === undefined || typeof scope !== "object") {
    throw new ScientOperationInputError(
      "Semantic idempotency requires a trusted stable retry scope.",
    );
  }
  const expectedKeys: ReadonlyArray<string> =
    scope.kind === "provider-turn"
      ? ["callerThreadId", "callerTurnId", "kind", "provider"]
      : scope.kind === "automation-run"
        ? ["automationId", "kind", "runId"]
        : scope.kind === "external-integration"
          ? ["integrationId", "kind"]
          : scope.kind === "manual-user"
            ? ["kind", "userIdHash"]
            : [];
  if (
    expectedKeys.length === 0 ||
    Object.keys(scope).toSorted().join("\0") !== expectedKeys.join("\0") ||
    expectedKeys.some(
      (key) => key !== "kind" && typeof (scope as Record<string, unknown>)[key] !== "string",
    ) ||
    expectedKeys.some(
      (key) => key !== "kind" && (scope as Record<string, string>)[key]?.length === 0,
    ) ||
    expectedKeys.some(
      (key) =>
        key !== "kind" &&
        Buffer.byteLength((scope as Record<string, string>)[key] ?? "", "utf8") > 512,
    )
  ) {
    throw new ScientOperationInputError("Semantic retry scope is malformed or unsupported.");
  }
  switch (scope.kind) {
    case "provider-turn":
      structuredIdentity(scope.provider, "semanticRetryScope.provider", 128);
      structuredIdentity(scope.callerThreadId, "semanticRetryScope.callerThreadId");
      structuredIdentity(scope.callerTurnId, "semanticRetryScope.callerTurnId");
      break;
    case "automation-run":
      structuredIdentity(scope.automationId, "semanticRetryScope.automationId");
      structuredIdentity(scope.runId, "semanticRetryScope.runId");
      break;
    case "external-integration":
      structuredIdentity(scope.integrationId, "semanticRetryScope.integrationId");
      break;
    case "manual-user":
      if (!/^[a-f0-9]{64}$/u.test(scope.userIdHash)) {
        throw new ScientOperationInputError(
          "semanticRetryScope.userIdHash is not a bounded structured hash.",
        );
      }
      break;
  }
  const matchesActor =
    (scope.kind === "provider-turn" &&
      actor.kind === "provider-thread" &&
      scope.provider === actor.provider &&
      scope.callerThreadId === actor.threadId) ||
    (scope.kind === "automation-run" &&
      actor.kind === "automation-run" &&
      scope.automationId === actor.automationId &&
      scope.runId === actor.runId) ||
    (scope.kind === "external-integration" &&
      actor.kind === "external-integration" &&
      scope.integrationId === actor.integrationId) ||
    (scope.kind === "manual-user" &&
      actor.kind === "manual-user" &&
      scope.userIdHash === sha256Canonical(["scient-operation-manual-user-v2", actor.userId]));
  if (!matchesActor) {
    throw new ScientOperationInputError(
      "Semantic retry scope does not match the authorized actor.",
    );
  }
  return Object.freeze({ ...scope });
}

export interface ScientOperationRequestEnvelope {
  readonly operationId: string;
  readonly operation: ScientOperationId;
  readonly capability: ScientOperationCapability;
  readonly projectId: string;
  readonly authority: ScientOperationGrantSnapshot;
  readonly ingress: ScientOperationIngress;
  readonly parentOperationId: string | null;
  /** Trusted current provider turn used only for audit attribution. */
  readonly providerAuthorizingTurnId: string | null;
  readonly semanticRetryScope: ScientOperationSemanticRetryScope | null;
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
  /** Trusted host scope for semantic retries; never derived from bearer/session credentials. */
  readonly semanticIdempotencyScope?: ScientOperationSemanticRetryScope | null;
  readonly payloadFingerprint: string;
  readonly receivedAt: number;
  readonly parentOperationId?: string | null;
  readonly providerAuthorizingTurnId?: string | null;
}): BeginScientOperationResult {
  structuredIdentity(input.projectId, "projectId");
  structuredIdentity(input.operationId, "operationId");
  if (input.parentOperationId !== undefined && input.parentOperationId !== null) {
    structuredIdentity(input.parentOperationId, "parentOperationId");
  }
  if (input.providerAuthorizingTurnId !== undefined && input.providerAuthorizingTurnId !== null) {
    if (input.authority.actor.kind !== "provider-thread") {
      throw new ScientOperationInputError(
        "Only a provider-thread actor can carry an authorizing turn.",
      );
    }
    structuredIdentity(input.providerAuthorizingTurnId, "providerAuthorizingTurnId");
  }
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
  const semanticScope =
    semanticIdentity === null
      ? null
      : validateSemanticRetryScope(input.semanticIdempotencyScope, authority.actor);
  if (
    semanticScope?.kind === "provider-turn" &&
    input.providerAuthorizingTurnId !== undefined &&
    input.providerAuthorizingTurnId !== null &&
    input.providerAuthorizingTurnId !== semanticScope.callerTurnId
  ) {
    throw new ScientOperationInputError(
      "Provider authorizing turn must match the semantic retry turn.",
    );
  }
  const providerAuthorizingTurnId =
    input.providerAuthorizingTurnId ??
    (semanticScope?.kind === "provider-turn" ? semanticScope.callerTurnId : null);
  // Never retain caller/model-controlled retry text in an authoritative
  // envelope. A one-way digest preserves stable retry identity without turning
  // receipts or audit adapters into a secret/path disclosure channel.
  const identity =
    semanticIdentity === null
      ? input.operationId
      : sha256Canonical(["semantic-idempotency", semanticIdentity]);
  const actorScopeHash = sha256Canonical([
    "scient-operation-actor-scope-v2",
    semanticScope ?? {
      actorKind: authority.actor.kind,
      authorityId: authority.authorityId,
      authorityGeneration: authority.generation,
    },
  ]);
  const semanticIdentityHash = sha256Canonical(["scient-operation-semantic-identity-v2", identity]);
  const claimKey =
    semanticIdentity === null
      ? sha256Canonical([
          authority.authorityId,
          authority.generation,
          authority.actor,
          input.projectId,
          input.definition.id,
          identity,
        ])
      : sha256Canonical([
          "scient-operation-claim-v2",
          input.projectId,
          input.definition.id,
          actorScopeHash,
          semanticIdentityHash,
        ]);
  const envelope: ScientOperationRequestEnvelope = Object.freeze({
    operationId: input.operationId,
    operation: input.definition.id,
    capability: input.definition.capability,
    projectId: input.projectId,
    authority,
    ingress: input.ingress,
    parentOperationId: input.parentOperationId ?? null,
    providerAuthorizingTurnId,
    semanticRetryScope: semanticScope,
    idempotency: Object.freeze({
      mode: semanticIdentity === null ? "unique" : "semantic",
      identity,
      claimKeyVersion: 2,
      semanticIdentityHash,
      actorScopeHash,
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
