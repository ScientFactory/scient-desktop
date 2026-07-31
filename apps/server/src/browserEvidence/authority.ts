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
  MAX_BROWSER_EVIDENCE_LEASE_TTL_MS,
  MAX_BROWSER_EVIDENCE_REUSE_COUNT,
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
  readonly authority: ScientOperationAuthority;
  readonly operationId: string;
  readonly operationClass: BrowserEvidenceOperationClass;
  readonly payloadFingerprint: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly document: BrowserDocumentIdentity;
  readonly authorizingTurnId: string;
  readonly now: number;
}

interface ReceiptActorInput {
  readonly authority: ScientOperationAuthority;
  readonly receiptId?: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly createdAt: number;
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
  readonly revokeLease: (input: {
    readonly leaseId: string;
    readonly revokedAt: number;
  }) => BrowserEvidenceLeaseSnapshot;
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
}): BrowserEvidenceAuthorityKernel {
  const randomId = options?.randomId ?? randomUUID;
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

  const actorForReceipt = (input: ReceiptActorInput, capability: string) => {
    browserEvidenceStructuredIdentity(input.projectId, "projectId");
    browserEvidenceStructuredIdentity(input.threadId, "threadId");
    assertTimestamp(input.createdAt, "createdAt");
    const authority = assertActiveAuthority(input.authority, input.projectId, input.createdAt);
    assertCapability(authority, capability as ScientOperationAuthority["capabilities"][number]);
    return {
      authority,
      actorBindingHash: browserEvidenceActorBindingHash(authority),
    };
  };

  const receiptInScope = <T extends ScientificEvidenceReceipt["kind"]>(
    id: string,
    kind: T,
    projectId: string,
    threadId: string,
  ): Extract<ScientificEvidenceReceipt, { readonly kind: T }> => {
    browserEvidenceStructuredIdentity(id, `${kind}ReceiptId`);
    const receipt = receipts.get(id);
    if (!receipt || receipt.kind !== kind) {
      throw new BrowserEvidenceContractError(
        "receipt_reference_invalid",
        `Referenced ${kind} receipt does not exist.`,
      );
    }
    if (receipt.projectId !== projectId || receipt.threadId !== threadId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        `Referenced ${kind} receipt is outside the requested scope.`,
      );
    }
    return receipt as Extract<ScientificEvidenceReceipt, { readonly kind: T }>;
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

  const evidenceReference = (id: string, projectId: string, threadId: string) => {
    const receipt = receipts.get(id);
    if (!receipt || (receipt.kind !== "source" && receipt.kind !== "annotation")) {
      throw new BrowserEvidenceContractError(
        "receipt_reference_invalid",
        "Evidence must reference a source or annotation receipt.",
      );
    }
    if (receipt.projectId !== projectId || receipt.threadId !== threadId) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Evidence receipt is outside the requested scope.",
      );
    }
    return receipt;
  };

  const issueLease: BrowserEvidenceAuthorityKernel["issueLease"] = (input) => {
    const envelope = input.authorizingOperation;
    const actor = envelope.authority.actor;
    const semanticTurn = envelope.semanticRetryScope;
    if (
      !Object.isFrozen(envelope) ||
      !Object.isFrozen(envelope.authority) ||
      !Object.isFrozen(envelope.authority.actor) ||
      actor.kind !== "provider-thread" ||
      semanticTurn?.kind !== "provider-turn" ||
      envelope.providerAuthorizingTurnId === null ||
      semanticTurn.callerTurnId !== envelope.providerAuthorizingTurnId ||
      semanticTurn.callerThreadId !== actor.threadId ||
      semanticTurn.provider !== actor.provider
    ) {
      throw new BrowserEvidenceContractError(
        "actor_scope_denied",
        "Browser leases require an exact trusted provider-turn operation binding.",
      );
    }
    const projectId = browserEvidenceStructuredIdentity(envelope.projectId, "projectId");
    const threadId = browserEvidenceStructuredIdentity(actor.threadId, "threadId");
    const authorizingTurnId = browserEvidenceStructuredIdentity(
      envelope.providerAuthorizingTurnId,
      "authorizingTurnId",
    );
    const issuedAt = envelope.receivedAt;
    assertTimestamp(issuedAt, "authorizingOperation.receivedAt");
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
    assertCapability(authority, BROWSER_EVIDENCE_CAPABILITY_BY_OPERATION[input.operationClass]);
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
    assertTimestamp(input.revokedAt, "revokedAt");
    const state = leases.get(input.leaseId);
    if (!state) {
      throw new BrowserEvidenceContractError("receipt_reference_invalid", "Lease does not exist.");
    }
    if (input.revokedAt < state.grant.issuedAt) {
      throw new BrowserEvidenceContractError(
        "invalid_time",
        "Lease cannot be revoked before issuance.",
      );
    }
    state.revokedAt ??= input.revokedAt;
    state.revocationReason ??= "host-revoked";
    return immutableLeaseSnapshot(state);
  };

  const authorizeLeaseUse: BrowserEvidenceAuthorityKernel["authorizeLeaseUse"] = (input) => {
    browserEvidenceStructuredIdentity(input.leaseId, "leaseId");
    browserEvidenceStructuredIdentity(input.operationId, "operationId");
    browserEvidenceStructuredIdentity(input.projectId, "projectId");
    browserEvidenceStructuredIdentity(input.threadId, "threadId");
    browserEvidenceStructuredIdentity(input.authorizingTurnId, "authorizingTurnId");
    browserEvidenceDigest(input.payloadFingerprint, "payloadFingerprint");
    assertTimestamp(input.now, "now");
    const document = makeBrowserDocumentIdentity(input.document);
    const state = leases.get(input.leaseId);
    if (!state) return denial("lease_not_found", "Lease does not exist.");
    const grant = state.grant;
    if (input.projectId !== grant.projectId) return denial("project_mismatch", "Project changed.");
    if (input.threadId !== grant.threadId) return denial("thread_mismatch", "Thread changed.");
    if (document.tabId !== grant.document.tabId) return denial("tab_mismatch", "Tab changed.");
    if (!sameBrowserDocument(document, grant.document)) {
      return denial("document_mismatch", "Document identity changed.");
    }
    if (input.operationClass !== grant.operationClass) {
      return denial("operation_class_mismatch", "Operation class changed.");
    }
    if (input.authorizingTurnId !== grant.authorizingTurnId) {
      return denial("authorizing_turn_mismatch", "Authorizing turn changed.");
    }
    let authority: ScientOperationAuthority;
    try {
      authority = assertActiveAuthority(input.authority, grant.projectId, input.now);
    } catch {
      return denial("authority_inactive", "Current authority is not active.");
    }
    if (state.revokedAt !== null) return denial("lease_revoked", "Lease was revoked.");
    if (input.now >= grant.expiresAt) return denial("lease_expired", "Lease has expired.");
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
    const replay = state.usesByOperationId.get(input.operationId);
    if (replay) {
      return replay.payloadFingerprint === input.payloadFingerprint
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
      operationId: input.operationId,
      operationClass: grant.operationClass,
      payloadFingerprint: input.payloadFingerprint,
      actorBindingHash: grant.actorBindingHash,
      projectId: grant.projectId,
      threadId: grant.threadId,
      document: makeBrowserDocumentIdentity(grant.document),
      authorizingTurnId: grant.authorizingTurnId,
      useSequence: state.usesByOperationId.size + 1,
      authorizedAt: input.now,
    });
    state.usesByOperationId.set(input.operationId, receipt);
    leaseUseReceipts.set(receipt.receiptId, receipt);
    return Object.freeze({ kind: "allowed", receipt });
  };

  const useReceiptFor = (
    id: string,
    input: ReceiptActorInput,
    allowedOperations: ReadonlyArray<BrowserEvidenceOperationClass>,
    actorBindingHash: string,
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
      use.projectId !== input.projectId ||
      use.threadId !== input.threadId ||
      use.actorBindingHash !== actorBindingHash
    ) {
      throw new BrowserEvidenceContractError(
        "receipt_scope_mismatch",
        "Lease-use receipt does not match actor or scope.",
      );
    }
    return use;
  };

  const recordSource: BrowserEvidenceAuthorityKernel["recordSource"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record:propose");
    const use = useReceiptFor(
      input.leaseUseReceiptId,
      input,
      ["document.read", "document.capture"],
      actor.actorBindingHash,
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
      projectId: input.projectId,
      threadId: input.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: input.createdAt,
      leaseUseReceiptId: input.leaseUseReceiptId,
      provenance,
    });
  };

  const recordAutomationMemoryContext: BrowserEvidenceAuthorityKernel["recordAutomationMemoryContext"] =
    (input) => {
      const actor = actorForReceipt(input, "scientific-record:propose");
      if (actor.authority.actor.kind !== "automation-run") {
        throw new BrowserEvidenceContractError(
          "actor_scope_denied",
          "Only an exact automation run may append automation-memory context.",
        );
      }
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
        projectId: input.projectId,
        threadId: input.threadId,
        actorKind: "automation-run",
        actorBindingHash: actor.actorBindingHash,
        createdAt: input.createdAt,
        leaseUseReceiptId: null,
        provenance,
      });
    };

  const recordAnnotation: BrowserEvidenceAuthorityKernel["recordAnnotation"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record:propose");
    useReceiptFor(input.leaseUseReceiptId, input, ["annotation.propose"], actor.actorBindingHash);
    receiptInScope(input.sourceReceiptId, "source", input.projectId, input.threadId);
    browserEvidenceDigest(input.targetDigest, "targetDigest");
    browserEvidenceDigest(input.annotationDigest, "annotationDigest");
    const receiptId = nextId("scientific-annotation-receipt", input.receiptId);
    return appendReceipt<ScientificAnnotationReceipt>({
      version: 1,
      receiptId,
      kind: "annotation",
      projectId: input.projectId,
      threadId: input.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: input.createdAt,
      leaseUseReceiptId: input.leaseUseReceiptId,
      sourceReceiptId: input.sourceReceiptId,
      targetDigest: input.targetDigest,
      annotationDigest: input.annotationDigest,
      role: "proposal-only",
    });
  };

  const recordProposal: BrowserEvidenceAuthorityKernel["recordProposal"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record:propose");
    browserEvidenceDigest(input.claimDigest, "claimDigest");
    const evidenceReceiptIds = freezeIds(input.evidenceReceiptIds, "evidenceReceiptId");
    const contextReceiptIds = freezeIds(input.contextReceiptIds ?? [], "contextReceiptId");
    if (evidenceReceiptIds.length === 0) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "A scientific proposal requires at least one eligible evidence receipt.",
      );
    }
    for (const id of evidenceReceiptIds) {
      if (!isEligibleEvidence(evidenceReference(id, input.projectId, input.threadId))) {
        throw new BrowserEvidenceContractError(
          "evidence_role_denied",
          "Automation memory is context only and cannot become scientific evidence.",
        );
      }
    }
    for (const id of contextReceiptIds) {
      evidenceReference(id, input.projectId, input.threadId);
    }
    const receiptId = nextId("scientific-proposal-receipt", input.receiptId);
    return appendReceipt<ScientificProposalReceipt>({
      version: 1,
      receiptId,
      kind: "proposal",
      projectId: input.projectId,
      threadId: input.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: input.createdAt,
      claimDigest: input.claimDigest,
      evidenceReceiptIds,
      contextReceiptIds,
      status: "proposal-only-not-scientific-truth",
    });
  };

  const recordVerification: BrowserEvidenceAuthorityKernel["recordVerification"] = (input) => {
    const actor = actorForReceipt(input, "scientific-record:propose");
    receiptInScope(input.proposalReceiptId, "proposal", input.projectId, input.threadId);
    const evidenceReceiptIds = freezeIds(input.evidenceReceiptIds, "evidenceReceiptId");
    if (evidenceReceiptIds.length === 0) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Verification requires eligible evidence.",
      );
    }
    for (const id of evidenceReceiptIds) {
      if (!isEligibleEvidence(evidenceReference(id, input.projectId, input.threadId))) {
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
      projectId: input.projectId,
      threadId: input.threadId,
      actorKind: actor.authority.actor.kind,
      actorBindingHash: actor.actorBindingHash,
      createdAt: input.createdAt,
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
    const capability =
      input.decision === "approve-export" ? "export:run" : "scientific-record:accept";
    const actor = actorForReceipt(input, capability);
    if (actor.authority.actor.kind !== "manual-user") {
      throw new BrowserEvidenceContractError(
        "manual_decision_required",
        "Only a manual user may accept scientific truth or approve export.",
      );
    }
    receiptInScope(input.proposalReceiptId, "proposal", input.projectId, input.threadId);
    const verificationReceiptIds = freezeIds(input.verificationReceiptIds, "verificationReceiptId");
    if (input.decision !== "reject-scientific-truth" && verificationReceiptIds.length === 0) {
      throw new BrowserEvidenceContractError(
        "evidence_role_denied",
        "Acceptance and export require at least one verification receipt.",
      );
    }
    for (const id of verificationReceiptIds) {
      const verification = receiptInScope(id, "verification", input.projectId, input.threadId);
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
      projectId: input.projectId,
      threadId: input.threadId,
      actorKind: "manual-user",
      actorBindingHash: actor.actorBindingHash,
      createdAt: input.createdAt,
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
