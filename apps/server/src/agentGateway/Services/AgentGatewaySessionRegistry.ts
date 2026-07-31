/**
 * AgentGatewaySessionRegistry - In-memory provider-session credential store.
 *
 * Holds the opaque bearer tokens minted for provider sessions and the
 * non-secret authority captured when an MCP request enters the gateway.
 * Session credentials survive across turns (so native sessions can resume
 * without rebuilding their MCP client); write authority is narrower and pinned
 * to the exact running turn observed at ingress.
 *
 * @module agentGateway/Services/AgentGatewaySessionRegistry
 */
import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

import type { ScientOperationCapability } from "../../scientOperations/authority.ts";

export interface AgentGatewaySessionIdentity {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly issuedAt: number;
  readonly capabilities: ReadonlyArray<ScientOperationCapability>;
}

export interface AgentGatewayIssuedSession extends AgentGatewaySessionIdentity {
  readonly token: string;
}

/**
 * Non-secret authority captured when an MCP HTTP request enters the gateway.
 *
 * Provider-session credentials intentionally survive across turns so native
 * sessions can resume without rebuilding their MCP client. Write authority is
 * narrower: one request/batch is pinned to the exact running turn observed at
 * ingress and must never be rebound to a later `latestTurn` while it executes.
 */
export interface AgentGatewayWriteAuthority {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly turnId: string;
}

export interface AgentGatewayWriteLease {
  readonly sessionKey: string;
  readonly release: () => void;
}

export interface AgentGatewaySessionRegistryShape {
  readonly issue: (threadId: ThreadId, provider: ProviderKind) => AgentGatewayIssuedSession;
  readonly verify: (token: string) => AgentGatewaySessionIdentity | null;
  readonly bindWriteAuthority: (token: string, turnId: string) => AgentGatewayWriteAuthority | null;
  readonly verifyWriteAuthority: (authority: AgentGatewayWriteAuthority) => boolean;
  /**
   * Atomically orders a write against revocation. A lease acquired first may
   * finish; revocation first prevents acquisition. New work is always denied
   * immediately after revocation.
   */
  readonly acquireWriteLease: (
    authority: AgentGatewayWriteAuthority,
  ) => AgentGatewayWriteLease | null;
  readonly subscribeRevocations: (
    listener: (identity: AgentGatewaySessionIdentity) => void,
  ) => () => void;
  readonly revoke: (token: string) => void;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("synara/agentGateway/Services/AgentGatewaySessionRegistry") {}
