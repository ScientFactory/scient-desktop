import { describe, expect, it } from "vitest";

import {
  beginScientOperation,
  completeScientOperation,
  makeScientOperationAuthority,
  SCIENT_OPERATION_DEFINITIONS,
  type ScientOperationAuthority,
} from "./authority.ts";

const NOW = 1_000;
const readThread = SCIENT_OPERATION_DEFINITIONS["thread.read"];

function authority(overrides?: Partial<ScientOperationAuthority>): ScientOperationAuthority {
  return makeScientOperationAuthority({
    authorityId: "provider-session:one",
    generation: "generation:one",
    actor: {
      kind: "provider-thread",
      threadId: "thread-1",
      provider: "claudeAgent",
      sessionKey: "session-1",
    },
    projectIds: ["project-1"],
    capabilities: ["thread:read"],
    issuedAt: NOW - 100,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });
}

function begin(overrides?: Partial<Parameters<typeof beginScientOperation>[0]>) {
  return beginScientOperation({
    authority: authority(),
    definition: readThread,
    projectId: "project-1",
    ingress: "provider-gateway",
    operationId: "operation-7",
    semanticIdempotencyIdentity: "logical-request-7",
    semanticIdempotencyScope: {
      kind: "provider-turn",
      provider: "claudeAgent",
      callerThreadId: "thread-1",
      callerTurnId: "turn-1",
    },
    payloadFingerprint: "payload-sha256",
    parentOperationId: "operation-parent",
    receivedAt: NOW,
    ...overrides,
  });
}

describe("beginScientOperation", () => {
  it("authorizes and mints one immutable request envelope", () => {
    const result = begin();
    expect(result.allow).toBe(true);
    if (!result.allow) return;

    expect(result.envelope).toMatchObject({
      operationId: "operation-7",
      operation: "thread.read",
      capability: "thread:read",
      projectId: "project-1",
      ingress: "provider-gateway",
      parentOperationId: "operation-parent",
      providerAuthorizingTurnId: "turn-1",
      idempotency: {
        mode: "semantic",
        payloadFingerprint: "payload-sha256",
      },
      authority: {
        authorityId: "provider-session:one",
        generation: "generation:one",
        projectIds: ["project-1"],
        capabilities: ["thread:read"],
        issuedAt: NOW - 100,
        expiresAt: null,
        revokedAt: null,
      },
    });
    expect(result.envelope.idempotency.claimKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result.envelope.idempotency.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.envelope)).not.toContain("logical-request-7");
    expect(result.envelope.authority.grantHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.envelope)).toBe(true);
    expect(Object.isFrozen(result.envelope.authority)).toBe(true);
    expect(Object.isFrozen(result.envelope.authority.actor)).toBe(true);
    expect(Object.isFrozen(result.envelope.authority.capabilities)).toBe(true);
    expect(Object.isFrozen(result.envelope.authority.projectIds)).toBe(true);
  });

  it("keeps provider audit turn aligned with semantic retry scope", () => {
    expect(() =>
      begin({
        providerAuthorizingTurnId: "turn-other",
      }),
    ).toThrow("Provider authorizing turn must match the semantic retry turn");
    const unique = begin({
      semanticIdempotencyIdentity: null,
      providerAuthorizingTurnId: "turn-independent",
    });
    if (!unique.allow) throw new Error("expected authorization");
    expect(unique.envelope.providerAuthorizingTurnId).toBe("turn-independent");
  });

  it.each([
    ["forged project", { projectId: "project-other" }, "project_scope_denied"],
    ["missing capability", { authority: authority({ capabilities: [] }) }, "capability_denied"],
    [
      "wrong actor",
      {
        authority: authority({
          actor: { kind: "external-integration", integrationId: "integration-1" },
        }),
        definition: SCIENT_OPERATION_DEFINITIONS["scientific-record.accept"],
      },
      "actor_kind_denied",
    ],
    ["revoked", { authority: authority({ revokedAt: NOW - 1 }) }, "authority_revoked"],
    ["not yet valid", { authority: authority({ issuedAt: NOW + 1 }) }, "authority_not_yet_valid"],
    ["expired", { authority: authority({ expiresAt: NOW }) }, "authority_expired"],
  ] as const)("does not mint an envelope for %s authority", (_label, overrides, code) => {
    const result = begin(overrides);
    expect(result).toMatchObject({ allow: false, decision: { code } });
    expect("envelope" in result).toBe(false);
  });

  it("uses a unique non-replay identity when the operation has no semantic key", () => {
    const first = begin({ operationId: "operation-one", semanticIdempotencyIdentity: null });
    const second = begin({ operationId: "operation-two", semanticIdempotencyIdentity: null });
    if (!first.allow || !second.allow) throw new Error("expected authorization");
    expect(first.envelope.idempotency.mode).toBe("unique");
    expect(first.envelope.idempotency.claimKey).not.toBe(second.envelope.idempotency.claimKey);
  });

  it("keeps one claim key across transport retries while fingerprinting conflicts separately", () => {
    const first = begin({ operationId: "attempt-one", payloadFingerprint: "payload-one" });
    const retry = begin({ operationId: "attempt-two", payloadFingerprint: "payload-one" });
    const conflict = begin({ operationId: "attempt-three", payloadFingerprint: "payload-two" });
    if (!first.allow || !retry.allow || !conflict.allow) throw new Error("expected authorization");

    expect(retry.envelope.idempotency.claimKey).toBe(first.envelope.idempotency.claimKey);
    expect(conflict.envelope.idempotency.claimKey).toBe(first.envelope.idempotency.claimKey);
    expect(conflict.envelope.idempotency.payloadFingerprint).not.toBe(
      first.envelope.idempotency.payloadFingerprint,
    );
  });

  it("uses canonical hashing without delimiter collisions", () => {
    const left = begin({
      authority: authority({
        actor: {
          kind: "provider-thread",
          threadId: "a:b",
          provider: "claudeAgent",
          sessionKey: "left",
        },
      }),
      semanticIdempotencyScope: {
        kind: "provider-turn",
        provider: "claudeAgent",
        callerThreadId: "a:b",
        callerTurnId: "c",
      },
    });
    const right = begin({
      authority: authority({
        actor: {
          kind: "provider-thread",
          threadId: "a",
          provider: "claudeAgent",
          sessionKey: "right",
        },
      }),
      semanticIdempotencyScope: {
        kind: "provider-turn",
        provider: "claudeAgent",
        callerThreadId: "a",
        callerTurnId: "b:c",
      },
    });
    if (!left.allow || !right.allow) throw new Error("expected authorization");
    expect(left.envelope.idempotency.claimKey).not.toBe(right.envelope.idempotency.claimKey);
  });

  it("keeps same-turn retries stable across provider session replacement", () => {
    const first = begin();
    const replacement = begin({
      authority: authority({
        authorityId: "provider-session:replacement",
        generation: "generation:replacement",
        actor: {
          kind: "provider-thread",
          threadId: "thread-1",
          provider: "claudeAgent",
          sessionKey: "session-replacement",
        },
      }),
    });
    const laterTurn = begin({
      semanticIdempotencyScope: {
        kind: "provider-turn",
        provider: "claudeAgent",
        callerThreadId: "thread-1",
        callerTurnId: "turn-2",
      },
    });
    if (!first.allow || !replacement.allow || !laterTurn.allow) {
      throw new Error("expected authorization");
    }
    expect(replacement.envelope.idempotency.claimKey).toBe(first.envelope.idempotency.claimKey);
    expect(laterTurn.envelope.idempotency.claimKey).not.toBe(first.envelope.idempotency.claimKey);
  });

  it("changes grant evidence when scope, capability, or expiry changes", () => {
    const baseline = begin();
    const widerScope = begin({ authority: authority({ projectIds: ["project-1", "project-2"] }) });
    const widerCapability = begin({
      authority: authority({ capabilities: ["thread:read", "thread:list"] }),
    });
    const expiring = begin({ authority: authority({ expiresAt: NOW + 1_000 }) });
    if (!baseline.allow || !widerScope.allow || !widerCapability.allow || !expiring.allow) {
      throw new Error("expected authorization");
    }
    expect(widerScope.envelope.authority.grantHash).not.toBe(baseline.envelope.authority.grantHash);
    expect(widerCapability.envelope.authority.grantHash).not.toBe(
      baseline.envelope.authority.grantHash,
    );
    expect(expiring.envelope.authority.grantHash).not.toBe(baseline.envelope.authority.grantHash);
  });
});

describe("SCIENT_OPERATION_DEFINITIONS", () => {
  it("owns canonical send semantics independently of transport spelling", () => {
    const canonicalize = SCIENT_OPERATION_DEFINITIONS["thread.message.send"].canonicalizeInput;
    expect(canonicalize).not.toBeNull();
    const omittedDefault = canonicalize!({
      threadId: " thread-2 ",
      message: " hello ",
      requestId: " retry-1 ",
    });
    const explicitDefault = canonicalize!({
      threadId: "thread-2",
      message: "hello",
      mode: "queue",
      requestId: "retry-1",
    });
    expect(omittedDefault).toEqual(explicitDefault);
    expect(Object.isFrozen(omittedDefault)).toBe(true);
  });

  it("keeps future operation families unavailable until their domain input is defined", () => {
    expect(SCIENT_OPERATION_DEFINITIONS["browser.action"].canonicalizeInput).toBeNull();
    expect(SCIENT_OPERATION_DEFINITIONS["automation.run"].canonicalizeInput).toBeNull();
  });
});

describe("completeScientOperation", () => {
  it("emits an immutable receipt tied to authorization and effect identities", () => {
    const started = begin();
    if (!started.allow) throw new Error("expected authorization");
    const receipt = completeScientOperation({
      envelope: started.envelope,
      receiptId: "receipt-1",
      finishedAt: NOW + 5,
      outcome: "succeeded",
      effects: [{ kind: "orchestration-command", identity: "command-1" }],
    });

    expect(receipt).toMatchObject({
      receiptId: "receipt-1",
      operationId: "operation-7",
      operation: "thread.read",
      projectId: "project-1",
      authorityGeneration: "generation:one",
      authorization: "allowed",
      startedAt: NOW,
      finishedAt: NOW + 5,
      outcome: "succeeded",
      errorCode: null,
      effects: [{ kind: "orchestration-command", identity: "command-1" }],
    });
    expect(receipt.grantHash).toBe(started.envelope.authority.grantHash);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.effects)).toBe(true);
    expect(Object.isFrozen(receipt.effects[0])).toBe(true);
  });
});
