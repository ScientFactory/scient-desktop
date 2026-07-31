import { describe, expect, it } from "vitest";

import {
  authorizeScientOperation,
  makeScientOperationRequestEnvelope,
  type ScientOperationAuthority,
  type ScientOperationCapability,
} from "./authority.ts";

const NOW = 1_000;

function authority(overrides?: Partial<ScientOperationAuthority>): ScientOperationAuthority {
  return {
    authorityId: "provider-session:one",
    generation: "generation:one",
    actor: {
      kind: "provider-thread",
      threadId: "thread-1",
      provider: "claudeAgent",
      sessionKey: "session-1",
    },
    projectIds: new Set(["project-1"]),
    capabilities: new Set<ScientOperationCapability>(["thread:read"]),
    issuedAt: NOW - 100,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

const providerActors = new Set(["provider-thread"] as const);

describe("authorizeScientOperation", () => {
  it("allows an exact actor, project, capability, and time match", () => {
    expect(
      authorizeScientOperation({
        authority: authority(),
        capability: "thread:read",
        projectId: "project-1",
        allowedActorKinds: providerActors,
        now: NOW,
      }),
    ).toEqual({ allow: true });
  });

  it("denies a forged project even when the capability matches", () => {
    expect(
      authorizeScientOperation({
        authority: authority(),
        capability: "thread:read",
        projectId: "project-other",
        allowedActorKinds: providerActors,
        now: NOW,
      }),
    ).toMatchObject({ allow: false, code: "project_scope_denied" });
  });

  it("defaults to deny when the required capability is absent", () => {
    expect(
      authorizeScientOperation({
        authority: authority(),
        capability: "thread:drive",
        projectId: "project-1",
        allowedActorKinds: providerActors,
        now: NOW,
      }),
    ).toMatchObject({
      allow: false,
      code: "capability_denied",
      details: { requiredCapability: "thread:drive" },
    });
  });

  it("denies a valid capability presented by the wrong actor kind", () => {
    expect(
      authorizeScientOperation({
        authority: authority({
          actor: { kind: "external-integration", integrationId: "integration-1" },
        }),
        capability: "thread:read",
        projectId: "project-1",
        allowedActorKinds: providerActors,
        now: NOW,
      }),
    ).toMatchObject({ allow: false, code: "actor_kind_denied" });
  });

  it.each([
    ["revoked", authority({ revokedAt: NOW - 1 }), "authority_revoked"],
    ["not-yet-valid", authority({ issuedAt: NOW + 1 }), "authority_not_yet_valid"],
    ["expired", authority({ expiresAt: NOW }), "authority_expired"],
  ] as const)("denies %s authority", (_label, resolvedAuthority, code) => {
    expect(
      authorizeScientOperation({
        authority: resolvedAuthority,
        capability: "thread:read",
        projectId: "project-1",
        allowedActorKinds: providerActors,
        now: NOW,
      }),
    ).toMatchObject({ allow: false, code });
  });
});

describe("makeScientOperationRequestEnvelope", () => {
  it("binds host-resolved actor, project, capability, generation, and lineage", () => {
    const resolvedAuthority = authority();
    const envelope = makeScientOperationRequestEnvelope({
      authority: resolvedAuthority,
      operationId: "operation-7",
      operation: "scient_read_thread",
      capability: "thread:read",
      projectId: "project-1",
      ingress: "provider-gateway",
      idempotencyIdentity: "number:7",
      payloadFingerprint: "payload-sha256",
      parentOperationId: "operation-parent",
      receivedAt: NOW,
    });

    expect(envelope).toEqual({
      operationId: "operation-7",
      operation: "scient_read_thread",
      idempotencyKey:
        "provider-session:one:generation:one:provider-thread:claudeAgent:thread-1:session-1:project-1:scient_read_thread:thread:read:number:7:payload-sha256",
      capability: "thread:read",
      projectId: "project-1",
      actor: resolvedAuthority.actor,
      authorityId: "provider-session:one",
      authorityGeneration: "generation:one",
      ingress: "provider-gateway",
      parentOperationId: "operation-parent",
      payloadFingerprint: "payload-sha256",
      receivedAt: NOW,
    });
  });

  it("changes idempotency identity when the authority generation or payload changes", () => {
    const base = {
      authority: authority(),
      operationId: "operation-7",
      operation: "scient_read_thread",
      capability: "thread:read" as const,
      projectId: "project-1",
      ingress: "provider-gateway" as const,
      idempotencyIdentity: "number:7",
      payloadFingerprint: "payload-one",
      receivedAt: NOW,
    };
    const original = makeScientOperationRequestEnvelope(base);
    const newPayload = makeScientOperationRequestEnvelope({
      ...base,
      payloadFingerprint: "payload-two",
    });
    const newGeneration = makeScientOperationRequestEnvelope({
      ...base,
      authority: authority({ generation: "generation:two" }),
    });
    const newActor = makeScientOperationRequestEnvelope({
      ...base,
      authority: authority({
        actor: {
          kind: "provider-thread",
          threadId: "thread-2",
          provider: "claudeAgent",
          sessionKey: "session-1",
        },
      }),
    });

    expect(newPayload.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(newGeneration.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(newActor.idempotencyKey).not.toBe(original.idempotencyKey);
  });
});
