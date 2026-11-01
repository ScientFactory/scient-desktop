import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// SCIENT-FORK:START — scoped credential revocation observers release plugin key caches.
import type * as Scope from "effect/Scope";
// SCIENT-FORK:END
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly skillScope?: McpInvocationContext.McpScientSkillScope;
  // SCIENT-FORK:START Scient Extensions connectors
  /**
   * Connectors delivered with this credential. The registry derives each
   * proxy URL from its own endpoint; the set is bound into the scope so the
   * connector proxy honors exactly what the session received. Defaults to none.
   */
  readonly connectors?: ReadonlyArray<McpCredentialConnector>;
  // SCIENT-FORK:END
  readonly subagent?: boolean;
}

// SCIENT-FORK:START Scient Extensions connectors
export interface McpCredentialConnector {
  readonly connectorId: string;
  readonly serverName: string;
  readonly displayName: string;
}
// SCIENT-FORK:END

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  /** Replaces the exact skill scope used by the next turn on this thread. */
  readonly replaceSkillScope: (
    threadId: ThreadId,
    skillScope: McpInvocationContext.McpScientSkillScope,
  ) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
  // SCIENT-FORK:START — scoped credential revocation observers release plugin key caches.
  readonly onRevoke?: (
    handler: (sessionId: string, reason: "expired" | "revoked") => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  // SCIENT-FORK:END
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

// SCIENT-FORK:START Scient Extensions connectors
/** The connector proxy endpoint beside the Scient MCP endpoint, same origin and bearer. */
export const connectorProxyUrl = (endpoint: string, connectorId: string): string =>
  new URL(`/mcp/connectors/${encodeURIComponent(connectorId)}`, endpoint).toString();
// SCIENT-FORK:END

const copySkillScope = (
  skillScope: McpInvocationContext.McpScientSkillScope,
): McpInvocationContext.McpScientSkillScope => ({
  // Values are immutable SkillRelease snapshots. Preserve their object
  // identity because verified resource bytes are bound to the exact snapshot.
  ...(skillScope.catalog ? { catalog: { ...skillScope.catalog } } : {}),
  releases: new Map(skillScope.releases),
  skills: skillScope.skills.map((skill) => ({ ...skill })),
});

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  // SCIENT-FORK:START — invalidate secrets on every credential exit, including expiry.
  const revocationHandlers = new Set<
    (sessionId: string, reason: "expired" | "revoked") => Effect.Effect<void>
  >();
  const notifyRevoked = (ids: ReadonlyArray<string>, reason: "expired" | "revoked" = "revoked") =>
    Effect.forEach(
      ids,
      (id) =>
        Effect.forEach(revocationHandlers, (handler) => handler(id, reason), { discard: true }),
      { discard: true },
    );
  // SCIENT-FORK:END
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      // SCIENT-FORK:START Scient Extensions connectors
      const connectors = (request.connectors ?? []).map(
        (connector): McpProviderSession.McpProviderSessionConnector => ({
          connectorId: connector.connectorId,
          serverName: connector.serverName,
          displayName: connector.displayName,
          url: connectorProxyUrl(endpoint, connector.connectorId),
        }),
      );
      // SCIENT-FORK:END
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>(
          request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : []),
        ),
        // SCIENT-FORK:START Scient Extensions connectors
        connectorIds: new Set(connectors.map((connector) => connector.connectorId)),
        // SCIENT-FORK:END
        ...(request.skillScope ? { skillScope: copySkillScope(request.skillScope) } : {}),
        issuedAt,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          // Keep the provider-facing manifest independent from the
          // authorization record. `ReadonlySet` is compile-time only; sharing
          // one mutable Set would let an adapter accidentally widen its token.
          capabilities: new Set(scope.capabilities),
          // SCIENT-FORK:START Scient Extensions connectors
          connectors,
          // SCIENT-FORK:END
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      // SCIENT-FORK:START — expiry is a credential exit, not just a failed lookup.
      let expired: string | undefined;
      const resolved = yield* SynchronizedRef.modify(state, ({ records }) => {
        const record = records.get(tokenHash);
        if (!record) return [undefined, { records }] as const;
        if (timestamp - record.lastAliveAt > livenessWindowMs) {
          expired = record.scope.thread.providerSessionId;
          // Preserve touch-based revival of the authority record; only its cached
          // secret material is discarded when the bearer is currently expired.
          return [undefined, { records }] as const;
        }
        // SCIENT-FORK:END
        const next = new Map(records);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [
          {
            ...record.scope,
            capabilities: new Set(record.scope.capabilities),
            // SCIENT-FORK:START Scient Extensions connectors
            connectorIds: new Set(record.scope.connectorIds),
            // SCIENT-FORK:END
            ...(record.scope.skillScope
              ? {
                  skillScope: {
                    ...copySkillScope(record.scope.skillScope),
                  },
                }
              : {}),
          },
          { records: next },
        ] as const;
      });
      // SCIENT-FORK:START — release session-scoped key material before returning an expired lookup.
      if (expired) yield* notifyRevoked([expired], "expired");
      return resolved;
      // SCIENT-FORK:END
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const replaceSkillScope: McpSessionRegistryShape["replaceSkillScope"] = Effect.fn(
    "McpSessionRegistry.replaceSkillScope",
  )(function* (threadId, skillScope) {
    yield* SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      for (const [tokenHash, record] of records) {
        if (
          record.scope.thread.threadId !== threadId ||
          !record.scope.capabilities.has("skills:read")
        ) {
          continue;
        }
        next.set(tokenHash, {
          ...record,
          scope: {
            ...record.scope,
            skillScope: {
              ...copySkillScope(skillScope),
            },
          },
        });
      }
      return { records: next };
    });
  });

  // SCIENT-FORK:START — revocation observers cover exact-token, thread and global release.
  const revokeWhere = Effect.fn("McpSessionRegistry.revokeWhere")(function* (
    predicate: (record: CredentialRecord) => boolean,
  ) {
    const removed = yield* SynchronizedRef.modify(state, ({ records }) => {
      const next = new Map(records);
      const ids: string[] = [];
      for (const [token, record] of records)
        if (predicate(record)) {
          ids.push(record.scope.thread.providerSessionId);
          next.delete(token);
        }
      return [ids, { records: next }] as const;
    });
    yield* notifyRevoked(removed);
  });
  // SCIENT-FORK:END

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    replaceSkillScope,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    // SCIENT-FORK:START — release cached keys before global revoke completes.
    revokeAll: revokeWhere(() => true),
    onRevoke: Effect.fn("McpSessionRegistry.onRevoke")((handler) =>
      Effect.acquireRelease(
        Effect.sync(() => revocationHandlers.add(handler)),
        () =>
          Effect.sync(() => {
            revocationHandlers.delete(handler);
          }),
      ).pipe(Effect.asVoid),
    ),
    // SCIENT-FORK:END
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const replaceActiveMcpSkillScope = (
  threadId: ThreadId,
  skillScope: McpInvocationContext.McpScientSkillScope,
): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.replaceSkillScope(threadId, skillScope)
    : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
