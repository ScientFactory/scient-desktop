/**
 * AgentGatewaySessionRegistryLive - In-memory session registry layer.
 *
 * Tokens are opaque, minted per provider runtime, revocable independently, and
 * deliberately do not survive a Scient restart.
 *
 * @module agentGateway/Layers/AgentGatewaySessionRegistry
 */
import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionIdentity,
  type AgentGatewayWriteAuthority,
  type AgentGatewaySessionRegistryShape,
} from "../Services/AgentGatewaySessionRegistry.ts";

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  const sessions = new Map<string, AgentGatewaySessionIdentity>();
  const sessionsByKey = new Map<string, AgentGatewaySessionIdentity>();
  const revocationListeners = new Set<(identity: AgentGatewaySessionIdentity) => void>();

  return {
    issue: (threadId, provider) => {
      // Every provider runtime owns an independent credential. Replacement
      // runtimes overlap their predecessor during startup, and the outgoing
      // runtime revokes its own token during teardown. Reusing a token here
      // would therefore let old-session cleanup invalidate the replacement.
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        // Least privilege: the gateway mints read + drive (send/interrupt), the
        // capabilities the wired tools actually need. The drive capability is
        // still gated per-request on an active caller turn (requiresActiveTurn)
        // and the central drive policy. `automation:write` is deliberately not
        // minted — no automation tool is wired yet, so granting it would be
        // standing privilege with no consumer.
        capabilities: new Set(["thread:read", "thread:write"]),
      };
      sessions.set(token, identity);
      sessionsByKey.set(sessionKey, identity);
      return { token, ...identity };
    },
    verify: (token) => {
      // Tokens are opaque, high-entropy random identifiers (a `randomId()`
      // UUID, ~122 bits), not secrets compared against a stored value, so a
      // direct hash-map lookup is used rather than a constant-time compare: an
      // attacker cannot narrow the token by measuring `Map.get` timing, and a
      // linear constant-time scan over all live sessions would only add cost
      // without closing a realistic channel on this loopback endpoint.
      const identity = sessions.get(token);
      if (!identity) return null;
      return identity;
    },
    bindWriteAuthority: (token, turnId) => {
      const identity = sessions.get(token);
      if (!identity) return null;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const identity = sessionsByKey.get(authority.sessionKey);
      return (
        identity !== undefined &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider
      );
    },
    subscribeRevocations: (listener) => {
      revocationListeners.add(listener);
      return () => revocationListeners.delete(listener);
    },
    revoke: (token) => {
      const identity = sessions.get(token);
      if (!identity) return;
      sessions.delete(token);
      sessionsByKey.delete(identity.sessionKey);
      for (const listener of revocationListeners) listener(identity);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
