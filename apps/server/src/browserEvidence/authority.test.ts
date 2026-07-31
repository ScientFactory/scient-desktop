import { describe, expect, it } from "vitest";

import {
  SCIENT_OPERATION_DEFINITIONS,
  type ScientOperationAuthority,
  beginScientOperation,
} from "../scientOperations/authority.ts";
import { makeBrowserEvidenceAuthorityKernel } from "./authority.ts";
import {
  MAX_BROWSER_EVIDENCE_LEASE_TTL_MS,
  BrowserEvidenceContractError,
  type BrowserDocumentIdentity,
  type BrowserEvidenceLeaseUseDecision,
  makeHostileContentProvenanceEnvelope,
} from "./contracts.ts";

const NOW = 1_000_000;
const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function providerAuthority(
  overrides?: Partial<ScientOperationAuthority>,
): ScientOperationAuthority {
  return {
    authorityId: "provider-authority-1",
    generation: "generation-1",
    actor: {
      kind: "provider-thread",
      threadId: THREAD_ID,
      provider: "codex",
      sessionKey: "session-1",
    },
    projectIds: [PROJECT_ID],
    capabilities: [
      "browser:read",
      "browser:capture",
      "browser:action",
      "thread:drive",
      "scientific-record:propose",
      "scientific-record:accept",
      "export:run",
    ],
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    revokedAt: null,
    ...overrides,
  };
}

function manualAuthority(overrides?: Partial<ScientOperationAuthority>): ScientOperationAuthority {
  return {
    authorityId: "manual-authority-1",
    generation: "generation-1",
    actor: { kind: "manual-user", userId: "user-1" },
    projectIds: [PROJECT_ID],
    capabilities: ["scientific-record:propose", "scientific-record:accept", "export:run"],
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    revokedAt: null,
    ...overrides,
  };
}

function automationAuthority(
  overrides?: Partial<ScientOperationAuthority>,
): ScientOperationAuthority {
  return {
    authorityId: "automation-authority-1",
    generation: "generation-1",
    actor: { kind: "automation-run", automationId: "automation-1", runId: "run-1" },
    projectIds: [PROJECT_ID],
    capabilities: [
      "browser:read",
      "scientific-record:propose",
      "scientific-record:accept",
      "export:run",
    ],
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    revokedAt: null,
    ...overrides,
  };
}

function documentIdentity(overrides?: Partial<BrowserDocumentIdentity>): BrowserDocumentIdentity {
  return {
    tabId: "tab-1",
    documentId: "document-1",
    navigationId: "navigation-1",
    documentDigest: DIGEST_A,
    ...overrides,
  };
}

function makeKernel() {
  let nextId = 0;
  return makeBrowserEvidenceAuthorityKernel({
    randomId: () => `generated-${++nextId}`,
  });
}

function trustedTurnOperation(authority: ScientOperationAuthority = providerAuthority()) {
  const started = beginScientOperation({
    authority,
    definition: SCIENT_OPERATION_DEFINITIONS["thread.message.send"],
    projectId: PROJECT_ID,
    ingress: "provider-gateway",
    operationId: "turn-binding-operation",
    semanticIdempotencyIdentity: "turn-binding-request",
    semanticIdempotencyScope: {
      kind: "provider-turn",
      provider: "codex",
      callerThreadId: THREAD_ID,
      callerTurnId: TURN_ID,
    },
    providerAuthorizingTurnId: TURN_ID,
    payloadFingerprint: DIGEST_A,
    receivedAt: NOW,
  });
  if (!started.allow) throw new Error("trusted turn operation unexpectedly denied");
  return started.envelope;
}

function issueReadLease(
  kernel: ReturnType<typeof makeKernel>,
  input?: {
    readonly authority?: ScientOperationAuthority;
    readonly leaseId?: string;
    readonly ttlMs?: number;
    readonly usePolicy?:
      | { readonly kind: "single-use"; readonly maxUses: 1 }
      | {
          readonly kind: "narrow-reuse";
          readonly maxUses: number;
        };
    readonly document?: BrowserDocumentIdentity;
  },
) {
  const authority = input?.authority ?? providerAuthority();
  return kernel.issueLease({
    authorizingOperation: trustedTurnOperation(authority),
    leaseId: input?.leaseId ?? "lease-1",
    document: input?.document ?? documentIdentity(),
    operationClass: "document.read",
    usePolicy: input?.usePolicy ?? { kind: "single-use", maxUses: 1 },
    ttlMs: input?.ttlMs ?? 10_000,
  });
}

function authorizeRead(
  kernel: ReturnType<typeof makeKernel>,
  overrides?: Partial<Parameters<typeof kernel.authorizeLeaseUse>[0]>,
): BrowserEvidenceLeaseUseDecision {
  return kernel.authorizeLeaseUse({
    leaseId: "lease-1",
    authority: providerAuthority(),
    operationId: "operation-1",
    operationClass: "document.read",
    payloadFingerprint: DIGEST_B,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    document: documentIdentity(),
    authorizingTurnId: TURN_ID,
    now: NOW + 1,
    ...overrides,
  });
}

function expectDenial(decision: BrowserEvidenceLeaseUseDecision, code: string) {
  expect(decision.kind).toBe("denied");
  if (decision.kind === "denied") expect(decision.code).toBe(code);
}

function provenance(
  sourceClass: "web-document" | "browser-capture" | "automation-memory" = "web-document",
) {
  return makeHostileContentProvenanceEnvelope({
    provenanceId: `provenance-${sourceClass}`,
    sourceClass,
    document: sourceClass === "automation-memory" ? null : documentIdentity(),
    originDigest: DIGEST_C,
    contentDigest: DIGEST_D,
    mediaType: "text/html",
    observedAt: NOW + 2,
  });
}

function authorizeUseFor(
  kernel: ReturnType<typeof makeKernel>,
  input: {
    readonly authority: ScientOperationAuthority;
    readonly leaseId: string;
    readonly operationId: string;
    readonly operationClass: "document.read" | "annotation.propose";
    readonly payloadFingerprint?: string;
  },
) {
  return kernel.authorizeLeaseUse({
    leaseId: input.leaseId,
    authority: input.authority,
    operationId: input.operationId,
    operationClass: input.operationClass,
    payloadFingerprint: input.payloadFingerprint ?? DIGEST_B,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    document: documentIdentity(),
    authorizingTurnId: TURN_ID,
    now: NOW + 1,
  });
}

function buildEligibleProposal(kernel: ReturnType<typeof makeKernel>) {
  const provider = providerAuthority();
  issueReadLease(kernel, { authority: provider });
  const sourceUse = authorizeUseFor(kernel, {
    authority: provider,
    leaseId: "lease-1",
    operationId: "source-operation",
    operationClass: "document.read",
  });
  if (sourceUse.kind === "denied") throw new Error("source lease unexpectedly denied");
  const source = kernel.recordSource({
    authority: provider,
    receiptId: "source-receipt-1",
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    createdAt: NOW + 2,
    leaseUseReceiptId: sourceUse.receipt.receiptId,
    provenance: provenance(),
  });
  const proposal = kernel.recordProposal({
    authority: provider,
    receiptId: "proposal-receipt-1",
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    createdAt: NOW + 3,
    claimDigest: DIGEST_A,
    evidenceReceiptIds: [source.receiptId],
  });
  const verification = kernel.recordVerification({
    authority: provider,
    receiptId: "verification-receipt-1",
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    createdAt: NOW + 4,
    proposalReceiptId: proposal.receiptId,
    evidenceReceiptIds: [source.receiptId],
    outcome: "supports",
  });
  return { provider, source, proposal, verification };
}

describe("BrowserEvidenceAuthorityKernel leases", () => {
  it("authorizes one exact actor/project/thread/tab/document/operation/turn use", () => {
    const kernel = makeKernel();
    const grant = issueReadLease(kernel);
    const decision = authorizeRead(kernel);

    expect(grant.expiresAt).toBe(NOW + 10_000);
    expect(grant).not.toHaveProperty("sessionKey");
    expect(decision.kind).toBe("allowed");
    expect(kernel.getLease(grant.leaseId)).toMatchObject({ usedCount: 1, revokedAt: null });
    expect(Object.isFrozen(grant)).toBe(true);
    if (decision.kind !== "denied") {
      expect(decision.receipt).toMatchObject({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        authorizingTurnId: TURN_ID,
        useSequence: 1,
      });
      expect(Object.isFrozen(decision.receipt)).toBe(true);
    }
  });

  it("issues only from a trusted provider-turn operation binding", () => {
    const automation = automationAuthority({
      capabilities: ["thread:drive", "browser:read", "scientific-record:propose"],
    });
    const started = beginScientOperation({
      authority: automation,
      definition: SCIENT_OPERATION_DEFINITIONS["thread.message.send"],
      projectId: PROJECT_ID,
      ingress: "automation",
      operationId: "automation-operation",
      semanticIdempotencyIdentity: "automation-request",
      semanticIdempotencyScope: {
        kind: "automation-run",
        automationId: "automation-1",
        runId: "run-1",
      },
      payloadFingerprint: DIGEST_A,
      receivedAt: NOW,
    });
    if (!started.allow) throw new Error("automation operation unexpectedly denied");
    expect(() =>
      makeKernel().issueLease({
        authorizingOperation: started.envelope,
        leaseId: "unbound-automation-lease",
        document: documentIdentity(),
        operationClass: "document.read",
        usePolicy: { kind: "single-use", maxUses: 1 },
        ttlMs: 1_000,
      }),
    ).toThrowError(/trusted provider-turn operation binding/u);
  });

  it("rejects expired leases and caps issuance at five minutes", () => {
    const kernel = makeKernel();
    issueReadLease(kernel, { ttlMs: 5 });
    expectDenial(authorizeRead(kernel, { now: NOW + 5 }), "lease_expired");
    expect(() =>
      makeKernel().issueLease({
        authorizingOperation: trustedTurnOperation(providerAuthority({ expiresAt: null })),
        leaseId: "too-long",
        document: documentIdentity(),
        operationClass: "document.read",
        usePolicy: { kind: "single-use", maxUses: 1 },
        ttlMs: MAX_BROWSER_EVIDENCE_LEASE_TTL_MS + 1,
      }),
    ).toThrow(BrowserEvidenceContractError);
  });

  it("rejects revoked leases and revoked current authority", () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    kernel.revokeLease({ leaseId: "lease-1", revokedAt: NOW + 1 });
    expectDenial(authorizeRead(kernel, { now: NOW + 2 }), "lease_revoked");

    const other = makeKernel();
    issueReadLease(other);
    expectDenial(
      authorizeRead(other, {
        authority: providerAuthority({ revokedAt: NOW + 1 }),
        now: NOW + 2,
      }),
      "authority_inactive",
    );
  });

  it("rejects a replaced actor, authority generation, or narrowed capability", () => {
    const cases: ReadonlyArray<{
      readonly authority: ScientOperationAuthority;
      readonly code: string;
    }> = [
      {
        authority: providerAuthority({
          actor: {
            kind: "provider-thread",
            threadId: THREAD_ID,
            provider: "codex",
            sessionKey: "replacement-session",
          },
        }),
        code: "actor_mismatch",
      },
      {
        authority: providerAuthority({ generation: "generation-2" }),
        code: "authority_mismatch",
      },
      {
        authority: providerAuthority({
          capabilities: ["thread:drive", "scientific-record:propose"],
        }),
        code: "capability_denied",
      },
    ];
    for (const testCase of cases) {
      const kernel = makeKernel();
      issueReadLease(kernel);
      expectDenial(authorizeRead(kernel, { authority: testCase.authority }), testCase.code);
    }
  });

  it("rejects the wrong tab before any use is consumed", () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    expectDenial(
      authorizeRead(kernel, { document: documentIdentity({ tabId: "tab-2" }) }),
      "tab_mismatch",
    );
    expect(kernel.getLease("lease-1")?.usedCount).toBe(0);
  });

  it("rejects the wrong document after same-tab navigation", () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    expectDenial(
      authorizeRead(kernel, {
        document: documentIdentity({
          documentId: "document-2",
          navigationId: "navigation-2",
          documentDigest: DIGEST_B,
        }),
      }),
      "document_mismatch",
    );
  });

  it("rejects wrong project, thread, operation class, and authorizing turn", () => {
    const cases: ReadonlyArray<{
      readonly overrides: Partial<Parameters<typeof authorizeRead>[1]>;
      readonly code: string;
    }> = [
      { overrides: { projectId: "project-2" }, code: "project_mismatch" },
      { overrides: { threadId: "thread-2" }, code: "thread_mismatch" },
      { overrides: { operationClass: "document.capture" }, code: "operation_class_mismatch" },
      { overrides: { authorizingTurnId: "turn-2" }, code: "authorizing_turn_mismatch" },
    ];
    for (const testCase of cases) {
      const kernel = makeKernel();
      issueReadLease(kernel);
      expectDenial(authorizeRead(kernel, testCase.overrides as never), testCase.code);
    }
  });

  it("replays an exact operation without consuming twice and rejects payload conflicts", () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    const first = authorizeRead(kernel);
    const replay = authorizeRead(kernel);
    expect(first.kind).toBe("allowed");
    expect(replay.kind).toBe("replayed");
    if (first.kind !== "denied" && replay.kind !== "denied") {
      expect(replay.receipt).toBe(first.receipt);
    }
    expect(kernel.getLease("lease-1")?.usedCount).toBe(1);
    expectDenial(
      authorizeRead(kernel, { payloadFingerprint: DIGEST_C }),
      "operation_replay_conflict",
    );
    expectDenial(authorizeRead(kernel, { operationId: "operation-2" }), "lease_exhausted");
  });

  it("permits only bounded exact-scope reuse for reads or annotation proposals", () => {
    const kernel = makeKernel();
    issueReadLease(kernel, { usePolicy: { kind: "narrow-reuse", maxUses: 2 } });
    expect(authorizeRead(kernel).kind).toBe("allowed");
    expect(authorizeRead(kernel, { operationId: "operation-2" }).kind).toBe("allowed");
    expectDenial(authorizeRead(kernel, { operationId: "operation-3" }), "lease_exhausted");

    expect(() =>
      makeKernel().issueLease({
        authorizingOperation: trustedTurnOperation(),
        leaseId: "action-reuse",
        document: documentIdentity(),
        operationClass: "document.action",
        usePolicy: { kind: "narrow-reuse", maxUses: 2 },
        ttlMs: 100,
      }),
    ).toThrowError(/Only document reads and annotation proposals/u);
  });

  it("atomically allows only one of two concurrent single-use operations", async () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => authorizeRead(kernel, { operationId: "concurrent-1" })),
      Promise.resolve().then(() => authorizeRead(kernel, { operationId: "concurrent-2" })),
    ]);
    expect([first.kind, second.kind].toSorted()).toEqual(["allowed", "denied"]);
    const denied = first.kind === "denied" ? first : second;
    expect(denied).toMatchObject({ code: "lease_exhausted" });
    expect(kernel.getLease("lease-1")?.usedCount).toBe(1);
  });
});

describe("BrowserEvidenceAuthorityKernel scientific evidence ledger", () => {
  it("marks browser content hostile and strips raw origins from provenance", () => {
    const envelope = provenance("browser-capture");
    expect(envelope).toMatchObject({
      trustClass: "hostile-external-content",
      instructionDisposition: "data-only-never-authority",
      scientificRole: "eligible-unverified-source",
    });
    expect(envelope).not.toHaveProperty("url");
    expect(JSON.stringify(envelope)).not.toContain("https://");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.document)).toBe(true);
  });

  it("records immutable source, annotation, proposal, verification, and manual decision receipts", () => {
    const kernel = makeKernel();
    const provider = providerAuthority();
    issueReadLease(kernel, { authority: provider });
    const sourceUse = authorizeUseFor(kernel, {
      authority: provider,
      leaseId: "lease-1",
      operationId: "source-operation",
      operationClass: "document.read",
    });
    if (sourceUse.kind === "denied") throw new Error("source lease unexpectedly denied");
    const source = kernel.recordSource({
      authority: provider,
      receiptId: "source-receipt-1",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 2,
      leaseUseReceiptId: sourceUse.receipt.receiptId,
      provenance: provenance(),
    });

    kernel.issueLease({
      authorizingOperation: trustedTurnOperation(provider),
      leaseId: "annotation-lease",
      document: documentIdentity(),
      operationClass: "annotation.propose",
      usePolicy: { kind: "single-use", maxUses: 1 },
      ttlMs: 10_000,
    });
    const annotationUse = authorizeUseFor(kernel, {
      authority: provider,
      leaseId: "annotation-lease",
      operationId: "annotation-operation",
      operationClass: "annotation.propose",
    });
    if (annotationUse.kind === "denied") throw new Error("annotation lease unexpectedly denied");
    const annotation = kernel.recordAnnotation({
      authority: provider,
      receiptId: "annotation-receipt-1",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 3,
      leaseUseReceiptId: annotationUse.receipt.receiptId,
      sourceReceiptId: source.receiptId,
      targetDigest: DIGEST_B,
      annotationDigest: DIGEST_C,
    });
    const proposal = kernel.recordProposal({
      authority: provider,
      receiptId: "proposal-receipt-1",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 4,
      claimDigest: DIGEST_D,
      evidenceReceiptIds: [source.receiptId, annotation.receiptId],
    });
    const verification = kernel.recordVerification({
      authority: provider,
      receiptId: "verification-receipt-1",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 5,
      proposalReceiptId: proposal.receiptId,
      evidenceReceiptIds: [source.receiptId],
      outcome: "supports",
    });
    const decision = kernel.recordManualDecision({
      authority: manualAuthority(),
      receiptId: "decision-receipt-1",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 6,
      proposalReceiptId: proposal.receiptId,
      verificationReceiptIds: [verification.receiptId],
      decision: "accept-scientific-truth",
    });

    expect(proposal.status).toBe("proposal-only-not-scientific-truth");
    expect(verification.status).toBe("advisory-only-not-scientific-truth");
    expect(decision).toMatchObject({
      actorKind: "manual-user",
      status: "manual-user-decision",
    });
    const receipts = [source, annotation, proposal, verification, decision];
    expect(receipts.map((receipt) => receipt.kind)).toEqual([
      "source",
      "annotation",
      "proposal",
      "verification",
      "manual-decision",
    ]);
    expect(receipts[0]?.previousReceiptHash).toBeNull();
    for (let index = 1; index < receipts.length; index += 1) {
      expect(receipts[index]?.previousReceiptHash).toBe(receipts[index - 1]?.receiptHash);
    }
    expect(receipts.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ["provider", providerAuthority()],
    ["automation", automationAuthority()],
  ])("allows %s proposals but never manual acceptance or export", (_label, actor) => {
    for (const decision of ["accept-scientific-truth", "approve-export"] as const) {
      const kernel = makeKernel();
      const { proposal, verification } = buildEligibleProposal(kernel);
      expect(() =>
        kernel.recordManualDecision({
          authority: actor,
          receiptId: `forbidden-${decision}`,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
          createdAt: NOW + 5,
          proposalReceiptId: proposal.receiptId,
          verificationReceiptIds: [verification.receiptId],
          decision,
        }),
      ).toThrowError(/Only a manual user/u);
    }
  });

  it("keeps automation memory context-only and refuses to promote it into evidence", () => {
    const kernel = makeKernel();
    const automation = automationAuthority();
    const memory = kernel.recordAutomationMemoryContext({
      authority: automation,
      receiptId: "memory-source",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 2,
      provenance: provenance("automation-memory"),
    });
    expect(memory.provenance).toMatchObject({
      trustClass: "untrusted-automation-memory",
      scientificRole: "context-only-never-scientific-evidence",
    });
    expect(() =>
      kernel.recordProposal({
        authority: automation,
        receiptId: "memory-only-proposal",
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        createdAt: NOW + 3,
        claimDigest: DIGEST_A,
        evidenceReceiptIds: [memory.receiptId],
      }),
    ).toThrowError(/Automation memory is context only/u);
  });

  it("chains receipts only within the exact project and thread scope", () => {
    const kernel = makeKernel();
    const automation = automationAuthority({ projectIds: [PROJECT_ID, "project-2"] });
    const firstProjectOne = kernel.recordAutomationMemoryContext({
      authority: automation,
      receiptId: "project-one-context-1",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 1,
      provenance: provenance("automation-memory"),
    });
    const projectTwo = kernel.recordAutomationMemoryContext({
      authority: automation,
      receiptId: "project-two-context",
      projectId: "project-2",
      threadId: "thread-2",
      createdAt: NOW + 2,
      provenance: provenance("automation-memory"),
    });
    const secondProjectOne = kernel.recordAutomationMemoryContext({
      authority: automation,
      receiptId: "project-one-context-2",
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      createdAt: NOW + 3,
      provenance: provenance("automation-memory"),
    });

    expect(firstProjectOne.previousReceiptHash).toBeNull();
    expect(projectTwo.previousReceiptHash).toBeNull();
    expect(secondProjectOne.previousReceiptHash).toBe(firstProjectOne.receiptHash);
  });

  it("keeps publication unsupported until it has a distinct authority", () => {
    const kernel = makeKernel();
    const { proposal, verification } = buildEligibleProposal(kernel);
    expect(() =>
      kernel.recordManualDecision({
        authority: manualAuthority(),
        receiptId: "unsupported-publication",
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        createdAt: NOW + 5,
        proposalReceiptId: proposal.receiptId,
        verificationReceiptIds: [verification.receiptId],
        decision: "approve-publication" as never,
      }),
    ).toThrowError(/Publication authority is not defined/u);
  });

  it("requires verification before manual acceptance or export", () => {
    const kernel = makeKernel();
    const { proposal } = buildEligibleProposal(kernel);
    expect(() =>
      kernel.recordManualDecision({
        authority: manualAuthority(),
        receiptId: "decision-without-verification",
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        createdAt: NOW + 5,
        proposalReceiptId: proposal.receiptId,
        verificationReceiptIds: [],
        decision: "approve-export",
      }),
    ).toThrowError(/require at least one verification/u);
  });
});
