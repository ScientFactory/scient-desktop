import { describe, expect, it } from "vitest";

import {
  SCIENT_OPERATION_DEFINITIONS,
  type ScientOperationAuthority,
  beginScientOperation,
} from "../scientOperations/authority.ts";
import { makeBrowserEvidenceAuthorityKernel } from "./authority.ts";
import {
  MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS,
  MAX_BROWSER_EVIDENCE_LEASE_TTL_MS,
  MAX_AUTOMATION_CONTEXT_RECEIPTS_PER_PROPOSAL,
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
    actor: {
      kind: "automation-run",
      automationId: "automation-1",
      runId: "run-1",
      // A1 adds these fields to the central actor union. The structural cast
      // keeps this independent branch composable without depending on A1.
      grantVersion: 1,
      automationVersion: `sha256:${"a".repeat(64)}`,
      threadId: THREAD_ID,
      pendingMessageId: "message-1",
      authorizingTurnId: TURN_ID,
    } as ScientOperationAuthority["actor"],
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
  let currentTime = NOW;
  const kernel = makeBrowserEvidenceAuthorityKernel({
    randomId: () => `generated-${++nextId}`,
    now: () => currentTime,
  });
  return {
    ...kernel,
    setNow(value: number) {
      currentTime = value;
    },
    advanceTime(milliseconds: number) {
      currentTime += milliseconds;
    },
  };
}

function trustedOperation(input?: {
  readonly authority?: ScientOperationAuthority;
  readonly operation?: keyof typeof SCIENT_OPERATION_DEFINITIONS;
  readonly operationId?: string;
  readonly turnId?: string;
  readonly projectId?: string;
  readonly receivedAt?: number;
  readonly payloadFingerprint?: string;
}) {
  const authority = input?.authority ?? providerAuthority();
  const operation = input?.operation ?? "browser.read";
  const operationId = input?.operationId ?? `${operation}-operation`;
  const turnId = input?.turnId ?? TURN_ID;
  const actor = authority.actor;
  const started = beginScientOperation({
    authority,
    definition: SCIENT_OPERATION_DEFINITIONS[operation],
    projectId: input?.projectId ?? PROJECT_ID,
    ingress:
      actor.kind === "provider-thread"
        ? "provider-gateway"
        : actor.kind === "automation-run"
          ? "automation"
          : "manual-ui",
    operationId,
    ...(actor.kind === "provider-thread"
      ? {
          semanticIdempotencyIdentity: `${operationId}-request`,
          semanticIdempotencyScope: {
            kind: "provider-turn" as const,
            provider: actor.provider,
            callerThreadId: actor.threadId,
            callerTurnId: turnId,
          },
          providerAuthorizingTurnId: turnId,
        }
      : actor.kind === "automation-run"
        ? {
            semanticIdempotencyIdentity: `${operationId}-request`,
            semanticIdempotencyScope: {
              kind: "automation-run" as const,
              automationId: actor.automationId,
              runId: actor.runId,
            },
          }
        : {}),
    payloadFingerprint: input?.payloadFingerprint ?? DIGEST_A,
    receivedAt: input?.receivedAt ?? NOW,
  });
  if (!started.allow) throw new Error(`trusted ${operation} operation unexpectedly denied`);
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
    authorizingOperation: trustedOperation({
      authority,
      operation: "browser.read",
      operationId: `${input?.leaseId ?? "lease-1"}-issuing-operation`,
    }),
    leaseId: input?.leaseId ?? "lease-1",
    document: input?.document ?? documentIdentity(),
    operationClass: "document.read",
    usePolicy: input?.usePolicy ?? { kind: "single-use", maxUses: 1 },
    ttlMs: input?.ttlMs ?? 10_000,
  });
}

function authorizeRead(
  kernel: ReturnType<typeof makeKernel>,
  overrides?: {
    readonly authority?: ScientOperationAuthority;
    readonly operationId?: string;
    readonly operation?: "browser.read" | "browser.capture";
    readonly payloadFingerprint?: string;
    readonly projectId?: string;
    readonly turnId?: string;
    readonly receivedAt?: number;
    readonly document?: BrowserDocumentIdentity;
    readonly authorizedOperation?: Parameters<
      typeof kernel.authorizeLeaseUse
    >[0]["authorizedOperation"];
  },
): BrowserEvidenceLeaseUseDecision {
  return kernel.authorizeLeaseUse({
    leaseId: "lease-1",
    authorizedOperation:
      overrides?.authorizedOperation ??
      trustedOperation({
        ...(overrides?.authority === undefined ? {} : { authority: overrides.authority }),
        ...(overrides?.operation === undefined ? {} : { operation: overrides.operation }),
        operationId: overrides?.operationId ?? "operation-1",
        payloadFingerprint: overrides?.payloadFingerprint ?? DIGEST_B,
        ...(overrides?.projectId === undefined ? {} : { projectId: overrides.projectId }),
        ...(overrides?.turnId === undefined ? {} : { turnId: overrides.turnId }),
        receivedAt: overrides?.receivedAt ?? NOW,
      }),
    document: overrides?.document ?? documentIdentity(),
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
    authorizedOperation: trustedOperation({
      authority: input.authority,
      operation:
        input.operationClass === "annotation.propose"
          ? "scientific-record.propose"
          : "browser.read",
      operationId: input.operationId,
      payloadFingerprint: input.payloadFingerprint ?? DIGEST_B,
      receivedAt: NOW,
    }),
    document: documentIdentity(),
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
    authorizedOperation: trustedOperation({
      authority: provider,
      operation: "scientific-record.propose",
      operationId: "source-receipt-operation",
      receivedAt: NOW,
    }),
    receiptId: "source-receipt-1",
    leaseUseReceiptId: sourceUse.receipt.receiptId,
    provenance: provenance(),
  });
  const proposal = kernel.recordProposal({
    authorizedOperation: trustedOperation({
      authority: provider,
      operation: "scientific-record.propose",
      operationId: "proposal-operation",
      receivedAt: NOW,
    }),
    receiptId: "proposal-receipt-1",
    claimDigest: DIGEST_A,
    evidenceReceiptIds: [source.receiptId],
  });
  const verification = kernel.recordVerification({
    authorizedOperation: trustedOperation({
      authority: provider,
      operation: "scientific-record.propose",
      operationId: "verification-operation",
      receivedAt: NOW,
    }),
    receiptId: "verification-receipt-1",
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
    ).toThrowError(/trusted browser.read provider-turn binding/u);
  });

  it("rejects expired leases and caps issuance at five minutes", () => {
    const kernel = makeKernel();
    issueReadLease(kernel, { ttlMs: 5 });
    kernel.advanceTime(5);
    expectDenial(authorizeRead(kernel, { receivedAt: NOW + 5 }), "lease_expired");
    expect(() =>
      makeKernel().issueLease({
        authorizingOperation: trustedOperation({
          authority: providerAuthority({ expiresAt: null }),
          operation: "browser.read",
        }),
        leaseId: "too-long",
        document: documentIdentity(),
        operationClass: "document.read",
        usePolicy: { kind: "single-use", maxUses: 1 },
        ttlMs: MAX_BROWSER_EVIDENCE_LEASE_TTL_MS + 1,
      }),
    ).toThrow(BrowserEvidenceContractError);
  });

  it("rejects explicitly revoked leases", () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    kernel.advanceTime(1);
    kernel.revokeLease({ leaseId: "lease-1" });
    expectDenial(authorizeRead(kernel, { receivedAt: NOW + 1 }), "lease_revoked");
  });

  it("rejects raw caller claims and stale or future host envelopes", () => {
    const kernel = makeKernel();
    issueReadLease(kernel);
    expectDenial(
      kernel.authorizeLeaseUse({
        leaseId: "lease-1",
        document: documentIdentity(),
        authority: providerAuthority(),
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      } as never),
      "trusted_operation_required",
    );

    const oldEnvelope = trustedOperation({ operationId: "old-use", receivedAt: NOW });
    kernel.advanceTime(MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS + 1);
    expectDenial(
      authorizeRead(kernel, { authorizedOperation: oldEnvelope }),
      "trusted_operation_required",
    );
    expectDenial(
      authorizeRead(kernel, {
        authorizedOperation: trustedOperation({
          operationId: "future-use",
          receivedAt: NOW + MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS + 2,
        }),
      }),
      "trusted_operation_required",
    );
  });

  it("requires the exact mapped operation when issuing each lease class", () => {
    expect(() =>
      makeKernel().issueLease({
        authorizingOperation: trustedOperation({ operation: "browser.capture" }),
        leaseId: "wrong-issue-operation",
        document: documentIdentity(),
        operationClass: "document.read",
        usePolicy: { kind: "single-use", maxUses: 1 },
        ttlMs: 1_000,
      }),
    ).toThrowError(/exact trusted browser.read/u);
  });

  it("rejects a replaced actor or authority generation", () => {
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

  it("rejects wrong project, thread, operation class, and stale authorizing turn", () => {
    const cases: ReadonlyArray<{
      readonly overrides: Partial<Parameters<typeof authorizeRead>[1]>;
      readonly code: string;
    }> = [
      {
        overrides: {
          authority: providerAuthority({ projectIds: [PROJECT_ID, "project-2"] }),
          projectId: "project-2",
        },
        code: "project_mismatch",
      },
      {
        overrides: {
          authority: providerAuthority({
            actor: {
              kind: "provider-thread",
              threadId: "thread-2",
              provider: "codex",
              sessionKey: "session-1",
            },
          }),
        },
        code: "thread_mismatch",
      },
      { overrides: { operation: "browser.capture" }, code: "trusted_operation_required" },
      { overrides: { turnId: "turn-2" }, code: "authorizing_turn_mismatch" },
    ];
    for (const testCase of cases) {
      const kernel = makeKernel();
      issueReadLease(kernel);
      expectDenial(authorizeRead(kernel, testCase.overrides), testCase.code);
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
        authorizingOperation: trustedOperation({ operation: "browser.action" }),
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
      authorizedOperation: trustedOperation({
        authority: provider,
        operation: "scientific-record.propose",
        operationId: "record-source",
      }),
      receiptId: "source-receipt-1",
      leaseUseReceiptId: sourceUse.receipt.receiptId,
      provenance: provenance(),
    });

    kernel.issueLease({
      authorizingOperation: trustedOperation({
        authority: provider,
        operation: "scientific-record.propose",
        operationId: "annotation-lease-issuing-operation",
      }),
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
      authorizedOperation: trustedOperation({
        authority: provider,
        operation: "scientific-record.propose",
        operationId: "record-annotation",
      }),
      receiptId: "annotation-receipt-1",
      leaseUseReceiptId: annotationUse.receipt.receiptId,
      sourceReceiptId: source.receiptId,
      targetDigest: DIGEST_B,
      annotationDigest: DIGEST_C,
    });
    const proposal = kernel.recordProposal({
      authorizedOperation: trustedOperation({
        authority: provider,
        operation: "scientific-record.propose",
        operationId: "record-proposal",
      }),
      receiptId: "proposal-receipt-1",
      claimDigest: DIGEST_D,
      evidenceReceiptIds: [source.receiptId, annotation.receiptId],
    });
    const verification = kernel.recordVerification({
      authorizedOperation: trustedOperation({
        authority: provider,
        operation: "scientific-record.propose",
        operationId: "record-verification",
      }),
      receiptId: "verification-receipt-1",
      proposalReceiptId: proposal.receiptId,
      evidenceReceiptIds: [source.receiptId],
      outcome: "supports",
    });
    const decision = kernel.recordManualDecision({
      authorizedOperation: trustedOperation({
        authority: manualAuthority(),
        operation: "scientific-record.accept",
        operationId: "record-manual-decision",
      }),
      receiptId: "decision-receipt-1",
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
    expect(() =>
      trustedOperation({
        authority: actor,
        operation: "scientific-record.accept",
        operationId: "forbidden-accept",
      }),
    ).toThrowError(/unexpectedly denied/u);

    const kernel = makeKernel();
    const { proposal, verification } = buildEligibleProposal(kernel);
    expect(() =>
      kernel.recordManualDecision({
        authorizedOperation: trustedOperation({
          authority: actor,
          operation: "export.run",
          operationId: "forbidden-export",
        }),
        receiptId: "forbidden-export",
        proposalReceiptId: proposal.receiptId,
        verificationReceiptIds: [verification.receiptId],
        decision: "approve-export",
      }),
    ).toThrowError(/Only a manual user/u);
  });

  it("keeps automation memory context-only and refuses to promote it into evidence", () => {
    const kernel = makeKernel();
    const automation = automationAuthority();
    const memory = kernel.recordAutomationMemoryContext({
      authorizedOperation: trustedOperation({
        authority: automation,
        operation: "scientific-record.propose",
        operationId: "record-memory",
      }),
      receiptId: "memory-source",
      provenance: provenance("automation-memory"),
    });
    expect(memory.provenance).toMatchObject({
      trustClass: "untrusted-automation-memory",
      scientificRole: "context-only-never-scientific-evidence",
    });
    expect(() =>
      kernel.recordProposal({
        authorizedOperation: trustedOperation({
          authority: automation,
          operation: "scientific-record.propose",
          operationId: "memory-only-proposal-operation",
        }),
        receiptId: "memory-only-proposal",
        claimDigest: DIGEST_A,
        evidenceReceiptIds: [memory.receiptId],
      }),
    ).toThrowError(/Automation memory is context only/u);
  });

  it("attaches bounded automation memory as project context without promoting it", () => {
    const kernel = makeKernel();
    const { provider, source } = buildEligibleProposal(kernel);
    const automation = automationAuthority();
    const memory = kernel.recordAutomationMemoryContext({
      authorizedOperation: trustedOperation({
        authority: automation,
        operation: "scientific-record.propose",
        operationId: "context-memory-operation",
      }),
      receiptId: "context-memory",
      provenance: provenance("automation-memory"),
    });

    const proposal = kernel.recordProposal({
      authorizedOperation: trustedOperation({
        authority: provider,
        operation: "scientific-record.propose",
        operationId: "proposal-with-context-operation",
      }),
      receiptId: "proposal-with-context",
      claimDigest: DIGEST_B,
      evidenceReceiptIds: [source.receiptId],
      contextReceiptIds: [memory.receiptId],
    });

    expect(memory.threadId).toMatch(/^automation-run:/u);
    expect(memory.threadId).not.toBe(proposal.threadId);
    expect(proposal.contextReceiptIds).toEqual([memory.receiptId]);
    expect(proposal.evidenceReceiptIds).toEqual([source.receiptId]);
  });

  it("rejects cross-project, cross-kind, and oversized context references", () => {
    const kernel = makeKernel();
    const { provider, source, proposal } = buildEligibleProposal(kernel);
    const automation = automationAuthority({ projectIds: [PROJECT_ID, "project-2"] });
    const projectTwoMemory = kernel.recordAutomationMemoryContext({
      authorizedOperation: trustedOperation({
        authority: automation,
        operation: "scientific-record.propose",
        operationId: "project-two-memory-operation",
        projectId: "project-2",
      }),
      receiptId: "project-two-memory",
      provenance: provenance("automation-memory"),
    });

    expect(() =>
      kernel.recordProposal({
        authorizedOperation: trustedOperation({
          authority: provider,
          operation: "scientific-record.propose",
          operationId: "cross-project-context-operation",
        }),
        receiptId: "cross-project-context",
        claimDigest: DIGEST_B,
        evidenceReceiptIds: [source.receiptId],
        contextReceiptIds: [projectTwoMemory.receiptId],
      }),
    ).toThrowError(/outside the proposal project/u);

    expect(() =>
      kernel.recordProposal({
        authorizedOperation: trustedOperation({
          authority: provider,
          operation: "scientific-record.propose",
          operationId: "non-memory-context-operation",
        }),
        receiptId: "non-memory-context",
        claimDigest: DIGEST_C,
        evidenceReceiptIds: [source.receiptId],
        contextReceiptIds: [source.receiptId],
      }),
    ).toThrowError(/context-only automation-memory source receipts only/u);

    expect(() =>
      kernel.recordProposal({
        authorizedOperation: trustedOperation({
          authority: provider,
          operation: "scientific-record.propose",
          operationId: "cross-kind-context-operation",
        }),
        receiptId: "cross-kind-context",
        claimDigest: DIGEST_C,
        evidenceReceiptIds: [source.receiptId],
        contextReceiptIds: [proposal.receiptId],
      }),
    ).toThrowError(/Referenced source receipt does not exist/u);

    expect(() =>
      kernel.recordProposal({
        authorizedOperation: trustedOperation({
          authority: provider,
          operation: "scientific-record.propose",
          operationId: "oversized-context-operation",
        }),
        receiptId: "oversized-context",
        claimDigest: DIGEST_D,
        evidenceReceiptIds: [source.receiptId],
        contextReceiptIds: Array.from(
          { length: MAX_AUTOMATION_CONTEXT_RECEIPTS_PER_PROPOSAL + 1 },
          (_, index) => `not-resolved-context-${index}`,
        ),
      }),
    ).toThrowError(/may reference at most/u);
  });

  it("requires A1 automation turn binding and prevents cross-thread append", () => {
    const kernel = makeKernel();
    const { source, proposal } = buildEligibleProposal(kernel);
    const legacyAutomation = automationAuthority({
      actor: {
        kind: "automation-run",
        automationId: "automation-legacy",
        runId: "run-legacy",
      },
    });
    expect(() =>
      kernel.recordAutomationMemoryContext({
        authorizedOperation: trustedOperation({
          authority: legacyAutomation,
          operation: "scientific-record.propose",
          operationId: "legacy-automation-operation",
        }),
        receiptId: "legacy-automation-memory",
        provenance: provenance("automation-memory"),
      }),
    ).toThrow(BrowserEvidenceContractError);

    const otherThreadAutomation = automationAuthority({
      actor: {
        kind: "automation-run",
        automationId: "automation-1",
        runId: "run-1",
        grantVersion: 1,
        automationVersion: `sha256:${"a".repeat(64)}`,
        threadId: "thread-2",
        pendingMessageId: "message-2",
        authorizingTurnId: "turn-2",
      } as ScientOperationAuthority["actor"],
    });
    expect(() =>
      kernel.recordProposal({
        authorizedOperation: trustedOperation({
          authority: otherThreadAutomation,
          operation: "scientific-record.propose",
          operationId: "cross-thread-proposal-operation",
        }),
        receiptId: "cross-thread-proposal",
        claimDigest: DIGEST_A,
        evidenceReceiptIds: [source.receiptId],
      }),
    ).toThrowError(/outside its exact thread/u);
    expect(() =>
      kernel.recordVerification({
        authorizedOperation: trustedOperation({
          authority: otherThreadAutomation,
          operation: "scientific-record.propose",
          operationId: "cross-thread-verification-operation",
        }),
        receiptId: "cross-thread-verification",
        proposalReceiptId: proposal.receiptId,
        evidenceReceiptIds: [source.receiptId],
        outcome: "supports",
      }),
    ).toThrowError(/outside its exact thread/u);
  });

  it("rejects raw mutation claims and delayed host envelopes", () => {
    const kernel = makeKernel();
    expect(() =>
      kernel.recordProposal({
        authority: providerAuthority(),
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        createdAt: NOW,
        claimDigest: DIGEST_A,
        evidenceReceiptIds: [],
      } as never),
    ).toThrowError(/exact host-minted scientific-record.propose envelope/u);

    const { source } = buildEligibleProposal(kernel);
    const delayedEnvelope = trustedOperation({
      operation: "scientific-record.propose",
      operationId: "delayed-proposal-operation",
      receivedAt: NOW,
    });
    kernel.advanceTime(MAX_BROWSER_EVIDENCE_ENVELOPE_AGE_MS + 1);
    expect(() =>
      kernel.recordProposal({
        authorizedOperation: delayedEnvelope,
        receiptId: "delayed-proposal",
        claimDigest: DIGEST_B,
        evidenceReceiptIds: [source.receiptId],
      }),
    ).toThrowError(/future-dated or stale/u);
  });

  it("chains receipts only within the exact project and thread scope", () => {
    const kernel = makeKernel();
    const automation = automationAuthority({ projectIds: [PROJECT_ID, "project-2"] });
    const firstProjectOne = kernel.recordAutomationMemoryContext({
      authorizedOperation: trustedOperation({
        authority: automation,
        operation: "scientific-record.propose",
        operationId: "project-one-context-1-operation",
      }),
      receiptId: "project-one-context-1",
      provenance: provenance("automation-memory"),
    });
    const projectTwo = kernel.recordAutomationMemoryContext({
      authorizedOperation: trustedOperation({
        authority: automation,
        operation: "scientific-record.propose",
        operationId: "project-two-context-operation",
        projectId: "project-2",
      }),
      receiptId: "project-two-context",
      provenance: provenance("automation-memory"),
    });
    const secondProjectOne = kernel.recordAutomationMemoryContext({
      authorizedOperation: trustedOperation({
        authority: automation,
        operation: "scientific-record.propose",
        operationId: "project-one-context-2-operation",
      }),
      receiptId: "project-one-context-2",
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
        authorizedOperation: trustedOperation({
          authority: manualAuthority(),
          operation: "scientific-record.accept",
          operationId: "unsupported-publication-operation",
        }),
        receiptId: "unsupported-publication",
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
        authorizedOperation: trustedOperation({
          authority: manualAuthority(),
          operation: "export.run",
          operationId: "decision-without-verification-operation",
        }),
        receiptId: "decision-without-verification",
        proposalReceiptId: proposal.receiptId,
        verificationReceiptIds: [],
        decision: "approve-export",
      }),
    ).toThrowError(/require at least one verification/u);
  });
});
