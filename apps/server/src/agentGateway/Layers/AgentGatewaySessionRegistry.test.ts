import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";

const THREAD = ThreadId.makeUnsafe("thread-1");

function makeRegistry(nowValue = 1_000) {
  let counter = 0;
  return makeAgentGatewaySessionRegistry({
    now: () => nowValue,
    randomId: () => `id-${counter++}`,
  });
}

describe("makeAgentGatewaySessionRegistry", () => {
  describe("issue", () => {
    it("returns a token plus the session identity", () => {
      const registry = makeRegistry(1_234);
      const issued = registry.issue(THREAD, "claudeAgent");

      expect(issued.token).toMatch(/^sagw_session_/);
      expect(issued.sessionKey).toMatch(/^gateway-session:/);
      expect(issued.threadId).toBe(THREAD);
      expect(issued.provider).toBe("claudeAgent");
      expect(issued.issuedAt).toBe(1_234);
    });

    it("issuing twice for the same thread yields different tokens and sessionKeys", () => {
      const registry = makeRegistry();
      const first = registry.issue(THREAD, "claudeAgent");
      const second = registry.issue(THREAD, "claudeAgent");

      expect(first.token).not.toBe(second.token);
      expect(first.sessionKey).not.toBe(second.sessionKey);
    });

    it("issues exactly the wired operation capabilities and no automation power", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");

      expect(Array.from(issued.capabilities)).toEqual([
        "project:context:read",
        "thread:list",
        "thread:read",
        "thread:drive",
      ]);
      expect(issued.capabilities.includes("project:context:read")).toBe(true);
      expect(issued.capabilities.includes("thread:list")).toBe(true);
      expect(issued.capabilities.includes("thread:read")).toBe(true);
      expect(issued.capabilities.includes("thread:drive")).toBe(true);
      // No automation tool is wired, so automation:run is never minted.
      expect(issued.capabilities.includes("automation:run")).toBe(false);
      expect(Object.isFrozen(issued.capabilities)).toBe(true);
    });
  });

  describe("verify", () => {
    it("resolves a live token to its identity", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");

      const identity = registry.verify(issued.token);
      expect(identity?.threadId).toBe(THREAD);
      expect(identity?.sessionKey).toBe(issued.sessionKey);
      expect(identity?.provider).toBe("claudeAgent");
    });

    it("returns null for an unknown token", () => {
      const registry = makeRegistry();
      expect(registry.verify("nope")).toBeNull();
    });
  });

  describe("bindWriteAuthority", () => {
    it("returns an authority scoped to the given turn", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");

      const authority = registry.bindWriteAuthority(issued.token, "turn-1");
      expect(authority).toEqual({
        sessionKey: issued.sessionKey,
        threadId: THREAD,
        provider: "claudeAgent",
        turnId: "turn-1",
      });
    });

    it("returns null for an unknown token", () => {
      const registry = makeRegistry();
      expect(registry.bindWriteAuthority("nope", "turn-1")).toBeNull();
    });
  });

  describe("verifyWriteAuthority", () => {
    it("is true for a freshly issued and bound authority", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");
      const authority = registry.bindWriteAuthority(issued.token, "turn-1");
      expect(authority).not.toBeNull();

      expect(registry.verifyWriteAuthority(authority!)).toBe(true);
    });

    it("is false after the token backing it has been revoked", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");
      const authority = registry.bindWriteAuthority(issued.token, "turn-1");
      expect(authority).not.toBeNull();

      registry.revoke(issued.token);

      expect(registry.verifyWriteAuthority(authority!)).toBe(false);
    });
  });

  describe("acquireWriteLease", () => {
    it("orders acquisition before revocation and makes release idempotent", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");
      const authority = registry.bindWriteAuthority(issued.token, "turn-1");
      expect(authority).not.toBeNull();

      const lease = registry.acquireWriteLease(authority!);
      expect(lease?.sessionKey).toBe(issued.sessionKey);
      registry.revoke(issued.token);

      expect(registry.acquireWriteLease(authority!)).toBeNull();
      expect(() => {
        lease?.release();
        lease?.release();
      }).not.toThrow();
    });

    it("denies acquisition when revocation wins the ordering", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");
      const authority = registry.bindWriteAuthority(issued.token, "turn-1");
      expect(authority).not.toBeNull();

      registry.revoke(issued.token);

      expect(registry.acquireWriteLease(authority!)).toBeNull();
    });
  });

  describe("revoke", () => {
    it("notifies lifecycle subscribers exactly once with the revoked session", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");
      const revoked: string[] = [];
      const unsubscribe = registry.subscribeRevocations((identity) => {
        revoked.push(identity.sessionKey);
      });

      registry.revoke(issued.token);
      registry.revoke(issued.token);
      unsubscribe();

      expect(revoked).toEqual([issued.sessionKey]);
    });

    it("clears both the token and sessionKey maps", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");
      const authority = registry.bindWriteAuthority(issued.token, "turn-1");
      expect(authority).not.toBeNull();

      registry.revoke(issued.token);

      expect(registry.verify(issued.token)).toBeNull();
      expect(registry.verifyWriteAuthority(authority!)).toBe(false);
    });

    it("is a no-op when revoking an unknown token", () => {
      const registry = makeRegistry();
      const issued = registry.issue(THREAD, "claudeAgent");

      expect(() => registry.revoke("nope")).not.toThrow();
      expect(registry.verify(issued.token)).not.toBeNull();
    });
  });
});
