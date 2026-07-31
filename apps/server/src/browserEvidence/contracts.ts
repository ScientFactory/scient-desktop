/**
 * Production-dark contracts for browser authority and scientific evidence.
 *
 * These contracts deliberately contain no browser transport, CDP command, UI,
 * or externally reachable adapter. Browser content is always represented as
 * hostile data with bounded, digest-only provenance. Scientific acceptance,
 * and export remain separate manual-user decisions. Publication is
 * intentionally unsupported until it has a dedicated capability.
 *
 * @module browserEvidence/contracts
 */
import { createHash } from "node:crypto";

import type {
  ScientOperationActorKind,
  ScientOperationAuthority,
  ScientOperationId,
} from "../scientOperations/authority.ts";

export const MAX_BROWSER_EVIDENCE_LEASE_TTL_MS = 5 * 60 * 1_000;
export const MAX_BROWSER_EVIDENCE_REUSE_COUNT = 8;
export const MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS = 5_000;

export const BROWSER_EVIDENCE_OPERATION_CLASSES = [
  "document.read",
  "document.capture",
  "document.action",
  "annotation.propose",
] as const;

export type BrowserEvidenceOperationClass = (typeof BROWSER_EVIDENCE_OPERATION_CLASSES)[number];

export type BrowserEvidenceRequiredCapability =
  | "browser:read"
  | "browser:capture"
  | "browser:action"
  | "scientific-record:propose";

export const BROWSER_EVIDENCE_CAPABILITY_BY_OPERATION = Object.freeze({
  "document.read": "browser:read",
  "document.capture": "browser:capture",
  "document.action": "browser:action",
  "annotation.propose": "scientific-record:propose",
} satisfies Readonly<Record<BrowserEvidenceOperationClass, BrowserEvidenceRequiredCapability>>);

export const SCIENT_OPERATION_BY_BROWSER_EVIDENCE_CLASS = Object.freeze({
  "document.read": "browser.read",
  "document.capture": "browser.capture",
  "document.action": "browser.action",
  "annotation.propose": "scientific-record.propose",
} satisfies Readonly<Record<BrowserEvidenceOperationClass, ScientOperationId>>);

export type BrowserEvidenceLeaseUsePolicy =
  | { readonly kind: "single-use"; readonly maxUses: 1 }
  | { readonly kind: "narrow-reuse"; readonly maxUses: number };

export interface BrowserDocumentIdentity {
  readonly tabId: string;
  readonly documentId: string;
  /** Changes on every committed navigation, including same-document replacements. */
  readonly navigationId: string;
  /** Digest of the normalized document identity; never a raw URL. */
  readonly documentDigest: string;
}

export interface BrowserEvidenceLeaseGrant {
  readonly version: 1;
  readonly leaseId: string;
  readonly issuingOperationId: string;
  readonly authorityId: string;
  readonly authorityGeneration: string;
  /** Domain-separated digest of the complete actor identity, including runtime identity. */
  readonly actorBindingHash: string;
  readonly actorKind: ScientOperationActorKind;
  readonly projectId: string;
  readonly threadId: string;
  readonly document: BrowserDocumentIdentity;
  readonly operationClass: BrowserEvidenceOperationClass;
  readonly authorizingTurnId: string;
  readonly usePolicy: BrowserEvidenceLeaseUsePolicy;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface BrowserEvidenceLeaseSnapshot extends BrowserEvidenceLeaseGrant {
  readonly usedCount: number;
  readonly revokedAt: number | null;
  readonly revocationReason: "host-revoked" | null;
}

export interface BrowserEvidenceLeaseUseReceipt {
  readonly receiptId: string;
  readonly leaseId: string;
  readonly operationId: string;
  readonly operationClass: BrowserEvidenceOperationClass;
  readonly payloadFingerprint: string;
  readonly actorBindingHash: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly document: BrowserDocumentIdentity;
  readonly authorizingTurnId: string;
  readonly useSequence: number;
  readonly authorizedAt: number;
}

export type BrowserEvidenceLeaseUseDenialCode =
  | "lease_not_found"
  | "trusted_operation_required"
  | "lease_revoked"
  | "lease_expired"
  | "lease_exhausted"
  | "operation_replay_conflict"
  | "operation_class_mismatch"
  | "actor_mismatch"
  | "authority_mismatch"
  | "authority_inactive"
  | "capability_denied"
  | "project_mismatch"
  | "thread_mismatch"
  | "tab_mismatch"
  | "document_mismatch"
  | "authorizing_turn_mismatch";

export type BrowserEvidenceLeaseUseDecision =
  | { readonly kind: "allowed"; readonly receipt: BrowserEvidenceLeaseUseReceipt }
  | { readonly kind: "replayed"; readonly receipt: BrowserEvidenceLeaseUseReceipt }
  | {
      readonly kind: "denied";
      readonly code: BrowserEvidenceLeaseUseDenialCode;
      readonly message: string;
    };

export const SCIENTIFIC_SOURCE_CLASSES = [
  "web-document",
  "browser-capture",
  "automation-memory",
] as const;

export type ScientificSourceClass = (typeof SCIENTIFIC_SOURCE_CLASSES)[number];

export interface HostileContentProvenanceEnvelope {
  readonly version: 1;
  readonly provenanceId: string;
  readonly sourceClass: ScientificSourceClass;
  /** Null only for automation memory, which is context rather than browser evidence. */
  readonly document: BrowserDocumentIdentity | null;
  /** Digest of the source origin. Raw URLs and local paths are intentionally excluded. */
  readonly originDigest: string;
  readonly contentDigest: string;
  readonly mediaType: string;
  readonly observedAt: number;
  readonly trustClass: "hostile-external-content" | "untrusted-automation-memory";
  readonly instructionDisposition: "data-only-never-authority";
  readonly scientificRole: "eligible-unverified-source" | "context-only-never-scientific-evidence";
}

interface ScientificEvidenceReceiptBase {
  readonly version: 1;
  readonly receiptId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly actorKind: ScientOperationActorKind;
  readonly actorBindingHash: string;
  readonly createdAt: number;
  readonly previousReceiptHash: string | null;
  readonly receiptHash: string;
}

export interface ScientificSourceReceipt extends ScientificEvidenceReceiptBase {
  readonly kind: "source";
  /** Null only for context-only automation memory, which is not browser evidence. */
  readonly leaseUseReceiptId: string | null;
  readonly provenance: HostileContentProvenanceEnvelope;
}

export interface ScientificAnnotationReceipt extends ScientificEvidenceReceiptBase {
  readonly kind: "annotation";
  readonly leaseUseReceiptId: string;
  readonly sourceReceiptId: string;
  readonly targetDigest: string;
  readonly annotationDigest: string;
  readonly role: "proposal-only";
}

export interface ScientificProposalReceipt extends ScientificEvidenceReceiptBase {
  readonly kind: "proposal";
  readonly claimDigest: string;
  /** Only receipts rooted in non-memory source material may be evidence. */
  readonly evidenceReceiptIds: ReadonlyArray<string>;
  /** Automation memory may appear only here and can never become evidence or truth. */
  readonly contextReceiptIds: ReadonlyArray<string>;
  readonly status: "proposal-only-not-scientific-truth";
}

export interface ScientificVerificationReceipt extends ScientificEvidenceReceiptBase {
  readonly kind: "verification";
  readonly proposalReceiptId: string;
  readonly evidenceReceiptIds: ReadonlyArray<string>;
  readonly outcome: "supports" | "contradicts" | "inconclusive";
  readonly status: "advisory-only-not-scientific-truth";
}

export type ManualScientificDecision =
  | "accept-scientific-truth"
  | "reject-scientific-truth"
  | "approve-export";

export interface ManualScientificDecisionReceipt extends ScientificEvidenceReceiptBase {
  readonly kind: "manual-decision";
  readonly actorKind: "manual-user";
  readonly proposalReceiptId: string;
  readonly verificationReceiptIds: ReadonlyArray<string>;
  readonly decision: ManualScientificDecision;
  readonly status: "manual-user-decision";
}

export type ScientificEvidenceReceipt =
  | ScientificSourceReceipt
  | ScientificAnnotationReceipt
  | ScientificProposalReceipt
  | ScientificVerificationReceipt
  | ManualScientificDecisionReceipt;

export type BrowserEvidenceContractErrorCode =
  | "invalid_identity"
  | "invalid_digest"
  | "invalid_time"
  | "invalid_lease_policy"
  | "duplicate_identity"
  | "authority_inactive"
  | "authority_scope_denied"
  | "capability_denied"
  | "actor_scope_denied"
  | "receipt_reference_invalid"
  | "receipt_scope_mismatch"
  | "evidence_role_denied"
  | "manual_decision_required"
  | "unsupported_decision";

export class BrowserEvidenceContractError extends Error {
  readonly code: BrowserEvidenceContractErrorCode;

  constructor(code: BrowserEvidenceContractErrorCode, message: string) {
    super(message);
    this.name = "BrowserEvidenceContractError";
    this.code = code;
  }
}

export function browserEvidenceStructuredIdentity(
  value: string,
  field: string,
  maxUtf8Bytes = 512,
): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > maxUtf8Bytes
  ) {
    throw new BrowserEvidenceContractError(
      "invalid_identity",
      `${field} is not a bounded structured identity.`,
    );
  }
  return value;
}

export function browserEvidenceDigest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new BrowserEvidenceContractError(
      "invalid_digest",
      `${field} must be a lowercase SHA-256 digest.`,
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function browserEvidenceHash(tag: string, value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(["scient-browser-evidence-v1", tag, value]))
    .digest("hex");
}

export function browserEvidenceActorBindingHash(authority: ScientOperationAuthority): string {
  return browserEvidenceHash("actor-binding", authority.actor);
}

export function makeBrowserDocumentIdentity(
  input: BrowserDocumentIdentity,
): BrowserDocumentIdentity {
  return Object.freeze({
    tabId: browserEvidenceStructuredIdentity(input.tabId, "document.tabId"),
    documentId: browserEvidenceStructuredIdentity(input.documentId, "document.documentId"),
    navigationId: browserEvidenceStructuredIdentity(input.navigationId, "document.navigationId"),
    documentDigest: browserEvidenceDigest(input.documentDigest, "document.documentDigest"),
  });
}

export function sameBrowserDocument(
  left: BrowserDocumentIdentity,
  right: BrowserDocumentIdentity,
): boolean {
  return (
    left.tabId === right.tabId &&
    left.documentId === right.documentId &&
    left.navigationId === right.navigationId &&
    left.documentDigest === right.documentDigest
  );
}

export function makeHostileContentProvenanceEnvelope(
  input: Omit<
    HostileContentProvenanceEnvelope,
    "version" | "trustClass" | "instructionDisposition" | "scientificRole"
  >,
): HostileContentProvenanceEnvelope {
  browserEvidenceStructuredIdentity(input.provenanceId, "provenanceId");
  browserEvidenceDigest(input.originDigest, "originDigest");
  browserEvidenceDigest(input.contentDigest, "contentDigest");
  if (
    typeof input.mediaType !== "string" ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(input.mediaType) ||
    Buffer.byteLength(input.mediaType, "utf8") > 128
  ) {
    throw new BrowserEvidenceContractError(
      "invalid_identity",
      "mediaType is not a bounded MIME type.",
    );
  }
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new BrowserEvidenceContractError("invalid_time", "observedAt must be a safe timestamp.");
  }
  const automationMemory = input.sourceClass === "automation-memory";
  if (automationMemory !== (input.document === null)) {
    throw new BrowserEvidenceContractError(
      "evidence_role_denied",
      "Automation memory must have no browser document; browser sources require one.",
    );
  }
  return Object.freeze({
    version: 1,
    provenanceId: input.provenanceId,
    sourceClass: input.sourceClass,
    document: input.document === null ? null : makeBrowserDocumentIdentity(input.document),
    originDigest: input.originDigest,
    contentDigest: input.contentDigest,
    mediaType: input.mediaType,
    observedAt: input.observedAt,
    trustClass: automationMemory ? "untrusted-automation-memory" : "hostile-external-content",
    instructionDisposition: "data-only-never-authority",
    scientificRole: automationMemory
      ? "context-only-never-scientific-evidence"
      : "eligible-unverified-source",
  });
}
