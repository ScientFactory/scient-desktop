// @effect-diagnostics nodeBuiltinImport:off -- Synchronous random ids for proxy-owned session handles.
/**
 * Proxy-owned MCP session ids. An agent never sees a vendor `mcp-session-id`;
 * it receives an opaque id bound to the connector and to the Scient provider
 * session that opened it, so one session's upstream id cannot be replayed by
 * another session that shares the same vendor credential.
 */
import * as NodeCrypto from "node:crypto";

const MAX_BINDINGS = 4096;

interface Binding {
  readonly connectorId: string;
  readonly providerSessionId: string;
  readonly upstreamSessionId: string;
}

const ownerKey = (binding: Binding) =>
  `${binding.connectorId}\u0000${binding.providerSessionId}\u0000${binding.upstreamSessionId}`;

export class ConnectorSessionBindings {
  /** Insertion order is eviction order. */
  private readonly byProxyId = new Map<string, Binding>();
  private readonly byOwner = new Map<string, string>();

  /** The upstream id for `proxySessionId`, only for the caller that owns it. */
  resolve(
    proxySessionId: string,
    connectorId: string,
    providerSessionId: string,
  ): string | undefined {
    const binding = this.byProxyId.get(proxySessionId);
    return binding !== undefined &&
      binding.connectorId === connectorId &&
      binding.providerSessionId === providerSessionId
      ? binding.upstreamSessionId
      : undefined;
  }

  /** The proxy id the caller sees for an upstream session the vendor issued to it. */
  bind(connectorId: string, providerSessionId: string, upstreamSessionId: string): string {
    const binding = { connectorId, providerSessionId, upstreamSessionId };
    const key = ownerKey(binding);
    const existing = this.byOwner.get(key);
    if (existing !== undefined) return existing;
    const proxySessionId = `scs_${NodeCrypto.randomBytes(24).toString("base64url")}`;
    this.byProxyId.set(proxySessionId, binding);
    this.byOwner.set(key, proxySessionId);
    for (const [oldest] of this.byProxyId) {
      if (this.byProxyId.size <= MAX_BINDINGS) break;
      this.drop(oldest);
    }
    return proxySessionId;
  }

  drop(proxySessionId: string): void {
    const binding = this.byProxyId.get(proxySessionId);
    if (binding === undefined) return;
    this.byProxyId.delete(proxySessionId);
    this.byOwner.delete(ownerKey(binding));
  }

  dropConnector(connectorId: string): void {
    for (const [proxySessionId, binding] of this.byProxyId) {
      if (binding.connectorId === connectorId) this.drop(proxySessionId);
    }
  }
}
