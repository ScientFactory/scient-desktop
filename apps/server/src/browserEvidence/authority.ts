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
  SCIENT_OPERATION_BY_BROWSER_EVIDENCE_CLASS,
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

/**
 * A1 extends the central automation actor with these exact host-resolved
 * fields. Keep the structural check local until that independent lane lands;
 * old two-field automation actors must fail closed when composed here.
 */
interface ExactAutomationActorBinding {
  readonly kind: "automation-run";
  readonly automationId: string;
  readonly runId: string;
  readonly grantVersion: 1;
  readonly automationVersion: string;
  readonly threadId: string;
  readonly pendingMessageId: string;
  readonly authorizingTurnId: string;
}

function exactAutomationActorBinding(
  actor: ScientOperationAuthority["actor"],
): ExactAutomationActorBinding {
  const candidate = actor as ScientOperationAuthority["actor"] &
    Partial<ExactAutomationActorBinding>;
  if (candidate.kind !== "automation-run") {
    throw new BrowserEvidenceContractError(
      "actor_scope_denied",
      "An exact automation actor binding is required.",
    );
  }
  if (candidate.grantVersion !== 1) {
    throw new BrowserEvidenceContractError(
      "actor_scope_denied",
      "An exact versioned automation actor binding is required.",
    );
  }
  return Object.freeze({
    kind: "automation-run",
    automationId: browserEvidenceStructuredIdentity(candidate.automationId, "actor.automationId"),
    runId: browserEvidenceStructuredIdentity(candidate.runId, "actor.runId"),
    grantVersion: 1,
    automationVersion: browserEvidenceStructuredIdentity(
      candidate.automationVersion!,
      "actor.automationVersion",
    ),
    threadId: browserEvidenceStructuredIdentity(candidate.threadId!, "actor.threadId"),
    pendingMessageId: browserEvidenceStructuredIdentity(
      candidate.pendingMessageId!,
      "actor.pendingMessageId",
    ),
    authorizingTurnId: browserEvidenceStructuredIdentity(
      candidate.authorizingTurnId!,
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

function freezeIds(ids: ReadonlyArray<string>, field: string): ReadonlyArray<string> {
  const validated = ids.map((id) => browserEvidenceStructuredIdentity(id, field));
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
    let automationBinding: ExactAutomationActorBinding | null = null;
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
      document: makeBrowserDocumentIdentity(input.document),
      operationClass: input.operationClass,
      authorizingTurnId,
      usePolicy: ensureUsePolicy(input.operationClass, input.usePolicy),
      issuedAt,
      expiresAt,
    });
    leases.set(leaseId, {
      grant,
      usesByOperationId: new Map(),
      revokedAt: null,
      revocationReason: null,
    });
    return grant;
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
    const payloadFingerprint = browserEvidenceDigest(
      envelope.idempotency.payloadFingerprint,
      "payloadFingerprint",
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
    let authority: ScientOperationAuthority;
    try {
      authority = assertActiveAuthority(envelope.authority, grant.projectId, currentTime);
    } catch {
      return denial("authority_inactive", "Current authority is not active.");
    }
    if (state.revokedAt !== null) return denial("lease_revoked", "Lease was revoked.");
    if (currentTime >= grant.expiresAt) return denial("lease_expired", "Lease has expired.");
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
    const replay = state.usesByOperationId.get(operationId);
    if (replay) {
      return replay.payloadFingerprint === payloadFingerprint
        ? Object.freeze({ kind: "replayed", receipt: replay })
        : denial(
            "operation_replay_conflict",
            "Operation identity was reused with a different payload.",
          );
    }
    if (state.usesByOperationId.size >= grant.usePolicy.maxUses) {
      return denial("lease_exhausted", "Lease usage limit was reached.");
    }
    const receipt: BrowserEvidenceLeaseUseReceipt = Object.freeze({
      receiptId: nextId("browser-evidence-use"),
      leaseId: grant.leaseId,
      operationId,
      operationClass: grant.operationClass,
      payloadFingerprint,
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
    const receiptId = nextId("scientific-source-receipt", input.receiptId);
    return appendReceipt<ScientificSourceReceipt>({
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
      const receiptId = nextId("automation-memory-context-receipt", input.receiptId);
      return appendReceipt<ScientificSourceReceipt>({
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
    };

  const recordAnnotation: BrowserEvidenceAuthorityKernel["recordAnnotation"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record.propose", "scientific-record:propose");
    const use = useReceiptFor(input.leaseUseReceiptId, ["annotation.propose"], actor);
    receiptInScope(input.sourceReceiptId, "source", use.projectId, use.threadId);
    browserEvidenceDigest(input.targetDigest, "targetDigest");
    browserEvidenceDigest(input.annotationDigest, "annotationDigest");
    const receiptId = nextId("scientific-annotation-receipt", input.receiptId);
    return appendReceipt<ScientificAnnotationReceipt>({
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
  };

  const recordProposal: BrowserEvidenceAuthorityKernel["recordProposal"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record.propose", "scientific-record:propose");
    browserEvidenceDigest(input.claimDigest, "claimDigest");
    const evidenceReceiptIds = freezeIds(input.evidenceReceiptIds, "evidenceReceiptId");
    const contextReceiptIds = freezeIds(input.contextReceiptIds ?? [], "contextReceiptId");
    if (contextReceiptIds.length > MAX_AUTOMATION_CONTEXT_RECEIPTS_PER_PROPOSAL) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        `A proposal may reference at most ${MAX_AUTOMATION_CONTEXT_RECEIPTS_PER_PROPOSAL} automation context receipts.`,
      );
    }
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
    const receiptId = nextId("scientific-proposal-receipt", input.receiptId);
    return appendReceipt<ScientificProposalReceipt>({
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
    const evidenceReceiptIds = freezeIds(input.evidenceReceiptIds, "evidenceReceiptId");
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
    const receiptId = nextId("scientific-verification-receipt", input.receiptId);
    return appendReceipt<ScientificVerificationReceipt>({
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
    const verificationReceiptIds = freezeIds(input.verificationReceiptIds, "verificationReceiptId");
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
    const receiptId = nextId("manual-scientific-decision-receipt", input.receiptId);
    return appendReceipt<ManualScientificDecisionReceipt>({
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
