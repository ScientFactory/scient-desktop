/**
 * Automation-owned authority for the existing provider gateway.
 *
 * A run stores only an immutable, versioned grant origin. At MCP ingress the
 * host resolves that origin against the exact projected pending message and
 * running turn, then constructs the central Scient operation authority. This
 * keeps provider credentials, sessions, and model-controlled input out of the
 * grant while making cancellation, replacement, restart, expiry, and scope
 * changes fail closed.
 */
import { createHash, randomUUID } from "node:crypto";

import type {
  AutomationDefinition,
  AutomationOperationGrantSnapshot,
  AutomationRun,
  MessageId,
  ProviderKind,
  ThreadId,
  TurnId,
  AutomationAllowedCapability,
} from "@synara/contracts";

import type { ProjectionTurnById } from "../persistence/Services/ProjectionTurns.ts";
import {
  makeScientOperationAuthority,
  type ScientOperationAuthority,
  type ScientOperationCapability,
} from "./authority.ts";

export const SCIENT_AUTOMATION_OPERATION_GRANT_VERSION = 1 as const;
export const SCIENT_AUTOMATION_OPERATION_GRANT_MAX_LEASE_MS = 60 * 60 * 1_000;

type AutomationGrantCapability = AutomationOperationGrantSnapshot["capabilities"][number];

const BASE_AUTOMATION_CAPABILITIES = Object.freeze([
  "project:context:read",
  "thread:list",
  "thread:read",
] as const satisfies ReadonlyArray<ScientOperationCapability>);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable policy version; excludes scheduler bookkeeping such as nextRunAt and iterationCount. */
export function automationOperationPolicyVersion(definition: AutomationDefinition): string {
  return `sha256:${sha256(
    JSON.stringify([
      "scient-automation-operation-policy-v1",
      definition.id,
      definition.projectId,
      definition.sourceThreadId,
      definition.name,
      definition.prompt,
      definition.schedule,
      definition.enabled,
      definition.modelSelection,
      definition.providerOptions ?? null,
      definition.runtimeMode,
      definition.interactionMode,
      definition.worktreeMode,
      definition.mode,
      definition.targetThreadId,
      definition.maxIterations,
      definition.maxRuntimeSeconds,
      definition.stopOnError,
      definition.completionPolicy,
      definition.completionPolicyVersion,
      definition.minimumIntervalSeconds,
      definition.retryPolicy,
      definition.misfirePolicy,
      [...definition.acknowledgedRisks].toSorted(),
    ]),
  )}`;
}

/** Process-local epoch: persisted as a one-way hash, never used as a credential. */
export const SCIENT_AUTOMATION_OPERATION_RUNTIME_EPOCH_HASH =
  `sha256:${sha256(`scient-automation-operation-epoch:v1:${randomUUID()}`)}` as const;

export class ScientAutomationOperationAuthorityError extends Error {
  readonly code = "automation_authority_inactive";
}

function fail(message: string): never {
  throw new ScientAutomationOperationAuthorityError(message);
}

function operationCapabilitiesForSnapshot(
  allowedCapabilities: AutomationRun["permissionSnapshot"]["allowedCapabilities"],
): ReadonlyArray<AutomationGrantCapability> {
  return Object.freeze([
    ...BASE_AUTOMATION_CAPABILITIES,
    ...(allowedCapabilities.includes("send-turn") ? (["thread:drive"] as const) : []),
  ]);
}

function sameStringSet(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return (
    new Set(actual).size === actual.length &&
    [...actual].toSorted().join("\0") === [...expected].toSorted().join("\0")
  );
}

/** Existing automation policy projected into the immutable run snapshot. */
export function automationAllowedCapabilitiesForDefinition(
  definition: AutomationDefinition,
): AutomationAllowedCapability[] {
  const capabilities: AutomationAllowedCapability[] = ["send-turn"];
  if (definition.worktreeMode !== "local") capabilities.push("create-worktree");
  if (definition.runtimeMode === "full-access") capabilities.push("full-access");
  return capabilities;
}

export function makeAutomationOperationGrantSnapshot(input: {
  readonly definition: AutomationDefinition;
  readonly runId: AutomationRun["id"];
  readonly threadId: ThreadId;
  readonly pendingMessageId: MessageId;
  readonly allowedCapabilities: AutomationRun["permissionSnapshot"]["allowedCapabilities"];
  readonly issuedAt: string;
  readonly runtimeEpochHash?: string;
}): AutomationOperationGrantSnapshot {
  const issuedAtMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return fail("Automation operation grant issue time is invalid.");
  }
  const requestedLeaseMs =
    input.definition.maxRuntimeSeconds === null
      ? SCIENT_AUTOMATION_OPERATION_GRANT_MAX_LEASE_MS
      : input.definition.maxRuntimeSeconds * 1_000;
  const leaseMs = Math.min(requestedLeaseMs, SCIENT_AUTOMATION_OPERATION_GRANT_MAX_LEASE_MS);
  const capabilities = operationCapabilitiesForSnapshot(input.allowedCapabilities);
  return Object.freeze({
    version: SCIENT_AUTOMATION_OPERATION_GRANT_VERSION,
    runtimeEpochHash: input.runtimeEpochHash ?? SCIENT_AUTOMATION_OPERATION_RUNTIME_EPOCH_HASH,
    automationVersion: automationOperationPolicyVersion(input.definition),
    automationId: input.definition.id,
    runId: input.runId,
    projectId: input.definition.projectId,
    threadId: input.threadId,
    pendingMessageId: input.pendingMessageId,
    capabilities: Object.freeze([...capabilities]),
    issuedAt: input.issuedAt,
    leaseExpiresAt: new Date(issuedAtMs + leaseMs).toISOString(),
  });
}

export interface ResolveAutomationOperationAuthorityInput {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  readonly turn: ProjectionTurnById;
  readonly caller: {
    readonly projectId: string;
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly turnId: TurnId;
  };
  readonly now: number;
  readonly runtimeEpochHash?: string;
}

/** Resolve and validate one exact automation-owned authority. */
export function resolveAutomationOperationAuthority(
  input: ResolveAutomationOperationAuthorityInput,
): ScientOperationAuthority {
  const { definition, run, turn, caller } = input;
  const grant = run.permissionSnapshot.operationGrant;
  if (grant === null || grant === undefined) {
    return fail("This automation run has no versioned Scient operation grant.");
  }
  if (grant.version !== SCIENT_AUTOMATION_OPERATION_GRANT_VERSION) {
    return fail("This automation operation grant version is unsupported.");
  }
  if (
    grant.runtimeEpochHash !==
    (input.runtimeEpochHash ?? SCIENT_AUTOMATION_OPERATION_RUNTIME_EPOCH_HASH)
  ) {
    return fail("This automation operation grant belongs to a previous Scient runtime.");
  }
  if (
    definition.id !== run.automationId ||
    definition.id !== grant.automationId ||
    automationOperationPolicyVersion(definition) !== grant.automationVersion ||
    definition.projectId !== run.projectId ||
    definition.projectId !== grant.projectId ||
    definition.archivedAt !== null
  ) {
    return fail("The automation definition or project scope changed after grant issuance.");
  }
  if (
    run.id !== grant.runId ||
    run.status !== "running" ||
    run.finishedAt !== null ||
    run.startedAt === null ||
    run.threadId !== grant.threadId ||
    run.messageId !== grant.pendingMessageId ||
    run.projectId !== caller.projectId ||
    run.threadId !== caller.threadId
  ) {
    return fail("The automation run is no longer active in its granted scope.");
  }
  if (
    turn.threadId !== caller.threadId ||
    turn.turnId !== caller.turnId ||
    turn.pendingMessageId !== grant.pendingMessageId ||
    turn.state !== "running" ||
    (run.turnId !== null && run.turnId !== undefined && run.turnId !== caller.turnId)
  ) {
    return fail("The provider request is not authorized by this automation run's exact turn.");
  }
  if (run.permissionSnapshot.provider !== caller.provider) {
    return fail("The automation provider no longer matches the granted provider.");
  }
  if (
    run.permissionSnapshot.provider !== definition.modelSelection.provider ||
    JSON.stringify(run.permissionSnapshot.modelSelection) !==
      JSON.stringify(definition.modelSelection) ||
    run.permissionSnapshot.completionPolicyVersion !== definition.completionPolicyVersion ||
    run.permissionSnapshot.runtimeMode !== definition.runtimeMode ||
    run.permissionSnapshot.interactionMode !== definition.interactionMode ||
    run.permissionSnapshot.worktreeMode !== definition.worktreeMode ||
    run.permissionSnapshot.createdAt !== grant.issuedAt ||
    !sameStringSet(
      run.permissionSnapshot.allowedCapabilities,
      automationAllowedCapabilitiesForDefinition(definition),
    )
  ) {
    return fail("The automation run permission snapshot no longer matches its definition.");
  }
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.leaseExpiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    input.now < issuedAt ||
    input.now >= expiresAt
  ) {
    return fail("The automation operation grant lease is not currently valid.");
  }
  const capabilities = operationCapabilitiesForSnapshot(run.permissionSnapshot.allowedCapabilities);
  if (!sameStringSet(grant.capabilities, capabilities)) {
    return fail("The automation operation grant capabilities do not match run policy.");
  }

  const grantIdentity = sha256(
    JSON.stringify(["scient-automation-operation-grant-v1", grant, caller.turnId, caller.provider]),
  );
  return makeScientOperationAuthority({
    authorityId: `automation-grant:${grantIdentity}`,
    generation: `automation-turn:${grantIdentity}`,
    actor: {
      kind: "automation-run",
      automationId: grant.automationId,
      runId: grant.runId,
      grantVersion: grant.version,
      automationVersion: grant.automationVersion,
      threadId: grant.threadId,
      pendingMessageId: grant.pendingMessageId,
      authorizingTurnId: caller.turnId,
    },
    projectIds: [grant.projectId],
    capabilities,
    issuedAt,
    expiresAt,
    revokedAt: null,
  });
}
