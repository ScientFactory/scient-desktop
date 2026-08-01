/**
 * In-process authority kernel for production-dark browser evidence contracts.
 *
 * The kernel is intentionally not composed into the server. It proves the
 * authorization and immutable-ledger transitions that a later durable adapter
 * must preserve. Process restart durability is intentionally out of scope.
 *
 * @module browserEvidence/authority
 */
import { randomUUID } from "node:crypto";

import {
  type ScientOperationAuthority,
  type ScientOperationRequestEnvelope,
  makeScientOperationAuthority,
} from "../scientOperations/authority.ts";
import {
  BROWSER_EVIDENCE_CAPABILITY_BY_OPERATION,
  MAX_AUTOMATION_CONTEXT_RECEIPTS_PER_PROPOSAL,
  MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS,
  MAX_BROWSER_EVIDENCE_LEASE_TTL_MS,
  MAX_BROWSER_EVIDENCE_REUSE_COUNT,
  MAX_EVIDENCE_RECEIPTS_PER_PROPOSAL,
  MAX_EVIDENCE_RECEIPTS_PER_VERIFICATION,
  MAX_VERIFICATION_RECEIPTS_PER_MANUAL_DECISION,
  SCIENT_OPERATION_BY_BROWSER_EVIDENCE_CLASS,
  SCIENTIFIC_VERIFICATION_OUTCOMES,
  BrowserEvidenceContractError,
  type BrowserDocumentIdentity,
  type BrowserEvidenceLeaseGrant,
  type BrowserEvidenceLeaseSnapshot,
  type BrowserEvidenceLeaseUseDecision,
  type BrowserEvidenceLeaseUsePolicy,
  type BrowserEvidenceLeaseUseReceipt,
  type BrowserEvidenceOperationClass,
  type HostileContentProvenanceEnvelope,
  type ManualScientificDecision,
  type ManualScientificDecisionReceipt,
  type ScientificAnnotationReceipt,
  type ScientificEvidenceReceipt,
  type ScientificProposalReceipt,
  type ScientificSourceReceipt,
  type ScientificVerificationReceipt,
  browserEvidenceActorBindingHash,
  browserEvidenceDigest,
  browserEvidenceHash,
  browserEvidencePayloadFingerprint,
  browserEvidenceStructuredIdentity,
  makeBrowserDocumentIdentity,
  makeHostileContentProvenanceEnvelope,
  sameBrowserDocument,
} from "./contracts.ts";

interface LeaseState {
  readonly grant: BrowserEvidenceLeaseGrant;
  readonly usesByOperationId: Map<string, BrowserEvidenceLeaseUseReceipt>;
  revokedAt: number | null;
  revocationReason: "host-revoked" | null;
}

export const BROWSER_EVIDENCE_KERNEL_EFFECT_KINDS = [
  "lease.issue",
  "lease.use",
  "receipt.source",
  "receipt.automation-memory",
  "receipt.annotation",
  "receipt.proposal",
  "receipt.verification",
  "receipt.manual-decision",
] as const;

export type BrowserEvidenceKernelEffectKind = (typeof BROWSER_EVIDENCE_KERNEL_EFFECT_KINDS)[number];

/**
 * Canonical domain input for the central operation executor. A future adapter
 * must fingerprint this exact value before invoking the matching kernel effect.
 */
export function browserEvidenceKernelPayloadFingerprint(
  kind: BrowserEvidenceKernelEffectKind,
  payload: Readonly<Record<string, unknown>>,
): string {
  return browserEvidencePayloadFingerprint({ kind, payload });
}

interface KernelOperationConsumption {
  readonly effectKind: BrowserEvidenceKernelEffectKind;
  readonly payloadFingerprint: string;
  readonly envelopeBindingHash: string;
  readonly value: unknown;
}

export interface IssueBrowserEvidenceLeaseInput {
  /**
   * Trusted host-minted operation envelope. Provider actor, project, thread,
   * and authorizing turn are derived from this envelope and never supplied as
   * independent caller claims.
   */
  readonly authorizingOperation: ScientOperationRequestEnvelope;
  readonly leaseId?: string;
  readonly document: BrowserDocumentIdentity;
  readonly operationClass: BrowserEvidenceOperationClass;
  readonly usePolicy: BrowserEvidenceLeaseUsePolicy;
  readonly ttlMs: number;
}

export interface AuthorizeBrowserEvidenceLeaseUseInput {
  readonly leaseId: string;
  /** Fresh host-minted envelope for this exact use; no raw authority claims. */
  readonly authorizedOperation: ScientOperationRequestEnvelope;
  readonly document: BrowserDocumentIdentity;
}

interface ReceiptActorInput {
  /** Exact host-minted propose/accept/export operation for this append. */
  readonly authorizedOperation: ScientOperationRequestEnvelope;
  readonly receiptId?: string;
}

type AutomationActorBinding = Extract<
  ScientOperationAuthority["actor"],
  { readonly kind: "automation-run" }
>;

function exactAutomationActorBinding(
  actor: ScientOperationAuthority["actor"],
): AutomationActorBinding {
  if (actor.kind !== "automation-run") {
    throw new BrowserEvidenceContractError(
      "actor_scope_denied",
      "An exact automation actor binding is required.",
    );
  }
  if (actor.grantVersion !== 1) {
    throw new BrowserEvidenceContractError(
      "actor_scope_denied",
      "An exact versioned automation actor binding is required.",
    );
  }
  return Object.freeze({
    kind: "automation-run",
    automationId: browserEvidenceStructuredIdentity(actor.automationId, "actor.automationId"),
    runId: browserEvidenceStructuredIdentity(actor.runId, "actor.runId"),
    grantVersion: 1,
    automationVersion: browserEvidenceStructuredIdentity(
      actor.automationVersion,
      "actor.automationVersion",
    ),
    threadId: browserEvidenceStructuredIdentity(actor.threadId, "actor.threadId"),
    pendingMessageId: browserEvidenceStructuredIdentity(
      actor.pendingMessageId,
      "actor.pendingMessageId",
    ),
    authorizingTurnId: browserEvidenceStructuredIdentity(
      actor.authorizingTurnId,
      "actor.authorizingTurnId",
    ),
  });
}

export interface RecordScientificSourceInput extends ReceiptActorInput {
  readonly leaseUseReceiptId: string;
  readonly provenance: HostileContentProvenanceEnvelope;
}

export interface RecordAutomationMemoryContextInput extends ReceiptActorInput {
  readonly provenance: HostileContentProvenanceEnvelope;
}

export interface RecordScientificAnnotationInput extends ReceiptActorInput {
  readonly leaseUseReceiptId: string;
  readonly sourceReceiptId: string;
  readonly targetDigest: string;
  readonly annotationDigest: string;
}

export interface RecordScientificProposalInput extends ReceiptActorInput {
  readonly claimDigest: string;
  readonly evidenceReceiptIds: ReadonlyArray<string>;
  readonly contextReceiptIds?: ReadonlyArray<string>;
}

export interface RecordScientificVerificationInput extends ReceiptActorInput {
  readonly proposalReceiptId: string;
  readonly evidenceReceiptIds: ReadonlyArray<string>;
  readonly outcome: ScientificVerificationReceipt["outcome"];
}

export interface RecordManualScientificDecisionInput extends ReceiptActorInput {
  readonly proposalReceiptId: string;
  readonly verificationReceiptIds: ReadonlyArray<string>;
  readonly decision: ManualScientificDecision;
}

export interface BrowserEvidenceAuthorityKernel {
  readonly issueLease: (input: IssueBrowserEvidenceLeaseInput) => BrowserEvidenceLeaseGrant;
  readonly getLease: (leaseId: string) => BrowserEvidenceLeaseSnapshot | null;
  readonly revokeLease: (input: { readonly leaseId: string }) => BrowserEvidenceLeaseSnapshot;
  readonly authorizeLeaseUse: (
    input: AuthorizeBrowserEvidenceLeaseUseInput,
  ) => BrowserEvidenceLeaseUseDecision;
  readonly recordSource: (input: RecordScientificSourceInput) => ScientificSourceReceipt;
  readonly recordAutomationMemoryContext: (
    input: RecordAutomationMemoryContextInput,
  ) => ScientificSourceReceipt;
  readonly recordAnnotation: (
    input: RecordScientificAnnotationInput,
  ) => ScientificAnnotationReceipt;
  readonly recordProposal: (input: RecordScientificProposalInput) => ScientificProposalReceipt;
  readonly recordVerification: (
    input: RecordScientificVerificationInput,
  ) => ScientificVerificationReceipt;
  readonly recordManualDecision: (
    input: RecordManualScientificDecisionInput,
  ) => ManualScientificDecisionReceipt;
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BrowserEvidenceContractError("invalid_time", `${field} must be a safe timestamp.`);
  }
}

function assertFreshEnvelope(envelope: ScientOperationRequestEnvelope, now: number): void {
  assertTimestamp(now, "host clock");
  assertTimestamp(envelope.receivedAt, "authorizedOperation.receivedAt");
  if (
    envelope.receivedAt > now ||
    now - envelope.receivedAt > MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS
  ) {
    throw new BrowserEvidenceContractError(
      "authority_inactive",
      "Authorized operation envelope is future-dated or stale.",
    );
  }
}

function assertActiveAuthority(
  authorityInput: ScientOperationAuthority,
  projectId: string,
  at: number,
): ScientOperationAuthority {
  assertTimestamp(at, "authority time");
  const authority = makeScientOperationAuthority(authorityInput);
  if (
    authority.revokedAt !== null ||
    at < authority.issuedAt ||
    (authority.expiresAt !== null && at >= authority.expiresAt)
  ) {
    throw new BrowserEvidenceContractError("authority_inactive", "Authority is not active.");
  }
  if (!authority.projectIds.includes(projectId)) {
    throw new BrowserEvidenceContractError(
      "authority_scope_denied",
      "Authority does not include the requested project.",
    );
  }
  return authority;
}

function assertCapability(
  authority: ScientOperationAuthority,
  capability: ScientOperationAuthority["capabilities"][number],
): void {
  if (!authority.capabilities.includes(capability)) {
    throw new BrowserEvidenceContractError(
      "capability_denied",
      `Authority does not include ${capability}.`,
    );
  }
}

function denial(
  code: Extract<BrowserEvidenceLeaseUseDecision, { readonly kind: "denied" }>["code"],
  message: string,
): BrowserEvidenceLeaseUseDecision {
  return Object.freeze({ kind: "denied", code, message });
}

function freezeIds(ids: unknown, field: string, maxReferences: number): ReadonlyArray<string> {
  if (!Array.isArray(ids) || ids.length > maxReferences) {
    throw new BrowserEvidenceContractError(
      "receipt_reference_invalid",
      `${field} must be an array with at most ${maxReferences} references.`,
    );
  }
  const validated = Array.from(ids, (id) => browserEvidenceStructuredIdentity(id, field));
  if (new Set(validated).size !== validated.length) {
    throw new BrowserEvidenceContractError("duplicate_identity", `${field} contains duplicates.`);
  }
  return Object.freeze(validated);
}

function immutableLeaseSnapshot(state: LeaseState): BrowserEvidenceLeaseSnapshot {
  return Object.freeze({
    ...state.grant,
    document: makeBrowserDocumentIdentity(state.grant.document),
    usePolicy: Object.freeze({ ...state.grant.usePolicy }),
    usedCount: state.usesByOperationId.size,
    revokedAt: state.revokedAt,
    revocationReason: state.revocationReason,
  });
}

function ensureUsePolicy(
  operationClass: BrowserEvidenceOperationClass,
  policy: BrowserEvidenceLeaseUsePolicy,
): BrowserEvidenceLeaseUsePolicy {
  if (policy.kind === "single-use" && policy.maxUses === 1) {
    return Object.freeze({ kind: "single-use", maxUses: 1 });
  }
  if (
    policy.kind !== "narrow-reuse" ||
    !Number.isSafeInteger(policy.maxUses) ||
    policy.maxUses < 2 ||
    policy.maxUses > MAX_BROWSER_EVIDENCE_REUSE_COUNT ||
    (operationClass !== "document.read" && operationClass !== "annotation.propose")
  ) {
    throw new BrowserEvidenceContractError(
      "invalid_lease_policy",
      "Only document reads and annotation proposals may use a bounded reusable lease.",
    );
  }
  return Object.freeze({ kind: "narrow-reuse", maxUses: policy.maxUses });
}

function deepFreezeReceipt<T extends ScientificEvidenceReceipt>(receipt: T): T {
  for (const value of Object.values(receipt)) {
    if (Array.isArray(value)) Object.freeze(value);
    else if (value !== null && typeof value === "object") Object.freeze(value);
  }
  return Object.freeze(receipt);
}

export function makeBrowserEvidenceAuthorityKernel(options?: {
  readonly randomId?: () => string;
  readonly now?: () => number;
}): BrowserEvidenceAuthorityKernel {
  const randomId = options?.randomId ?? randomUUID;
  const now = options?.now ?? Date.now;
  const leases = new Map<string, LeaseState>();
  const leaseUseReceipts = new Map<string, BrowserEvidenceLeaseUseReceipt>();
  const receipts = new Map<string, ScientificEvidenceReceipt>();
  const lastReceiptHashByScope = new Map<string, string>();
  const operationConsumptions = new Map<string, KernelOperationConsumption>();

  const operationEnvelopeBindingHash = (envelope: ScientOperationRequestEnvelope) =>
    browserEvidenceHash("kernel-operation-envelope-binding", {
      operation: envelope.operation,
      capability: envelope.capability,
      projectId: envelope.projectId,
      authority: envelope.authority,
      ingress: envelope.ingress,
      parentOperationId: envelope.parentOperationId,
      providerAuthorizingTurnId: envelope.providerAuthorizingTurnId,
      semanticRetryScope: envelope.semanticRetryScope,
      claimKey: envelope.idempotency.claimKey,
    });

  const operationReplay = <T>(
    envelope: ScientOperationRequestEnvelope,
    effectKind: BrowserEvidenceKernelEffectKind,
    payload: Readonly<Record<string, unknown>>,
  ): { readonly payloadFingerprint: string; readonly replay: T | null } => {
    const operationId = browserEvidenceStructuredIdentity(envelope.operationId, "operationId");
    const payloadFingerprint = browserEvidenceKernelPayloadFingerprint(effectKind, payload);
    const envelopeFingerprint = browserEvidenceDigest(
      envelope.idempotency.payloadFingerprint,
      "authorizedOperation.idempotency.payloadFingerprint",
    );
    if (envelopeFingerprint !== payloadFingerprint) {
      throw new BrowserEvidenceContractError(
        "operation_replay_conflict",
        "The operation payload does not match its host-minted payload fingerprint.",
      );
    }
    const consumed = operationConsumptions.get(operationId);
    if (consumed === undefined) return { payloadFingerprint, replay: null };
    const envelopeBindingHash = operationEnvelopeBindingHash(envelope);
    if (
      consumed.effectKind !== effectKind ||
      consumed.payloadFingerprint !== payloadFingerprint ||
      consumed.envelopeBindingHash !== envelopeBindingHash
    ) {
      throw new BrowserEvidenceContractError(
        "operation_replay_conflict",
        "Operation identity was already consumed by a different kernel effect or payload.",
      );
    }
    return { payloadFingerprint, replay: consumed.value as T };
  };

  const consumeOperation = <T>(
    envelope: ScientOperationRequestEnvelope,
    effectKind: BrowserEvidenceKernelEffectKind,
    payloadFingerprint: string,
    value: T,
  ): T => {
    operationConsumptions.set(envelope.operationId, {
      effectKind,
      payloadFingerprint,
      envelopeBindingHash: operationEnvelopeBindingHash(envelope),
      value,
    });
    return value;
  };

  const nextId = (prefix: string, provided?: string): string => {
    const identity = browserEvidenceStructuredIdentity(
      provided ?? `${prefix}:${randomId()}`,
      `${prefix}Id`,
    );
    if (leases.has(identity) || leaseUseReceipts.has(identity) || receipts.has(identity)) {
      throw new BrowserEvidenceContractError("duplicate_identity", `${prefix} identity exists.`);
    }
    return identity;
  };

  const actorForReceipt = (
    input: ReceiptActorInput,
    operation: "scientific-record.propose" | "scientific-record.accept" | "export.run",
    capability: "scientific-record:propose" | "scientific-record:accept" | "export:run",
  ) => {
    const envelope = input.authorizedOperation;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      !Object.isFrozen(envelope) ||
      !Object.isFrozen(envelope.authority) ||
      !Object.isFrozen(envelope.authority.actor) ||
      !Object.isFrozen(envelope.idempotency) ||
      (envelope.semanticRetryScope !== null && !Object.isFrozen(envelope.semanticRetryScope)) ||
      envelope.operation !== operation ||
      envelope.capability !== capability
    ) {
      throw new BrowserEvidenceContractError(
        "authority_scope_denied",
        `Receipt append requires an exact host-minted ${operation} envelope.`,
      );
    }
    const projectId = browserEvidenceStructuredIdentity(envelope.projectId, "projectId");
    const currentTime = now();
    assertFreshEnvelope(envelope, currentTime);
    const authority = assertActiveAuthority(envelope.authority, projectId, currentTime);
    assertCapability(authority, capability);
    let automationBinding: AutomationActorBinding | null = null;
    if (authority.actor.kind === "provider-thread") {
      const turn = envelope.semanticRetryScope;
      if (
        envelope.ingress !== "provider-gateway" ||
        turn?.kind !== "provider-turn" ||
        envelope.providerAuthorizingTurnId === null ||
        turn.callerTurnId !== envelope.providerAuthorizingTurnId ||
        turn.callerThreadId !== authority.actor.threadId ||
        turn.provider !== authority.actor.provider
      ) {
        throw new BrowserEvidenceContractError(
          "actor_scope_denied",
          "Provider receipt append requires an exact current provider-turn binding.",
        );
      }
    } else if (authority.actor.kind === "automation-run") {
      const run = envelope.semanticRetryScope;
      const envelopeBinding = exactAutomationActorBinding(envelope.authority.actor);
      automationBinding = exactAutomationActorBinding(authority.actor);
      if (
        envelope.ingress !== "automation" ||
        run?.kind !== "automation-run" ||
        run.automationId !== authority.actor.automationId ||
        run.runId !== authority.actor.runId ||
        envelopeBinding.grantVersion !== automationBinding.grantVersion ||
        envelopeBinding.automationVersion !== automationBinding.automationVersion ||
        envelopeBinding.threadId !== automationBinding.threadId ||
        envelopeBinding.pendingMessageId !== automationBinding.pendingMessageId ||
        envelopeBinding.authorizingTurnId !== automationBinding.authorizingTurnId
      ) {
        throw new BrowserEvidenceContractError(
          "actor_scope_denied",
          "Automation receipt append requires an exact current automation-run binding.",
        );
      }
    } else if (envelope.ingress !== "manual-ui" || envelope.semanticRetryScope !== null) {
      throw new BrowserEvidenceContractError(
        "actor_scope_denied",
        "Manual receipt append requires an exact manual host binding.",
      );
    }
    return {
      envelope,
      authority,
      projectId,
      createdAt: currentTime,
      actorBindingHash: browserEvidenceActorBindingHash(authority),
      automationBinding,
    };
  };

  const receiptByKind = <T extends ScientificEvidenceReceipt["kind"]>(
    id: string,
    kind: T,
  ): Extract<ScientificEvidenceReceipt, { readonly kind: T }> => {
    browserEvidenceStructuredIdentity(id, `${kind}ReceiptId`);
    const receipt = receipts.get(id);
    if (!receipt || receipt.kind !== kind) {
      throw new BrowserEvidenceContractError(
        "receipt_reference_invalid",
        `Referenced ${kind} receipt does not exist.`,
      );
    }
    return receipt as Extract<ScientificEvidenceReceipt, { readonly kind: T }>;
  };

  const receiptInScope = <T extends ScientificEvidenceReceipt["kind"]>(
    id: string,
    kind: T,
    projectId: string,
    threadId: string,
  ): Extract<ScientificEvidenceReceipt, { readonly kind: T }> => {
    const receipt = receiptByKind(id, kind);
    if (receipt.projectId !== projectId || receipt.threadId !== threadId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        `Referenced ${kind} receipt is outside the requested scope.`,
      );
    }
    return receipt;
  };

  const appendReceipt = <T extends ScientificEvidenceReceipt>(
    input: Omit<T, "previousReceiptHash" | "receiptHash">,
  ): T => {
    const scopeKey = browserEvidenceHash("receipt-chain-scope", [input.projectId, input.threadId]);
    const previousReceiptHash = lastReceiptHashByScope.get(scopeKey) ?? null;
    const receiptHash = browserEvidenceHash("scientific-evidence-receipt", {
      ...input,
      previousReceiptHash,
    });
    const receipt = deepFreezeReceipt({
      ...input,
      previousReceiptHash,
      receiptHash,
    } as T);
    receipts.set(receipt.receiptId, receipt);
    lastReceiptHashByScope.set(scopeKey, receipt.receiptHash);
    return receipt;
  };

  const isEligibleEvidence = (receipt: ScientificSourceReceipt | ScientificAnnotationReceipt) => {
    const source =
      receipt.kind === "source"
        ? receipt
        : receiptInScope(receipt.sourceReceiptId, "source", receipt.projectId, receipt.threadId);
    return source.provenance.scientificRole === "eligible-unverified-source";
  };

  const evidenceById = (id: string): ScientificSourceReceipt | ScientificAnnotationReceipt => {
    browserEvidenceStructuredIdentity(id, "evidenceReceiptId");
    const receipt = receipts.get(id);
    if (!receipt || (receipt.kind !== "source" && receipt.kind !== "annotation")) {
      throw new BrowserEvidenceContractError(
        "receipt_reference_invalid",
        "Evidence must reference a source or annotation receipt.",
      );
    }
    return receipt;
  };

  const evidenceReference = (id: string, projectId: string, threadId: string) => {
    const receipt = evidenceById(id);
    if (receipt.projectId !== projectId || receipt.threadId !== threadId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Evidence receipt is outside the requested scope.",
      );
    }
    return receipt;
  };

  const automationContextReference = (id: string, projectId: string) => {
    const receipt = receiptByKind(id, "source");
    if (receipt.projectId !== projectId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Automation context receipt is outside the proposal project.",
      );
    }
    if (
      receipt.actorKind !== "automation-run" ||
      receipt.leaseUseReceiptId !== null ||
      receipt.provenance.sourceClass !== "automation-memory" ||
      receipt.provenance.scientificRole !== "context-only-never-scientific-evidence"
    ) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Proposal context accepts context-only automation-memory source receipts only.",
      );
    }
    return receipt;
  };

  const issueLease: BrowserEvidenceAuthorityKernel["issueLease"] = (input) => {
    const envelope = input.authorizingOperation;
    const expectedOperation = SCIENT_OPERATION_BY_BROWSER_EVIDENCE_CLASS[input.operationClass];
    const expectedCapability = BROWSER_EVIDENCE_CAPABILITY_BY_OPERATION[input.operationClass];
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      !Object.isFrozen(envelope) ||
      envelope.authority === null ||
      typeof envelope.authority !== "object" ||
      !Object.isFrozen(envelope.authority) ||
      !Object.isFrozen(envelope.authority.actor) ||
      !Object.isFrozen(envelope.idempotency) ||
      (envelope.semanticRetryScope !== null && !Object.isFrozen(envelope.semanticRetryScope)) ||
      envelope.operation !== expectedOperation ||
      envelope.capability !== expectedCapability
    ) {
      throw new BrowserEvidenceContractError(
        "actor_scope_denied",
        `Browser leases require an exact trusted ${expectedOperation} provider-turn binding.`,
      );
    }
    const actor = envelope.authority.actor;
    const semanticTurn = envelope.semanticRetryScope;
    if (
      actor.kind !== "provider-thread" ||
      envelope.ingress !== "provider-gateway" ||
      semanticTurn?.kind !== "provider-turn" ||
      envelope.providerAuthorizingTurnId === null ||
      semanticTurn.callerTurnId !== envelope.providerAuthorizingTurnId ||
      semanticTurn.callerThreadId !== actor.threadId ||
      semanticTurn.provider !== actor.provider
    ) {
      throw new BrowserEvidenceContractError(
        "actor_scope_denied",
        `Browser leases require an exact trusted ${expectedOperation} provider-turn binding.`,
      );
    }
    const projectId = browserEvidenceStructuredIdentity(envelope.projectId, "projectId");
    const threadId = browserEvidenceStructuredIdentity(actor.threadId, "threadId");
    const authorizingTurnId = browserEvidenceStructuredIdentity(
      envelope.providerAuthorizingTurnId,
      "authorizingTurnId",
    );
    const issuedAt = now();
    assertFreshEnvelope(envelope, issuedAt);
    if (
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs < 1 ||
      input.ttlMs > MAX_BROWSER_EVIDENCE_LEASE_TTL_MS
    ) {
      throw new BrowserEvidenceContractError(
        "invalid_time",
        `Lease ttlMs must be between 1 and ${MAX_BROWSER_EVIDENCE_LEASE_TTL_MS}.`,
      );
    }
    const authority = assertActiveAuthority(envelope.authority, projectId, issuedAt);
    assertCapability(authority, expectedCapability);
    const document = makeBrowserDocumentIdentity(input.document);
    const usePolicy = ensureUsePolicy(input.operationClass, input.usePolicy);
    const payload = Object.freeze({
      leaseId: input.leaseId ?? null,
      document,
      operationClass: input.operationClass,
      usePolicy,
      ttlMs: input.ttlMs,
    });
    const operation = operationReplay<BrowserEvidenceLeaseGrant>(envelope, "lease.issue", payload);
    if (operation.replay !== null) return operation.replay;
    const requestedExpiresAt = issuedAt + input.ttlMs;
    const expiresAt =
      authority.expiresAt === null
        ? requestedExpiresAt
        : Math.min(requestedExpiresAt, authority.expiresAt);
    if (expiresAt <= issuedAt) {
      throw new BrowserEvidenceContractError(
        "authority_inactive",
        "Authority expires before the lease becomes usable.",
      );
    }
    const leaseId = nextId("browser-evidence-lease", input.leaseId);
    const grant: BrowserEvidenceLeaseGrant = Object.freeze({
      version: 1,
      leaseId,
      issuingOperationId: envelope.operationId,
      authorityId: authority.authorityId,
      authorityGeneration: authority.generation,
      actorBindingHash: browserEvidenceActorBindingHash(authority),
      actorKind: authority.actor.kind,
      projectId,
      threadId,
      document,
      operationClass: input.operationClass,
      authorizingTurnId,
      usePolicy,
      issuedAt,
      expiresAt,
    });
    leases.set(leaseId, {
      grant,
      usesByOperationId: new Map(),
      revokedAt: null,
      revocationReason: null,
    });
    return consumeOperation(envelope, "lease.issue", operation.payloadFingerprint, grant);
  };

  const getLease: BrowserEvidenceAuthorityKernel["getLease"] = (leaseId) => {
    const state = leases.get(browserEvidenceStructuredIdentity(leaseId, "leaseId"));
    return state ? immutableLeaseSnapshot(state) : null;
  };

  const revokeLease: BrowserEvidenceAuthorityKernel["revokeLease"] = (input) => {
    browserEvidenceStructuredIdentity(input.leaseId, "leaseId");
    const revokedAt = now();
    assertTimestamp(revokedAt, "host clock");
    const state = leases.get(input.leaseId);
    if (!state) {
      throw new BrowserEvidenceContractError("receipt_reference_invalid", "Lease does not exist.");
    }
    if (revokedAt < state.grant.issuedAt) {
      throw new BrowserEvidenceContractError(
        "invalid_time",
        "Lease cannot be revoked before issuance.",
      );
    }
    state.revokedAt ??= revokedAt;
    state.revocationReason ??= "host-revoked";
    return immutableLeaseSnapshot(state);
  };

  const authorizeLeaseUse: BrowserEvidenceAuthorityKernel["authorizeLeaseUse"] = (input) => {
    browserEvidenceStructuredIdentity(input.leaseId, "leaseId");
    const document = makeBrowserDocumentIdentity(input.document);
    const state = leases.get(input.leaseId);
    if (!state) return denial("lease_not_found", "Lease does not exist.");
    const grant = state.grant;
    const envelope = input.authorizedOperation;
    const expectedOperation = SCIENT_OPERATION_BY_BROWSER_EVIDENCE_CLASS[grant.operationClass];
    const expectedCapability = BROWSER_EVIDENCE_CAPABILITY_BY_OPERATION[grant.operationClass];
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      !Object.isFrozen(envelope) ||
      envelope.authority === null ||
      typeof envelope.authority !== "object" ||
      !Object.isFrozen(envelope.authority) ||
      !Object.isFrozen(envelope.authority.actor) ||
      !Object.isFrozen(envelope.idempotency) ||
      (envelope.semanticRetryScope !== null && !Object.isFrozen(envelope.semanticRetryScope)) ||
      envelope.operation !== expectedOperation ||
      envelope.capability !== expectedCapability
    ) {
      return denial(
        "trusted_operation_required",
        `Lease use requires a fresh host-minted ${expectedOperation} envelope.`,
      );
    }
    const actor = envelope.authority.actor;
    const turn = envelope.semanticRetryScope;
    if (
      actor.kind !== "provider-thread" ||
      envelope.ingress !== "provider-gateway" ||
      turn?.kind !== "provider-turn" ||
      envelope.providerAuthorizingTurnId === null ||
      turn.callerTurnId !== envelope.providerAuthorizingTurnId ||
      turn.callerThreadId !== actor.threadId ||
      turn.provider !== actor.provider
    ) {
      return denial(
        "trusted_operation_required",
        "Lease use requires an exact current provider-turn binding.",
      );
    }
    const operationId = browserEvidenceStructuredIdentity(envelope.operationId, "operationId");
    const projectId = browserEvidenceStructuredIdentity(envelope.projectId, "projectId");
    const threadId = browserEvidenceStructuredIdentity(actor.threadId, "threadId");
    const authorizingTurnId = browserEvidenceStructuredIdentity(
      envelope.providerAuthorizingTurnId,
      "authorizingTurnId",
    );
    const currentTime = now();
    try {
      assertFreshEnvelope(envelope, currentTime);
    } catch {
      return denial(
        "trusted_operation_required",
        "Lease use requires a fresh host-minted operation envelope.",
      );
    }
    if (operationId === grant.issuingOperationId || envelope.receivedAt < grant.issuedAt) {
      return denial(
        "trusted_operation_required",
        "The lease-issuing operation cannot be reused as an execution admission.",
      );
    }
    if (projectId !== grant.projectId) return denial("project_mismatch", "Project changed.");
    if (threadId !== grant.threadId) return denial("thread_mismatch", "Thread changed.");
    if (document.tabId !== grant.document.tabId) return denial("tab_mismatch", "Tab changed.");
    if (!sameBrowserDocument(document, grant.document)) {
      return denial("document_mismatch", "Document identity changed.");
    }
    if (authorizingTurnId !== grant.authorizingTurnId) {
      return denial("authorizing_turn_mismatch", "Authorizing turn changed.");
    }
    let operation: {
      readonly payloadFingerprint: string;
      readonly replay: BrowserEvidenceLeaseUseReceipt | null;
    };
    try {
      operation = operationReplay<BrowserEvidenceLeaseUseReceipt>(
        envelope,
        "lease.use",
        Object.freeze({ leaseId: input.leaseId, document }),
      );
    } catch {
      return denial(
        "operation_replay_conflict",
        "Operation identity or payload was already consumed by a different kernel effect.",
      );
    }
    let authority: ScientOperationAuthority;
    try {
      authority = assertActiveAuthority(envelope.authority, grant.projectId, currentTime);
    } catch {
      return denial("authority_inactive", "Current authority is not active.");
    }
    if (
      authority.authorityId !== grant.authorityId ||
      authority.generation !== grant.authorityGeneration
    ) {
      return denial("authority_mismatch", "Authority identity or generation changed.");
    }
    if (browserEvidenceActorBindingHash(authority) !== grant.actorBindingHash) {
      return denial("actor_mismatch", "Authority actor does not match the lease.");
    }
    if (
      !authority.capabilities.includes(
        BROWSER_EVIDENCE_CAPABILITY_BY_OPERATION[grant.operationClass],
      )
    ) {
      return denial(
        "capability_denied",
        "Current authority no longer carries the lease capability.",
      );
    }
    if (operation.replay !== null) {
      return Object.freeze({ kind: "replayed", receipt: operation.replay });
    }
    if (state.revokedAt !== null) return denial("lease_revoked", "Lease was revoked.");
    if (currentTime >= grant.expiresAt) return denial("lease_expired", "Lease has expired.");
    if (state.usesByOperationId.size >= grant.usePolicy.maxUses) {
      return denial("lease_exhausted", "Lease usage limit was reached.");
    }
    const receipt: BrowserEvidenceLeaseUseReceipt = Object.freeze({
      receiptId: nextId("browser-evidence-use"),
      leaseId: grant.leaseId,
      operationId,
      operationClass: grant.operationClass,
      payloadFingerprint: operation.payloadFingerprint,
      actorBindingHash: grant.actorBindingHash,
      projectId: grant.projectId,
      threadId: grant.threadId,
      document: makeBrowserDocumentIdentity(grant.document),
      authorizingTurnId: grant.authorizingTurnId,
      useSequence: state.usesByOperationId.size + 1,
      authorizedAt: currentTime,
    });
    state.usesByOperationId.set(operationId, receipt);
    leaseUseReceipts.set(receipt.receiptId, receipt);
    consumeOperation(envelope, "lease.use", operation.payloadFingerprint, receipt);
    return Object.freeze({ kind: "allowed", receipt });
  };

  const useReceiptFor = (
    id: string,
    allowedOperations: ReadonlyArray<BrowserEvidenceOperationClass>,
    actor: ReturnType<typeof actorForReceipt>,
  ) => {
    browserEvidenceStructuredIdentity(id, "leaseUseReceiptId");
    const use = leaseUseReceipts.get(id);
    if (!use || !allowedOperations.includes(use.operationClass)) {
      throw new BrowserEvidenceContractError(
        "receipt_reference_invalid",
        "Lease-use receipt is absent or has the wrong operation class.",
      );
    }
    if (
      use.projectId !== actor.projectId ||
      use.actorBindingHash !== actor.actorBindingHash ||
      (actor.authority.actor.kind === "provider-thread" &&
        use.threadId !== actor.authority.actor.threadId)
    ) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Lease-use receipt does not match actor or scope.",
      );
    }
    return use;
  };

  const assertActorMayAppendToThread = (
    actor: ReturnType<typeof actorForReceipt>,
    threadId: string,
  ) => {
    const owningThreadId =
      actor.authority.actor.kind === "provider-thread"
        ? actor.authority.actor.threadId
        : actor.automationBinding?.threadId;
    if (owningThreadId !== undefined && owningThreadId !== threadId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Provider or automation operation cannot append outside its exact thread.",
      );
    }
  };

  const automationMemoryThread = (actor: ReturnType<typeof actorForReceipt>): string => {
    const authorityActor = actor.automationBinding;
    if (authorityActor === null) {
      throw new BrowserEvidenceContractError(
        "actor_scope_denied",
        "Only an exact automation run may append automation-memory context.",
      );
    }
    return `automation-run:${browserEvidenceHash("automation-run-scope", [
      authorityActor.automationId,
      authorityActor.runId,
    ]).slice(0, 48)}`;
  };

  const recordSource: BrowserEvidenceAuthorityKernel["recordSource"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record.propose", "scientific-record:propose");
    const use = useReceiptFor(
      input.leaseUseReceiptId,
      ["document.read", "document.capture"],
      actor,
    );
    const provenance = makeHostileContentProvenanceEnvelope(input.provenance);
    if (provenance.sourceClass === "automation-memory") {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Automation memory must use the context-only append path, not a browser lease.",
      );
    }
    if (provenance.document === null || !sameBrowserDocument(provenance.document, use.document)) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Source provenance does not match the authorized document.",
      );
    }
    if (provenance.observedAt !== use.authorizedAt) {
      throw new BrowserEvidenceContractError(
        "invalid_time",
        "Browser provenance observedAt must equal the trusted lease-use time.",
      );
    }
    const operation = operationReplay<ScientificSourceReceipt>(
      actor.envelope,
      "receipt.source",
      Object.freeze({
        receiptId: input.receiptId ?? null,
        leaseUseReceiptId: input.leaseUseReceiptId,
        provenance,
      }),
    );
    if (operation.replay !== null) return operation.replay;
    const receiptId = nextId("scientific-source-receipt", input.receiptId);
    const receipt = appendReceipt<ScientificSourceReceipt>({
      version: 1,
      receiptId,
      kind: "source",
      projectId: use.projectId,
      threadId: use.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: actor.createdAt,
      leaseUseReceiptId: input.leaseUseReceiptId,
      provenance,
    });
    return consumeOperation(
      actor.envelope,
      "receipt.source",
      operation.payloadFingerprint,
      receipt,
    );
  };

  const recordAutomationMemoryContext: BrowserEvidenceAuthorityKernel["recordAutomationMemoryContext"] =
    (input) => {
      const actor = actorForReceipt(
        input,
        "scientific-record.propose",
        "scientific-record:propose",
      );
      const threadId = automationMemoryThread(actor);
      const provenance = makeHostileContentProvenanceEnvelope(input.provenance);
      if (provenance.sourceClass !== "automation-memory") {
        throw new BrowserEvidenceContractError(
          "evidence_role_denied",
          "The no-browser-lease context path accepts automation memory only.",
        );
      }
      if (provenance.observedAt !== actor.createdAt) {
        throw new BrowserEvidenceContractError(
          "invalid_time",
          "Automation-memory observedAt must equal the trusted receipt append time.",
        );
      }
      const operation = operationReplay<ScientificSourceReceipt>(
        actor.envelope,
        "receipt.automation-memory",
        Object.freeze({ receiptId: input.receiptId ?? null, provenance }),
      );
      if (operation.replay !== null) return operation.replay;
      const receiptId = nextId("automation-memory-context-receipt", input.receiptId);
      const receipt = appendReceipt<ScientificSourceReceipt>({
        version: 1,
        receiptId,
        kind: "source",
        projectId: actor.projectId,
        threadId,
        actorKind: "automation-run",
        actorBindingHash: actor.actorBindingHash,
        createdAt: actor.createdAt,
        leaseUseReceiptId: null,
        provenance,
      });
      return consumeOperation(
        actor.envelope,
        "receipt.automation-memory",
        operation.payloadFingerprint,
        receipt,
      );
    };

  const recordAnnotation: BrowserEvidenceAuthorityKernel["recordAnnotation"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record.propose", "scientific-record:propose");
    const use = useReceiptFor(input.leaseUseReceiptId, ["annotation.propose"], actor);
    const source = receiptInScope(input.sourceReceiptId, "source", use.projectId, use.threadId);
    if (
      source.provenance.document === null ||
      !sameBrowserDocument(source.provenance.document, use.document)
    ) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Annotation source does not match the authorized browser document.",
      );
    }
    browserEvidenceDigest(input.targetDigest, "targetDigest");
    browserEvidenceDigest(input.annotationDigest, "annotationDigest");
    const operation = operationReplay<ScientificAnnotationReceipt>(
      actor.envelope,
      "receipt.annotation",
      Object.freeze({
        receiptId: input.receiptId ?? null,
        leaseUseReceiptId: input.leaseUseReceiptId,
        sourceReceiptId: input.sourceReceiptId,
        targetDigest: input.targetDigest,
        annotationDigest: input.annotationDigest,
      }),
    );
    if (operation.replay !== null) return operation.replay;
    const receiptId = nextId("scientific-annotation-receipt", input.receiptId);
    const receipt = appendReceipt<ScientificAnnotationReceipt>({
      version: 1,
      receiptId,
      kind: "annotation",
      projectId: use.projectId,
      threadId: use.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: actor.createdAt,
      leaseUseReceiptId: input.leaseUseReceiptId,
      sourceReceiptId: input.sourceReceiptId,
      targetDigest: input.targetDigest,
      annotationDigest: input.annotationDigest,
      role: "proposal-only",
    });
    return consumeOperation(
      actor.envelope,
      "receipt.annotation",
      operation.payloadFingerprint,
      receipt,
    );
  };

  const recordProposal: BrowserEvidenceAuthorityKernel["recordProposal"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record.propose", "scientific-record:propose");
    browserEvidenceDigest(input.claimDigest, "claimDigest");
    const evidenceReceiptIds = freezeIds(
      input.evidenceReceiptIds,
      "evidenceReceiptId",
      MAX_EVIDENCE_RECEIPTS_PER_PROPOSAL,
    );
    const contextReceiptIds = freezeIds(
      input.contextReceiptIds === undefined ? [] : input.contextReceiptIds,
      "contextReceiptId",
      MAX_AUTOMATION_CONTEXT_RECEIPTS_PER_PROPOSAL,
    );
    if (evidenceReceiptIds.length === 0) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "A scientific proposal requires at least one eligible evidence receipt.",
      );
    }
    const firstEvidence = evidenceById(evidenceReceiptIds[0]!);
    const projectId = firstEvidence.projectId;
    const threadId = firstEvidence.threadId;
    if (projectId !== actor.projectId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Proposal evidence is outside the authorized project.",
      );
    }
    for (const id of evidenceReceiptIds) {
      if (!isEligibleEvidence(evidenceReference(id, projectId, threadId))) {
        throw new BrowserEvidenceContractError(
          "evidence_role_denied",
          "Automation memory is context only and cannot become scientific evidence.",
        );
      }
    }
    assertActorMayAppendToThread(actor, threadId);
    for (const id of contextReceiptIds) {
      automationContextReference(id, projectId);
    }
    const operation = operationReplay<ScientificProposalReceipt>(
      actor.envelope,
      "receipt.proposal",
      Object.freeze({
        receiptId: input.receiptId ?? null,
        claimDigest: input.claimDigest,
        evidenceReceiptIds,
        contextReceiptIds,
      }),
    );
    if (operation.replay !== null) return operation.replay;
    const receiptId = nextId("scientific-proposal-receipt", input.receiptId);
    const receipt = appendReceipt<ScientificProposalReceipt>({
      version: 1,
      receiptId,
      kind: "proposal",
      projectId,
      threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: actor.createdAt,
      claimDigest: input.claimDigest,
      evidenceReceiptIds,
      contextReceiptIds,
      status: "proposal-only-not-scientific-truth",
    });
    return consumeOperation(
      actor.envelope,
      "receipt.proposal",
      operation.payloadFingerprint,
      receipt,
    );
  };

  const recordVerification: BrowserEvidenceAuthorityKernel["recordVerification"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record.propose", "scientific-record:propose");
    const proposal = receiptByKind(input.proposalReceiptId, "proposal");
    if (proposal.projectId !== actor.projectId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Proposal is outside the authorized project.",
      );
    }
    assertActorMayAppendToThread(actor, proposal.threadId);
    const evidenceReceiptIds = freezeIds(
      input.evidenceReceiptIds,
      "evidenceReceiptId",
      MAX_EVIDENCE_RECEIPTS_PER_VERIFICATION,
    );
    if (!(SCIENTIFIC_VERIFICATION_OUTCOMES as ReadonlyArray<unknown>).includes(input.outcome)) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Verification outcome is not supported.",
      );
    }
    if (evidenceReceiptIds.length === 0) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Verification requires eligible evidence.",
      );
    }
    for (const id of evidenceReceiptIds) {
      if (!isEligibleEvidence(evidenceReference(id, proposal.projectId, proposal.threadId))) {
        throw new BrowserEvidenceContractError(
          "evidence_role_denied",
          "Automation memory cannot verify scientific truth.",
        );
      }
    }
    const operation = operationReplay<ScientificVerificationReceipt>(
      actor.envelope,
      "receipt.verification",
      Object.freeze({
        receiptId: input.receiptId ?? null,
        proposalReceiptId: input.proposalReceiptId,
        evidenceReceiptIds,
        outcome: input.outcome,
      }),
    );
    if (operation.replay !== null) return operation.replay;
    const receiptId = nextId("scientific-verification-receipt", input.receiptId);
    const receipt = appendReceipt<ScientificVerificationReceipt>({
      version: 1,
      receiptId,
      kind: "verification",
      projectId: proposal.projectId,
      threadId: proposal.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: actor.createdAt,
      proposalReceiptId: input.proposalReceiptId,
      evidenceReceiptIds,
      outcome: input.outcome,
      status: "advisory-only-not-scientific-truth",
    });
    return consumeOperation(
      actor.envelope,
      "receipt.verification",
      operation.payloadFingerprint,
      receipt,
    );
  };

  const recordManualDecision: BrowserEvidenceAuthorityKernel["recordManualDecision"] = (input) => {
    if (
      input.decision !== "accept-scientific-truth" &&
      input.decision !== "reject-scientific-truth" &&
      input.decision !== "approve-export"
    ) {
      throw new BrowserEvidenceContractError(
        "unsupported_decision",
        "Publication authority is not defined in this foundation.",
      );
    }
    const operation =
      input.decision === "approve-export" ? "export.run" : "scientific-record.accept";
    const capability =
      input.decision === "approve-export" ? "export:run" : "scientific-record:accept";
    const actor = actorForReceipt(input, operation, capability);
    if (actor.authority.actor.kind !== "manual-user") {
      throw new BrowserEvidenceContractError(
        "manual_decision_required",
        "Only a manual user may accept scientific truth or approve export.",
      );
    }
    const proposal = receiptByKind(input.proposalReceiptId, "proposal");
    if (proposal.projectId !== actor.projectId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Proposal is outside the authorized project.",
      );
    }
    const verificationReceiptIds = freezeIds(
      input.verificationReceiptIds,
      "verificationReceiptId",
      MAX_VERIFICATION_RECEIPTS_PER_MANUAL_DECISION,
    );
    if (input.decision !== "reject-scientific-truth" && verificationReceiptIds.length === 0) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Acceptance and export require at least one verification receipt.",
      );
    }
    for (const id of verificationReceiptIds) {
      const verification = receiptInScope(
        id,
        "verification",
        proposal.projectId,
        proposal.threadId,
      );
      if (verification.proposalReceiptId !== input.proposalReceiptId) {
        throw new BrowserEvidenceContractError(
          "receipt_reference_invalid",
          "Verification belongs to a different proposal.",
        );
      }
    }
    const operationBinding = operationReplay<ManualScientificDecisionReceipt>(
      actor.envelope,
      "receipt.manual-decision",
      Object.freeze({
        receiptId: input.receiptId ?? null,
        proposalReceiptId: input.proposalReceiptId,
        verificationReceiptIds,
        decision: input.decision,
      }),
    );
    if (operationBinding.replay !== null) return operationBinding.replay;
    const receiptId = nextId("manual-scientific-decision-receipt", input.receiptId);
    const receipt = appendReceipt<ManualScientificDecisionReceipt>({
      version: 1,
      receiptId,
      kind: "manual-decision",
      projectId: proposal.projectId,
      threadId: proposal.threadId,
      actorKind: "manual-user",
      actorBindingHash: actor.actorBindingHash,
      createdAt: actor.createdAt,
      proposalReceiptId: input.proposalReceiptId,
      verificationReceiptIds,
      decision: input.decision,
      status: "manual-user-decision",
    });
    return consumeOperation(
      actor.envelope,
      "receipt.manual-decision",
      operationBinding.payloadFingerprint,
      receipt,
    );
  };

  return Object.freeze({
    issueLease,
    getLease,
    revokeLease,
    authorizeLeaseUse,
    recordSource,
    recordAutomationMemoryContext,
    recordAnnotation,
    recordProposal,
    recordVerification,
    recordManualDecision,
  });
}
