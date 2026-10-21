/**
 * Connected services: the owner of connector records, credentials, sign-in,
 * live grants and the credential-swapping forward used by the proxy route.
 * See docs/internals/scient-extensions.md "Connected services".
 *
 * Lifecycle fencing: each connector has one lifecycle lock that serializes
 * refresh, sign-in commit and disconnect, and a lifetime signal that a
 * disconnect aborts. Disconnect tombstones the connector before anything
 * else, so work that was already in flight can never send, persist or keep a
 * grant afterwards; grants such work obtained anyway are revoked.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type ConnectorAddResult,
  type ConnectorAuthSummary,
  ConnectorId,
  type ConnectorSummary,
  type ConnectorTestResult,
  type ExtensionDeliverySkipReason,
  type ExtensionsChangedEvent,
  ExtensionsError,
  type GrantScope,
  isReservedConnectorServerName,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import {
  ConnectorRuntime,
  type ConnectorForwardRequest,
  type ConnectorForwardResponse,
  type ConnectorRuntimeShape,
  type EligibleConnector,
} from "../ExtensionsServices.ts";
import { PluginConnectorEligibility } from "../plugins/PluginConnectorEligibility.ts";
import { ConnectorCredentialStore } from "./ConnectorCredentialStore.ts";
import {
  applySignIn,
  ConnectorOAuthError,
  ConnectorOAuthFlows,
  type ConnectorOAuthMaterial,
  type ConnectorOAuthSession,
  decodeOAuthMaterial,
  emptyOAuthMaterial,
  encodeOAuthMaterial,
  isGrantLost,
  normalizeCallbackOrigin,
  refreshConnectorSession,
  revokeConnectorSession,
} from "./ConnectorOAuth.ts";
import {
  checkConnectorUrl,
  type ConnectorEgressPolicy,
  ConnectorEgressRejected,
  CONNECTOR_CONTROL_TIMEOUT_MS,
  CONNECTOR_CONTROL_MAX_RESPONSE_BYTES,
  controlFetch,
  describeEgressFailure,
  egressPolicyFor,
  makeConnectorFetch,
  proxyFetch,
  STRICT_EGRESS_POLICY,
} from "./ConnectorOutbound.ts";
import { probeConnector } from "./ConnectorProbe.ts";
import {
  agentRequestIds,
  requestIdToken,
  credentialSet,
  type RedactionContext,
  isProtectableCredential,
  MIN_CREDENTIAL_LENGTH,
  redactEventStream,
  redactJsonStream,
  redactString,
} from "./ConnectorRedaction.ts";
import { ConnectorSessionBindings } from "./ConnectorSessionBindings.ts";
import { curatedServerForUrl } from "../discover/curatedCatalog.ts";
import {
  type ConnectorAuthRecord,
  type ConnectorRecord,
  type ConnectorStateData,
  makeConnectorStateStore,
} from "./ConnectorStateStore.ts";

const MAX_CONNECTORS = 30;
/** Refresh this long before the access token expires. */
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
/**
 * Upstream exchanges per connector, held until the response body completes or
 * is cancelled (open SSE streams included). A full connector answers busy
 * instead of queueing.
 */
export const MAX_IN_FLIGHT_PER_CONNECTOR = 32;
const MAX_SERVER_NAME_BASE = 44;
/** JSON-RPC server-error code for a connector the agent can no longer use. */
const CONNECTOR_UNAVAILABLE_CODE = -32001;
const FORBIDDEN_CREDENTIAL_HEADERS: Readonly<Record<string, true>> = {
  host: true,
  "content-length": true,
  "content-type": true,
  accept: true,
  "mcp-session-id": true,
  "mcp-protocol-version": true,
  "last-event-id": true,
  cookie: true,
  connection: true,
  "transfer-encoding": true,
};

export interface ConnectorRuntimeOptions {
  readonly stateDir: string;
}

type Credential =
  | {
      readonly type: "ok";
      readonly headers: Readonly<Record<string, string>>;
      readonly accessToken: string | undefined;
      /** Every credential value applied or held for this request, for redaction. */
      readonly secrets: ReadonlyArray<string | undefined>;
    }
  | { readonly type: "lost"; readonly message: string };

type SendOutcome =
  | {
      readonly type: "response";
      readonly response: Response;
      readonly secrets: ReadonlyArray<string | undefined>;
    }
  | { readonly type: "lost"; readonly message: string }
  | { readonly type: "failed"; readonly message: string };

type RefreshOutcome =
  | { readonly type: "ok"; readonly session: ConnectorOAuthSession }
  | { readonly type: "transient"; readonly session: ConnectorOAuthSession }
  | { readonly type: "lost"; readonly message: string };

class ConnectorUpstreamError extends Data.TaggedError("ConnectorUpstreamError")<{
  readonly cause: unknown;
}> {}

/** Thrown into the MCP SDK client when the credential is lost or the request failed. */
class ConnectorUnavailableError extends Error {
  readonly kind: "lost" | "failed";
  constructor(kind: "lost" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

const policyOf = (record: Pick<ConnectorRecord, "source" | "url">): ConnectorEgressPolicy =>
  egressPolicyFor(record.url, record.source);

/** Availability alone; the grant also requires the connector to be enabled. */
const isAvailableIn = (record: ConnectorRecord, projectId: ProjectId | undefined) =>
  record.availability.type === "all-projects" ||
  (projectId !== undefined && record.availability.projectIds.includes(projectId));

const authSummary = (auth: ConnectorAuthRecord): ConnectorAuthSummary => {
  switch (auth.type) {
    case "none":
      return { type: "none" };
    case "oauth":
      return {
        type: "oauth",
        usesOwnClient: auth.usesOwnClient,
        ...(auth.issuer === undefined ? {} : { issuer: auth.issuer }),
        ...(auth.scopes === undefined ? {} : { scopes: auth.scopes }),
      };
    case "credential":
      return {
        type: "credential",
        strategy: auth.strategy,
        storage: auth.storage,
        ...(auth.headerName === undefined ? {} : { headerName: auth.headerName }),
      };
  }
};

const toSummary = (record: ConnectorRecord): ConnectorSummary => ({
  connectorId: record.connectorId,
  serverName: record.serverName,
  displayName: record.displayName,
  ...(record.description === undefined ? {} : { description: record.description }),
  url: record.url,
  source: record.source,
  auth: authSummary(record.auth),
  status: record.status,
  enabled: record.enabled,
  authRevision: record.authRevision,
  availability: record.availability,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
});

const eligibleOf = (record: ConnectorRecord): EligibleConnector => ({
  connectorId: record.connectorId,
  serverName: record.serverName,
  displayName: record.displayName,
});

/** Unique `[a-z0-9][a-z0-9_-]{0,47}` name; reserved and taken names get `_2`, `_3`, … */
const uniqueServerName = (displayName: string, taken: ReadonlySet<string>): string => {
  const base =
    displayName
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+/, "")
      .slice(0, MAX_SERVER_NAME_BASE)
      .replace(/[-_]+$/, "") || "connector";
  if (!isReservedConnectorServerName(base) && !taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!isReservedConnectorServerName(candidate) && !taken.has(candidate)) return candidate;
  }
};

const credentialHeadersFor = (
  auth: Pick<Extract<ConnectorAuthRecord, { type: "credential" }>, "strategy" | "headerName">,
  value: string,
): Readonly<Record<string, string>> => {
  switch (auth.strategy) {
    case "bearer":
      return { authorization: `Bearer ${value}` };
    case "basic":
      return { authorization: `Basic ${Buffer.from(value).toString("base64")}` };
    case "header":
      return { [(auth.headerName ?? "authorization").toLowerCase()]: value };
  }
};

/**
 * The independently secret parts of an entered credential: the value, and for
 * Basic the password half of `user:password` (the user name is not a secret).
 */
const enteredSecrets = (strategy: string, value: string): ReadonlyArray<string> => {
  const separator = value.indexOf(":");
  return strategy === "basic" ? [value, separator >= 0 ? value.slice(separator + 1) : ""] : [value];
};

/** Every secret a session applies or holds is long enough to be told apart from text. */
const sessionProtectable = (session: ConnectorOAuthSession): boolean =>
  sessionSecrets(session).every(
    (secret) => secret === undefined || isProtectableCredential(secret),
  );

const UNPROTECTABLE_GRANT =
  "The service issued a credential shorter than Scient can keep out of agent output (16 characters), so Scient will not use it.";

const clientSecretOf = (client: Readonly<Record<string, unknown>> | undefined) =>
  typeof client?.client_secret === "string" ? client.client_secret : undefined;

/** Every secret an OAuth material holds: tokens and client secrets. */
const oauthSecrets = (material: ConnectorOAuthMaterial | undefined): Array<string | undefined> => [
  material?.session?.accessToken,
  material?.session?.refreshToken,
  clientSecretOf(material?.session?.client),
  material?.ownClient?.clientSecret,
  ...(material?.registrations ?? []).map((entry) => clientSecretOf(entry.client)),
];

const sessionSecrets = (session: ConnectorOAuthSession | undefined) => [
  session?.accessToken,
  session?.refreshToken,
  clientSecretOf(session?.client),
];

const extensionsError = (reason: ExtensionsError["reason"], message: string) =>
  new ExtensionsError({ reason, message });

const lostGrantMessage = (record: Pick<ConnectorRecord, "displayName">) =>
  `${record.displayName} is no longer connected in Scient. Ask the user to reconnect it in Scient Settings → Extensions, then retry.`;

/** The method and tool name of a buffered request body, for the credential-use audit. */
const parseRpcRequest = (
  body: Uint8Array | undefined,
): {
  readonly method?: string;
  readonly toolName?: string;
} => {
  if (body === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const method =
    "method" in parsed && typeof parsed.method === "string" ? parsed.method : undefined;
  const params = "params" in parsed ? parsed.params : undefined;
  const toolName =
    typeof params === "object" &&
    params !== null &&
    "name" in params &&
    typeof params.name === "string"
      ? params.name
      : undefined;
  return {
    ...(method === undefined ? {} : { method }),
    ...(toolName === undefined ? {} : { toolName }),
  };
};

/**
 * A Scient JSON-RPC error answering the agent's request. The id is the agent's
 * own token text (`requestIdToken`), never a re-serialized number.
 */
const errorMessageFor = (body: Uint8Array | undefined, message: string): string =>
  `{"jsonrpc":"2.0","id":${
    body === undefined ? "null" : requestIdToken(new TextDecoder().decode(body))
  },"error":${JSON.stringify({ code: CONNECTOR_UNAVAILABLE_CODE, message })}}`;

const jsonBody = (value: unknown) => Stream.make(new TextEncoder().encode(JSON.stringify(value)));

/**
 * A server-owned refusal. Agents must never see HTTP 401 from a connector
 * endpoint (it would start an OAuth flow against Scient), so POST gets a
 * JSON-RPC error and GET/DELETE get `status` with a JSON body.
 */
const refusal = (
  request: Pick<ConnectorForwardRequest, "method" | "body">,
  message: string,
  status: number,
  error: string,
): ConnectorForwardResponse =>
  request.method === "POST"
    ? {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Stream.make(new TextEncoder().encode(errorMessageFor(request.body, message))),
      }
    : {
        status,
        headers: { "content-type": "application/json" },
        body: jsonBody({ error, message }),
      };

export const connectorUnavailableResponse = (
  request: Pick<ConnectorForwardRequest, "method" | "body">,
  message: string,
): ConnectorForwardResponse => refusal(request, message, 403, "connector_unavailable");

const sessionNotFound: ConnectorForwardResponse = {
  status: 404,
  headers: { "content-type": "application/json" },
  body: jsonBody({
    error: "session_not_found",
    message: "This MCP session does not exist for this agent session. Initialize a new one.",
  }),
};

const cancelBody = (response: Response) =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/** The only protocol versions passed back to the agent; anything else is dropped. */
const KNOWN_PROTOCOL_VERSIONS: Readonly<Record<string, true>> = {
  "2024-11-05": true,
  "2025-03-26": true,
  "2025-06-18": true,
  "2025-11-25": true,
};

export const makeConnectorRuntime = Effect.fn("ConnectorRuntime.make")(function* (
  options: ConnectorRuntimeOptions,
) {
  const credentials = yield* ConnectorCredentialStore;
  const eligibility = yield* PluginConnectorEligibility;
  const projects = yield* ProjectStoreV2;
  const store = yield* makeConnectorStateStore(options.stateDir);
  const clock = yield* Clock.Clock;
  const crypto = yield* Crypto.Crypto;
  const now = () => clock.currentTimeMillisUnsafe();
  const isoNow = Effect.map(DateTime.now, DateTime.formatIso);
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.unbounded<ExtensionsChangedEvent>();
  const flows = new ConnectorOAuthFlows(now);
  const sessions = new ConnectorSessionBindings();
  /** Latest OAuth material of the current grant, including rotated tokens that could not be persisted. */
  const oauthCache = new Map<
    string,
    { readonly material: ConnectorOAuthMaterial; readonly version: number }
  >();
  /**
   * Bumped on every cache publication (sign-in commit, refresh, drop). A read
   * from the credential store fills the cache only if no publication happened
   * while it was in flight, so a stale read never restores an older grant.
   */
  const cacheEpochs = new Map<string, number>();
  const publishOAuth = (
    connectorId: string,
    entry: { readonly material: ConnectorOAuthMaterial; readonly version: number } | undefined,
  ) => {
    cacheEpochs.set(connectorId, (cacheEpochs.get(connectorId) ?? 0) + 1);
    if (entry === undefined) oauthCache.delete(connectorId);
    else oauthCache.set(connectorId, entry);
  };
  /** Connectors whose disconnect has begun; ids are random and never reused. */
  const removed = new Set<string>();
  const lifetimes = new Map<string, AbortController>();
  const lifecycleLocks = new Map<string, Semaphore.Semaphore>();
  const inFlight = new Map<string, Semaphore.Semaphore>();
  const semaphoreFor = (map: Map<string, Semaphore.Semaphore>, id: string, permits: number) => {
    const existing = map.get(id);
    if (existing) return existing;
    const created = Semaphore.makeUnsafe(permits);
    map.set(id, created);
    return created;
  };
  const lifecycle = (connectorId: string) => semaphoreFor(lifecycleLocks, connectorId, 1);
  const lifetimeOf = (connectorId: string): AbortSignal => {
    let controller = lifetimes.get(connectorId);
    if (controller === undefined) {
      controller = new AbortController();
      lifetimes.set(connectorId, controller);
    }
    return controller.signal;
  };
  const isLive = (connectorId: string) => !removed.has(connectorId);
  /** A plugin's connector is usable only while an enabled, verified plugin owns it. */
  const isPluginEligible = (record: ConnectorRecord) =>
    eligibility.isEligible({
      connectorId: record.connectorId,
      pluginId: record.source.type === "plugin" ? record.source.pluginId : undefined,
    });

  /** Best-effort revocation outside the connector's lifetime (it may already be aborted). */
  const revokeLater = (record: ConnectorRecord, session: ConnectorOAuthSession) =>
    Effect.promise(() => revokeConnectorSession(session, controlFetch(policyOf(record)))).pipe(
      Effect.forkDetach,
      Effect.asVoid,
    );

  const publishChange = Ref.updateAndGet(revision, (value) => value + 1).pipe(
    Effect.flatMap((next) => PubSub.publish(changes, { revision: next })),
    Effect.asVoid,
  );

  const findRecord = (connectorId: string) =>
    Effect.map(store.read, (state) =>
      state.connectors.find((record) => record.connectorId === connectorId),
    );

  const requireRecord = (connectorId: string) =>
    findRecord(connectorId).pipe(
      Effect.filterOrFail(
        (record): record is ConnectorRecord => record !== undefined,
        () => extensionsError("not-found", "That connected service no longer exists."),
      ),
    );

  /**
   * Applies a change to one record and publishes it. A change that returns the
   * record it was given leaves the state (and the change feed) untouched.
   */
  const updateRecord = (
    connectorId: string,
    change: (record: ConnectorRecord, updatedAt: string) => ConnectorRecord,
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* isoNow;
      const changed = yield* store.update((current) => {
        const index = current.connectors.findIndex((record) => record.connectorId === connectorId);
        if (index === -1 || !isLive(connectorId)) {
          return Effect.fail(
            extensionsError("not-found", "That connected service no longer exists."),
          );
        }
        const previous = current.connectors[index]!;
        const next = change(previous, updatedAt);
        if (next === previous) return Effect.succeed([false, current] as const);
        const connectors = [...current.connectors];
        connectors[index] = next;
        return Effect.succeed([true, { ...current, connectors }] as const);
      });
      if (changed) yield* publishChange;
    });

  /** Deduplicated (first occurrence kept); every project must exist and not be deleted. */
  const checkAvailability = Effect.fn("ConnectorRuntime.checkAvailability")(function* (
    availability: GrantScope,
  ) {
    if (availability.type === "all-projects") return availability;
    const projectIds = [...new Set(availability.projectIds)];
    if (projectIds.length === 0) return { type: "projects", projectIds } satisfies GrantScope;
    const rows = yield* projects
      .list({ projectIds })
      .pipe(
        Effect.mapError(() =>
          extensionsError("state-unavailable", "Projects could not be read. Try again."),
        ),
      );
    const unknown = projectIds.filter((id) => !rows.some((row) => row.projectId === id));
    if (unknown.length > 0) {
      return yield* extensionsError(
        "not-found",
        `${unknown.length === 1 ? "A selected project does not exist" : "Some selected projects do not exist"}: ${unknown.join(", ")}.`,
      );
    }
    return { type: "projects", projectIds } satisfies GrantScope;
  });

  /**
   * Status changes discovered while using a credential never fail the request.
   * They belong to the credential generation of `record` (the snapshot the
   * failing operation used): once a newer generation owns the connector (a
   * sign-in committed meanwhile), a late failure of the old one is dropped.
   * Losing the credential (a move out of `connected` or between needs-*
   * states) starts a new auth revision; repeating the current status does not.
   */
  const markStatus = (
    record: ConnectorRecord,
    status: ConnectorRecord["status"],
    lastError: string,
  ) =>
    isLive(record.connectorId)
      ? updateRecord(record.connectorId, (current, updatedAt) =>
          current.authRevision !== record.authRevision
            ? current
            : {
                ...current,
                status,
                lastError,
                ...(status !== current.status && status !== "connected"
                  ? { authRevision: current.authRevision + 1 }
                  : {}),
                updatedAt,
              },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("connector status could not be saved", {
              connectorId: record.connectorId,
              reason: error.reason,
            }),
          ),
        )
      : Effect.void;

  /**
   * An OAuth grant was refused outside the lifecycle lock. Under the lock (so
   * no sign-in can commit in between), the loss is published only if that
   * grant still owns the connector.
   */
  const markGrantLost = (connectorId: string, grantId: string, lastError: string) =>
    lifecycle(connectorId).withPermits(1)(
      Effect.gen(function* () {
        const current = yield* findRecord(connectorId);
        if (current === undefined) return;
        const entry = yield* loadOAuth(current).pipe(Effect.orElseSucceed(() => undefined));
        if (entry?.material.session?.grantId !== grantId) return;
        yield* markStatus(current, "needs-auth", lastError);
      }),
    );

  const readStoredOAuth = (record: ConnectorRecord) =>
    Effect.gen(function* () {
      if (record.auth.type !== "oauth" || record.auth.credentialRef === undefined) {
        return undefined;
      }
      const stored = yield* credentials.readOwned(record.auth.credentialRef, {
        type: "connector",
        connectorId: record.connectorId,
      });
      if (Option.isNone(stored)) return undefined;
      const material = decodeOAuthMaterial(stored.value.material);
      return material === undefined ? undefined : { material, version: stored.value.version };
    });

  const loadOAuth = Effect.fn("ConnectorRuntime.loadOAuth")(function* (record: ConnectorRecord) {
    const cached = oauthCache.get(record.connectorId);
    if (cached) return cached;
    const epoch = cacheEpochs.get(record.connectorId) ?? 0;
    const entry = yield* readStoredOAuth(record);
    // A sign-in, refresh or drop published while this read was in flight wins.
    if ((cacheEpochs.get(record.connectorId) ?? 0) !== epoch) {
      return oauthCache.get(record.connectorId);
    }
    if (entry !== undefined && isLive(record.connectorId)) {
      oauthCache.set(record.connectorId, entry);
    }
    return entry;
  });

  /**
   * Persists a refreshed session of the grant that was read (compare-and-swap
   * on the version read). A conflict is resolved by re-reading: the same grant
   * takes the newer rotation; a different grant wins and ours is revoked.
   * A failed save keeps the rotation in memory for this grant only.
   */
  const commitRefresh = Effect.fn("ConnectorRuntime.commitRefresh")(function* (
    record: ConnectorRecord,
    entry: { readonly material: ConnectorOAuthMaterial; readonly version: number },
    refreshed: ConnectorOAuthSession,
  ) {
    if (record.auth.type !== "oauth" || record.auth.credentialRef === undefined) {
      return { type: "ok", session: refreshed } satisfies RefreshOutcome;
    }
    const ref = record.auth.credentialRef;
    const material = { ...entry.material, session: refreshed };
    publishOAuth(record.connectorId, { material, version: entry.version });
    const saved = yield* credentials
      .replace(ref, encodeOAuthMaterial(material), entry.version)
      .pipe(Effect.exit);
    if (Exit.isSuccess(saved)) {
      publishOAuth(record.connectorId, { material, version: saved.value });
      return { type: "ok", session: refreshed } satisfies RefreshOutcome;
    }
    const failure = Option.getOrUndefined(Exit.findErrorOption(saved));
    if (failure?._tag !== "SecretVersionConflict") {
      yield* Effect.logWarning("connector credential could not be saved; keeping it in memory", {
        connectorId: record.connectorId,
      });
      return { type: "ok", session: refreshed } satisfies RefreshOutcome;
    }
    const stored = yield* readStoredOAuth(record).pipe(Effect.orElseSucceed(() => undefined));
    if (stored?.material.session?.grantId === refreshed.grantId) {
      const merged = { ...stored.material, session: refreshed };
      const retried = yield* credentials
        .replace(ref, encodeOAuthMaterial(merged), stored.version)
        .pipe(Effect.exit);
      publishOAuth(record.connectorId, {
        material: merged,
        version: Exit.isSuccess(retried) ? retried.value : stored.version,
      });
      return { type: "ok", session: refreshed } satisfies RefreshOutcome;
    }
    // Another grant was stored meanwhile: it wins, and the tokens we just obtained go.
    yield* revokeLater(record, refreshed);
    if (stored === undefined || stored.material.session === undefined) {
      publishOAuth(record.connectorId, undefined);
      return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
    }
    publishOAuth(record.connectorId, stored);
    return { type: "ok", session: stored.material.session } satisfies RefreshOutcome;
  });

  const sessionNeedsRefresh = (session: ConnectorOAuthSession, at: number) =>
    session.expiresAt !== undefined && session.expiresAt - TOKEN_REFRESH_LEEWAY_MS <= at;

  /**
   * Single-flight per connector under the lifecycle lock: callers holding the
   * same stale token queue; the first refreshes, the rest see the new token.
   */
  const refreshSession = (record: ConnectorRecord, staleAccessToken: string | undefined) =>
    lifecycle(record.connectorId).withPermits(1)(
      Effect.gen(function* () {
        if (!isLive(record.connectorId)) {
          return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
        }
        const entry = yield* loadOAuth(record).pipe(Effect.orElseSucceed(() => undefined));
        const session = entry?.material.session;
        if (entry === undefined || session === undefined) {
          return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
        }
        if (session.accessToken !== staleAccessToken) {
          return { type: "ok", session } satisfies RefreshOutcome;
        }
        const refreshed = yield* Effect.tryPromise({
          try: () =>
            refreshConnectorSession(
              session,
              controlFetch(policyOf(record), lifetimeOf(record.connectorId)),
              now(),
            ),
          catch: (cause) => new ConnectorUpstreamError({ cause }),
        }).pipe(Effect.exit);
        if (!isLive(record.connectorId)) {
          if (Exit.isSuccess(refreshed)) yield* revokeLater(record, refreshed.value);
          return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
        }
        if (Exit.isSuccess(refreshed) && !sessionProtectable(refreshed.value)) {
          yield* revokeLater(record, refreshed.value);
          const { session: _dropped, ...withoutSession } = entry.material;
          publishOAuth(record.connectorId, { material: withoutSession, version: entry.version });
          yield* markStatus(record, "needs-auth", UNPROTECTABLE_GRANT);
          return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
        }
        if (Exit.isSuccess(refreshed)) return yield* commitRefresh(record, entry, refreshed.value);
        const failure = Option.getOrUndefined(Exit.findErrorOption(refreshed))?.cause;
        if (isGrantLost(failure)) {
          const { session: _dropped, ...withoutSession } = entry.material;
          publishOAuth(record.connectorId, { material: withoutSession, version: entry.version });
          if (record.auth.type === "oauth" && record.auth.credentialRef !== undefined) {
            yield* credentials
              .replace(
                record.auth.credentialRef,
                encodeOAuthMaterial(withoutSession),
                entry.version,
              )
              .pipe(
                Effect.flatMap((version) =>
                  Effect.sync(() =>
                    publishOAuth(record.connectorId, { material: withoutSession, version }),
                  ),
                ),
                Effect.ignore,
              );
          }
          yield* markStatus(
            record,
            "needs-auth",
            "The sign-in expired or was revoked. Sign in again to reconnect.",
          );
          return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
        }
        yield* Effect.logWarning("connector token refresh failed; keeping the connection", {
          connectorId: record.connectorId,
        });
        return { type: "transient", session } satisfies RefreshOutcome;
      }),
    );

  const credentialFor = Effect.fn("ConnectorRuntime.credentialFor")(function* (
    record: ConnectorRecord,
  ) {
    if (!isLive(record.connectorId)) {
      return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
    }
    const auth = record.auth;
    switch (auth.type) {
      case "none":
        return {
          type: "ok",
          headers: {},
          accessToken: undefined,
          secrets: [],
        } satisfies Credential;
      case "credential": {
        const stored = yield* credentials
          .readOwned(auth.credentialRef, { type: "connector", connectorId: record.connectorId })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(stored)) {
          yield* markStatus(record, "needs-credential", "The stored credential is missing.");
          return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
        }
        const value = new TextDecoder().decode(stored.value.material);
        if (!enteredSecrets(auth.strategy, value).every(isProtectableCredential)) {
          yield* markStatus(
            record,
            "needs-credential",
            `The stored credential is shorter than ${MIN_CREDENTIAL_LENGTH} characters, so Scient will not use it. Remove the service and add it again with a longer key.`,
          );
          return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
        }
        return {
          type: "ok",
          headers: credentialHeadersFor(auth, value),
          accessToken: undefined,
          secrets: enteredSecrets(auth.strategy, value),
        } satisfies Credential;
      }
      case "oauth": {
        const entry = yield* loadOAuth(record).pipe(Effect.orElseSucceed(() => undefined));
        let session = entry?.material.session;
        if (session === undefined) {
          return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
        }
        const held = oauthSecrets(entry?.material);
        if (!held.every((secret) => secret === undefined || isProtectableCredential(secret))) {
          yield* markGrantLost(record.connectorId, session.grantId, UNPROTECTABLE_GRANT);
          return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
        }
        if (
          sessionNeedsRefresh(session, yield* Clock.currentTimeMillis) &&
          session.refreshToken !== undefined
        ) {
          const refreshed = yield* refreshSession(record, session.accessToken);
          if (refreshed.type === "lost") return refreshed satisfies Credential;
          session = refreshed.session;
        }
        return {
          type: "ok",
          headers: { authorization: `Bearer ${session.accessToken}` },
          accessToken: session.accessToken,
          secrets: [...held, ...sessionSecrets(session)],
        } satisfies Credential;
      }
    }
  });

  /**
   * Sends one upstream request with the credential applied. On 401 with OAuth:
   * one forced refresh, then one replay of the same buffered request. Every
   * send is aborted by a disconnect and refused once the connector is gone.
   */
  const sendAuthorized = Effect.fn("ConnectorRuntime.sendAuthorized")(function* (
    record: ConnectorRecord,
    request: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array | string | undefined;
      readonly signal: AbortSignal | undefined;
    },
    fetch: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    const lifetime = lifetimeOf(record.connectorId);
    const signal =
      request.signal === undefined ? lifetime : AbortSignal.any([request.signal, lifetime]);
    const send = (headers: Readonly<Record<string, string>>) =>
      Effect.tryPromise({
        try: () =>
          fetch(record.url, {
            method: request.method,
            headers: { ...request.headers, ...headers },
            ...(request.body === undefined
              ? {}
              : { body: request.body as NonNullable<RequestInit["body"]> }),
            signal,
          }),
        catch: (cause) => new ConnectorUpstreamError({ cause }),
      }).pipe(Effect.exit);
    const gone = { type: "lost", message: lostGrantMessage(record) } satisfies SendOutcome;

    const credential = yield* credentialFor(record);
    if (credential.type === "lost") return credential satisfies SendOutcome;
    if (!isLive(record.connectorId)) return gone;
    const first = yield* send(credential.headers);
    if (Exit.isFailure(first)) {
      if (!isLive(record.connectorId)) return gone;
      return {
        type: "failed",
        message: describeEgressFailure(Option.getOrUndefined(Exit.findErrorOption(first))?.cause),
      } satisfies SendOutcome;
    }
    if (first.value.status !== 401) {
      return {
        type: "response",
        response: first.value,
        secrets: credential.secrets,
      } satisfies SendOutcome;
    }
    yield* cancelBody(first.value);
    if (record.auth.type !== "oauth") {
      yield* markStatus(record, "connected", "The service rejected the stored credential.");
      return {
        type: "failed",
        message: `${record.displayName} rejected the credential stored in Scient. Ask the user to update it in Scient Settings → Extensions.`,
      } satisfies SendOutcome;
    }
    const refreshed = yield* refreshSession(record, credential.accessToken);
    if (refreshed.type === "lost") return refreshed satisfies SendOutcome;
    if (refreshed.type === "transient") {
      return {
        type: "failed",
        message: `${record.displayName} could not refresh its sign-in right now. Retry shortly.`,
      } satisfies SendOutcome;
    }
    if (!isLive(record.connectorId)) return gone;
    const replay = yield* send({ authorization: `Bearer ${refreshed.session.accessToken}` });
    if (Exit.isFailure(replay)) {
      if (!isLive(record.connectorId)) return gone;
      return {
        type: "failed",
        message: describeEgressFailure(Option.getOrUndefined(Exit.findErrorOption(replay))?.cause),
      } satisfies SendOutcome;
    }
    if (replay.value.status === 401) {
      yield* cancelBody(replay.value);
      // Only if the refused grant still owns the connector: a sign-in may have
      // committed while this replay was in flight.
      yield* markGrantLost(
        record.connectorId,
        refreshed.session.grantId,
        "The service no longer accepts this sign-in.",
      );
      return gone;
    }
    return {
      type: "response",
      response: replay.value,
      secrets: [...credential.secrets, ...sessionSecrets(refreshed.session)],
    } satisfies SendOutcome;
  });

  const commitNewRecord = (record: ConnectorRecord) =>
    store.update((current) => {
      if (current.connectors.length >= MAX_CONNECTORS) {
        return Effect.fail(
          extensionsError(
            "limit-reached",
            `Scient supports at most ${MAX_CONNECTORS} connected services.`,
          ),
        );
      }
      const duplicate = current.connectors.find((existing) => existing.url === record.url);
      if (duplicate) {
        return Effect.fail(
          extensionsError(
            "invalid-input",
            `This service is already connected as ${duplicate.displayName}.`,
          ),
        );
      }
      const serverName = uniqueServerName(
        record.serverName,
        new Set(current.connectors.map((existing) => existing.serverName)),
      );
      const created = { ...record, serverName };
      return Effect.succeed([
        created,
        { ...current, connectors: [...current.connectors, created] },
      ] as const);
    });

  const newConnectorId = crypto.randomBytes(12).pipe(
    Effect.map((bytes) => ConnectorId.make(`con_${Buffer.from(bytes).toString("base64url")}`)),
    Effect.orDie,
  );

  const checkUrl = (raw: string, policy: ConnectorEgressPolicy) => {
    const checked = checkConnectorUrl(raw, policy);
    return checked instanceof ConnectorEgressRejected
      ? Effect.fail(extensionsError("invalid-input", checked.message))
      : Effect.succeed(checked.href);
  };

  const probeFailure = (result: {
    readonly type: "not-an-mcp-server" | "unreachable";
    readonly message: string;
  }) => extensionsError(result.type, result.message);

  const tooShort = (what: string) =>
    extensionsError(
      "invalid-input",
      `The ${what} is too short to be a credential (at least ${MIN_CREDENTIAL_LENGTH} characters).`,
    );

  const add: ConnectorRuntimeShape["add"] = Effect.fn("ConnectorRuntime.add")(function* (input) {
    const policy = egressPolicyFor(input.target.url, { type: input.target.type });
    const url = yield* checkUrl(input.target.url, policy);
    if (input.credential?.type === "bound") {
      return yield* extensionsError(
        "unsupported",
        "Using a saved secret requires the Secrets vault, which is not available yet. Enter the credential for this service instead.",
      );
    }
    if (
      input.credential?.type === "entered" &&
      !enteredSecrets(input.credential.strategy, input.credential.value).every(
        isProtectableCredential,
      )
    ) {
      return yield* tooShort(
        input.credential.strategy === "basic" ? "password (after the colon)" : "credential",
      );
    }
    const ownClientSecret = input.oauthClient?.clientSecret;
    if (ownClientSecret !== undefined && !isProtectableCredential(ownClientSecret)) {
      return yield* tooShort("client secret");
    }
    const snapshot = yield* store.read;
    if (snapshot.connectors.length >= MAX_CONNECTORS) {
      return yield* extensionsError(
        "limit-reached",
        `Scient supports at most ${MAX_CONNECTORS} connected services.`,
      );
    }
    // A curated endpoint keeps its curated name and description even when the
    // client added it by URL ("DeepWiki", not "mcp.deepwiki.com").
    const curated = curatedServerForUrl(url);
    const displayName =
      input.displayName ??
      curated?.displayName ??
      (input.target.type === "registry"
        ? (input.target.name.split("/").pop() ?? input.target.name)
        : new URL(url).hostname);
    const description = input.description ?? curated?.description;
    const connectorId = yield* newConnectorId;
    const owner = { type: "connector", connectorId } as const;
    const createdAt = yield* isoNow;
    const fetch = controlFetch(policy);

    let auth: ConnectorAuthRecord;
    let status: ConnectorRecord["status"];
    const entered = input.credential;
    if (entered !== undefined) {
      if (entered.strategy === "header") {
        const headerName = entered.headerName?.toLowerCase();
        if (
          headerName === undefined ||
          !/^[a-z0-9-]{1,64}$/.test(headerName) ||
          FORBIDDEN_CREDENTIAL_HEADERS[headerName] === true
        ) {
          return yield* extensionsError(
            "invalid-input",
            "Enter a valid header name for this credential.",
          );
        }
      }
      const credentialAuth = {
        type: "credential",
        strategy: entered.strategy,
        storage: "owned",
        ...(entered.headerName === undefined ? {} : { headerName: entered.headerName }),
      } as const;
      const probe = yield* Effect.promise(() =>
        probeConnector({
          url,
          fetch,
          headers: credentialHeadersFor(credentialAuth, entered.value),
        }),
      );
      if (probe.type === "auth-required") {
        return yield* extensionsError("sign-in-failed", "The service rejected this credential.");
      }
      if (probe.type !== "open") return yield* probeFailure(probe);
      const credentialRef = yield* credentials.put(
        owner,
        entered.strategy,
        new TextEncoder().encode(entered.value),
        { label: `${displayName} credential` },
      );
      auth = { ...credentialAuth, credentialRef };
      status = "connected";
    } else {
      const probe = yield* Effect.promise(() => probeConnector({ url, fetch }));
      if (probe.type === "open") {
        auth = { type: "none" };
        status = "connected";
      } else if (probe.type === "auth-required") {
        const ownClient = input.oauthClient;
        const credentialRef =
          ownClient === undefined
            ? undefined
            : yield* credentials.put(
                owner,
                "oauth-connection",
                encodeOAuthMaterial({
                  ...emptyOAuthMaterial,
                  ownClient: {
                    clientId: ownClient.clientId,
                    ...(ownClient.clientSecret === undefined
                      ? {}
                      : { clientSecret: ownClient.clientSecret }),
                  },
                }),
                { label: `${displayName} sign-in` },
              );
        auth = {
          type: "oauth",
          usesOwnClient: ownClient !== undefined,
          ...(credentialRef === undefined ? {} : { credentialRef }),
        };
        status = "needs-auth";
      } else {
        return yield* probeFailure(probe);
      }
    }
    const record: ConnectorRecord = {
      connectorId,
      serverName: displayName,
      displayName,
      ...(description === undefined ? {} : { description }),
      url,
      source:
        input.target.type === "registry"
          ? { type: "registry", name: input.target.name, version: input.target.version }
          : { type: "url" },
      auth,
      status,
      enabled: true,
      authRevision: 0,
      availability: { type: "all-projects" },
      createdAt,
      updatedAt: createdAt,
    };
    // Credential first, then the record that refers to it; a failed record
    // commit removes the credential so nothing is left unreferenced.
    const created = yield* commitNewRecord(record).pipe(
      Effect.tapError(() =>
        "credentialRef" in auth && auth.credentialRef !== undefined
          ? credentials.remove(auth.credentialRef).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    yield* publishChange;
    return {
      connector: toSummary(created),
      nextStep: status === "connected" ? "ready" : "sign-in-required",
    } satisfies ConnectorAddResult;
  });

  const removeRecord = Effect.fn("ConnectorRuntime.removeRecord")(function* (
    record: ConnectorRecord,
  ) {
    const connectorId = record.connectorId;
    // Fence first: in-flight refreshes, exchanges and proxied requests are
    // aborted and can no longer send, persist or keep what they obtain.
    removed.add(connectorId);
    lifetimes.get(connectorId)?.abort();
    flows.cancelConnector(connectorId);
    sessions.dropConnector(connectorId);
    const committed = yield* lifecycle(connectorId)
      .withPermits(1)(
        Effect.gen(function* () {
          const oauth =
            oauthCache.get(connectorId) ??
            (yield* readStoredOAuth(record).pipe(Effect.orElseSucceed(() => undefined)));
          // Commit the removal before cleanup: the connector stops being
          // delivered and granted even if credential cleanup or revocation fails.
          yield* store.update((current) =>
            Effect.succeed([
              undefined,
              {
                connectors: current.connectors.filter((entry) => entry.connectorId !== connectorId),
              } satisfies ConnectorStateData,
            ] as const),
          );
          publishOAuth(connectorId, undefined);
          yield* publishChange;
          const ref = record.auth.type === "none" ? undefined : record.auth.credentialRef;
          if (ref !== undefined) {
            yield* credentials
              .remove(ref)
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("connector credential could not be removed", { connectorId }),
                ),
              );
          }
          const session = oauth?.material.session;
          if (session !== undefined) yield* revokeLater(record, session);
        }),
      )
      .pipe(Effect.exit);
    if (Exit.isFailure(committed)) {
      // The record is still there; let it work again.
      removed.delete(connectorId);
      lifetimes.delete(connectorId);
      return yield* committed;
    }
    lifetimes.delete(connectorId);
    lifecycleLocks.delete(connectorId);
    inFlight.delete(connectorId);
  });

  const startSignIn: ConnectorRuntimeShape["startSignIn"] = Effect.fn(
    "ConnectorRuntime.startSignIn",
  )(function* (input) {
    const callbackOrigin = normalizeCallbackOrigin(input.callbackOrigin);
    if (callbackOrigin === undefined) {
      return yield* extensionsError(
        "invalid-input",
        "Sign-in must start from a loopback (http://127.0.0.1, localhost or [::1] with a port) or https Scient address.",
      );
    }
    const record = yield* requireRecord(input.connectorId);
    if (record.auth.type !== "oauth") {
      return yield* extensionsError("invalid-input", `${record.displayName} does not use sign-in.`);
    }
    const fetch = controlFetch(policyOf(record), lifetimeOf(record.connectorId));
    const probe = yield* Effect.promise(() => probeConnector({ url: record.url, fetch }));
    if (probe.type === "open") {
      yield* updateRecord(record.connectorId, (current, updatedAt) => ({
        ...current,
        auth: { type: "none" },
        authRevision: current.authRevision + 1,
        status: "connected",
        lastError: undefined,
        updatedAt,
      }));
      return yield* extensionsError(
        "invalid-input",
        `${record.displayName} does not require sign-in; it is now connected.`,
      );
    }
    if (probe.type !== "auth-required") return yield* probeFailure(probe);
    const entry = yield* loadOAuth(record);
    const started = yield* Effect.tryPromise({
      try: () =>
        flows.start({
          connectorId: record.connectorId,
          serverUrl: record.url,
          callbackOrigin,
          material: entry?.material ?? emptyOAuthMaterial,
          fetch,
          resourceMetadataUrl: probe.resourceMetadataUrl,
          scope: probe.scope,
        }),
      catch: (error) =>
        error instanceof ConnectorOAuthError
          ? extensionsError(error.reason, error.message)
          : extensionsError("sign-in-failed", "Sign-in could not be started."),
    });
    if (!isLive(record.connectorId)) {
      flows.cancelConnector(record.connectorId);
      return yield* extensionsError("not-found", "That connected service no longer exists.");
    }
    return {
      authorizationUrl: started.authorizationUrl,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(started.expiresAt)),
    };
  });

  const signInFailed = (displayName: string | undefined, message: string) => ({
    outcome: "failed" as const,
    displayName,
    message,
  });

  const completeSignIn: ConnectorRuntimeShape["completeSignIn"] = Effect.fn(
    "ConnectorRuntime.completeSignIn",
  )(function* (query) {
    const claimed = query.state === undefined ? undefined : flows.claim(query.state);
    if (claimed === undefined) {
      return signInFailed(
        undefined,
        "This sign-in link is invalid or has expired. Start sign-in again from Scient.",
      );
    }
    const removedMessage = "This connected service was removed before sign-in finished.";
    const record = yield* findRecord(claimed.connectorId);
    if (record === undefined || record.auth.type !== "oauth" || !isLive(record.connectorId)) {
      return signInFailed(undefined, removedMessage);
    }
    const fail = (message: string) =>
      markStatus(record, record.status, message).pipe(
        Effect.as(signInFailed(record.displayName, message)),
      );
    if (query.error !== undefined) {
      const code = query.error.replace(/[^\w.-]/g, "").slice(0, 64);
      return yield* fail(
        code === "access_denied"
          ? "Sign-in was cancelled or denied."
          : `The service could not complete sign-in${code ? ` (${code})` : ""}.`,
      );
    }
    if (query.code === undefined || query.code.length === 0) {
      return yield* fail("The service did not return an authorization code.");
    }
    const code = query.code;
    const exchanged = yield* Effect.tryPromise({
      try: () => flows.complete(claimed, code),
      catch: (error) =>
        error instanceof ConnectorOAuthError ? error.message : "Sign-in could not be completed.",
    }).pipe(Effect.exit);
    if (Exit.isFailure(exchanged)) {
      if (!isLive(record.connectorId)) return signInFailed(undefined, removedMessage);
      return yield* fail(
        Option.getOrElse(Exit.findErrorOption(exchanged), () => "Sign-in could not be completed."),
      );
    }
    const result = exchanged.value;
    if (!sessionProtectable(result.session)) {
      // The service now issues credentials Scient cannot protect: the connector
      // needs a new sign-in whatever its previous status, and the grant is revoked.
      yield* revokeLater(record, result.session);
      yield* markStatus(record, "needs-auth", UNPROTECTABLE_GRANT);
      return signInFailed(record.displayName, UNPROTECTABLE_GRANT);
    }
    // Commit under the lifecycle lock, so a refresh of the previous grant or a
    // disconnect cannot interleave; anything that loses the race is revoked.
    return yield* lifecycle(record.connectorId).withPermits(1)(
      Effect.gen(function* () {
        const current = yield* findRecord(record.connectorId);
        if (current === undefined || current.auth.type !== "oauth" || !isLive(record.connectorId)) {
          yield* revokeLater(record, result.session);
          return signInFailed(undefined, removedMessage);
        }
        const previousRef = current.auth.credentialRef;
        const stored = yield* readStoredOAuth(current).pipe(Effect.orElseSucceed(() => undefined));
        const base =
          oauthCache.get(record.connectorId)?.material ?? stored?.material ?? emptyOAuthMaterial;
        const material = applySignIn(base, result);
        const saved = yield* Effect.gen(function* () {
          if (previousRef !== undefined && stored !== undefined) {
            const version = yield* credentials.replace(
              previousRef,
              encodeOAuthMaterial(material),
              stored.version,
            );
            return { ref: previousRef, version };
          }
          const ref = yield* credentials.put(
            { type: "connector", connectorId: record.connectorId },
            "oauth-connection",
            encodeOAuthMaterial(material),
            { label: `${record.displayName} sign-in` },
          );
          return { ref, version: 1 };
        }).pipe(Effect.exit);
        if (Exit.isFailure(saved)) {
          yield* revokeLater(record, result.session);
          return yield* fail("The sign-in could not be saved.");
        }
        const session = result.session;
        const scopes = session.scope?.split(/\s+/).filter((scope) => scope.length > 0);
        const updated = yield* updateRecord(record.connectorId, (latest, updatedAt) => ({
          ...latest,
          auth: {
            type: "oauth",
            credentialRef: saved.value.ref,
            usesOwnClient: material.ownClient !== undefined,
            issuer: session.issuer,
            ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
          },
          // Every sign-in is a new credential generation, even for the same
          // issuer and scopes (it may be another account).
          authRevision: latest.authRevision + 1,
          status: "connected",
          lastError: undefined,
          updatedAt,
        })).pipe(Effect.exit);
        if (Exit.isFailure(updated)) {
          yield* revokeLater(record, session);
          // Only a credential created by this sign-in is discarded; an existing one keeps its client.
          if (saved.value.ref !== previousRef) {
            yield* credentials.remove(saved.value.ref).pipe(Effect.ignore);
          }
          return signInFailed(record.displayName, "The sign-in could not be saved.");
        }
        if (previousRef !== undefined && previousRef !== saved.value.ref) {
          // The previous entry could not be read, so a new one replaced it.
          yield* credentials.remove(previousRef).pipe(Effect.ignore);
        }
        publishOAuth(record.connectorId, { material, version: saved.value.version });
        return {
          outcome: "connected" as const,
          displayName: record.displayName,
          message: `${record.displayName} is connected. You can close this tab and return to Scient.`,
        };
      }),
    );
  });

  const test: ConnectorRuntimeShape["test"] = Effect.fn("ConnectorRuntime.test")(function* (input) {
    const record = yield* requireRecord(input.connectorId);
    const checkedAt = yield* isoNow;
    const result = (
      outcome: ConnectorTestResult["outcome"],
      message?: string,
    ): ConnectorTestResult => ({
      connectorId: record.connectorId,
      outcome,
      checkedAt,
      tools: [],
      ...(message === undefined ? {} : { message }),
    });
    if (record.status === "needs-auth") return result("needs-auth", "Sign in to use this service.");
    const fetch = makeConnectorFetch({
      policy: policyOf(record),
      redirect: "error",
      timeoutMs: CONNECTOR_CONTROL_TIMEOUT_MS,
      maxResponseBytes: CONNECTOR_CONTROL_MAX_RESPONSE_BYTES * 8,
    });
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const applied: Array<string | undefined> = [];
    const authorizedFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const outcome = await run(
        sendAuthorized(
          record,
          {
            method: init?.method ?? "GET",
            headers,
            body: init?.body as string | undefined,
            signal: init?.signal ?? undefined,
          },
          (_url, requestInit) => fetch(url, requestInit),
        ),
      );
      if (outcome.type === "response") {
        applied.push(...outcome.secrets);
        return outcome.response;
      }
      throw new ConnectorUnavailableError(outcome.type, outcome.message);
    };
    const listed = yield* Effect.tryPromise({
      try: async () => {
        const transport = new StreamableHTTPClientTransport(new URL(record.url), {
          fetch: authorizedFetch,
        });
        const client = new Client({ name: "Scient", version: "1" });
        try {
          // exactOptionalPropertyTypes rejects the SDK's own transport class against its interface.
          await client.connect(transport as unknown as Transport);
          const tools = await client.listTools();
          return {
            serverName: client.getServerVersion()?.name,
            serverVersion: client.getServerVersion()?.version,
            tools: tools.tools,
          };
        } finally {
          await transport.terminateSession().catch(() => undefined);
          await client.close().catch(() => undefined);
        }
      },
      catch: (cause) => new ConnectorUpstreamError({ cause }),
    }).pipe(Effect.exit);
    if (Exit.isFailure(listed)) {
      const error = Option.getOrUndefined(Exit.findErrorOption(listed))?.cause;
      if (error instanceof ConnectorUnavailableError) {
        return error.kind === "lost"
          ? result("needs-auth", "Sign in again to use this service.")
          : result("unreachable", error.message);
      }
      if (error instanceof ConnectorEgressRejected || error instanceof TypeError) {
        return result("unreachable", describeEgressFailure(error));
      }
      return result("error", "The service did not complete the MCP handshake and tool listing.");
    }
    if (record.lastError !== undefined) {
      yield* updateRecord(record.connectorId, (current, updatedAt) => ({
        ...current,
        lastError: undefined,
        updatedAt,
      })).pipe(Effect.ignore);
    }
    // Server-provided text reaches the settings UI; a reflected credential must not.
    const credentials = credentialSet(applied);
    const clean = (text: string | undefined) => {
      const trimmed = text === undefined ? "" : redactString(text, credentials).trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const serverName = clean(listed.value.serverName);
    const serverVersion = clean(listed.value.serverVersion);
    return {
      ...result("ok"),
      ...(serverName === undefined ? {} : { serverName }),
      ...(serverVersion === undefined ? {} : { serverVersion }),
      tools: listed.value.tools.flatMap((tool) => {
        const name = clean(tool.name);
        if (name === undefined) return [];
        const title = clean(tool.title);
        return [
          {
            name,
            ...(title === undefined ? {} : { title }),
            ...(tool.description === undefined
              ? {}
              : { description: redactString(tool.description, credentials) }),
            ...(tool.annotations?.readOnlyHint === undefined
              ? {}
              : { readOnly: tool.annotations.readOnlyHint }),
            ...(tool.annotations?.destructiveHint === undefined
              ? {}
              : { destructive: tool.annotations.destructiveHint }),
          },
        ];
      }),
    };
  });

  const forward: ConnectorRuntimeShape["forward"] = Effect.fn("ConnectorRuntime.forward")(
    function* (request) {
      const state = yield* store.read;
      const record = state.connectors.find((entry) => entry.connectorId === request.connectorId);
      const rpc = request.method === "POST" ? parseRpcRequest(request.body) : {};
      const correlationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const recordToolUse = (decision: "allowed" | "denied", outcome?: "ok" | "error") =>
        record !== undefined && rpc.method === "tools/call" && rpc.toolName !== undefined
          ? credentials.recordUse({
              scope: request.scope,
              target: `${record.serverName}/${rpc.toolName}`,
              decision,
              ...(outcome === undefined ? {} : { outcome }),
              correlationId,
            })
          : Effect.void;
      if (
        record === undefined ||
        !isLive(record.connectorId) ||
        !record.enabled ||
        record.status !== "connected" ||
        !(yield* isPluginEligible(record))
      ) {
        yield* recordToolUse("denied");
        return connectorUnavailableResponse(
          request,
          record === undefined
            ? "This connected service was removed in Scient."
            : lostGrantMessage(record),
        );
      }
      const providerSessionId = request.scope.thread?.providerSessionId;
      if (providerSessionId === undefined) {
        return connectorUnavailableResponse(request, lostGrantMessage(record));
      }

      // The agent only ever holds proxy-owned session ids bound to its own session.
      const { "mcp-session-id": proxySessionId, ...forwarded } = request.headers;
      let upstreamSessionId: string | undefined;
      if (proxySessionId !== undefined) {
        upstreamSessionId = sessions.resolve(proxySessionId, record.connectorId, providerSessionId);
        if (upstreamSessionId === undefined) return sessionNotFound;
      }

      const permits = semaphoreFor(inFlight, record.connectorId, MAX_IN_FLIGHT_PER_CONNECTOR);
      if (!(yield* Semaphore.takeIfAvailable(permits, 1))) {
        return refusal(
          request,
          `${record.displayName} has too many requests in progress. Retry shortly.`,
          503,
          "connector_busy",
        );
      }
      const exchange = new AbortController();
      let released = false;
      const release = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        exchange.abort();
        return Semaphore.release(permits, 1).pipe(Effect.asVoid);
      });

      const outcome = yield* sendAuthorized(
        record,
        {
          method: request.method,
          headers:
            upstreamSessionId === undefined
              ? forwarded
              : { ...forwarded, "mcp-session-id": upstreamSessionId },
          body: request.body,
          signal: exchange.signal,
        },
        proxyFetch(policyOf(record)),
      ).pipe(Effect.onInterrupt(() => release));
      if (outcome.type !== "response") {
        yield* release;
        yield* recordToolUse(outcome.type === "lost" ? "denied" : "allowed", "error");
        return connectorUnavailableResponse(request, outcome.message);
      }
      const response = outcome.response;
      yield* recordToolUse("allowed", response.ok ? "ok" : "error");
      const settle = (result: ConnectorForwardResponse) =>
        cancelBody(response).pipe(Effect.andThen(release), Effect.as(result));

      if (response.status === 404 && proxySessionId !== undefined) {
        sessions.drop(proxySessionId);
        return yield* settle(sessionNotFound);
      }
      if (request.method === "DELETE" && response.ok && proxySessionId !== undefined) {
        sessions.drop(proxySessionId);
      }
      if (
        response.status === 202 ||
        response.status === 204 ||
        (response.status === 405 && request.method === "GET") ||
        (request.method === "DELETE" && response.ok)
      ) {
        return yield* settle({ status: response.status, headers: {}, body: Stream.empty });
      }
      // Only MCP results pass through. Every other upstream answer is replaced
      // by a server-owned message, so no vendor error text reaches the agent.
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const streamed = contentType.includes("text/event-stream");
      if (!response.ok || !(streamed || contentType.includes("application/json"))) {
        return yield* settle(
          refusal(
            request,
            response.ok
              ? `${record.displayName} did not answer like an MCP server.`
              : `${record.displayName} answered with HTTP ${response.status}.`,
            502,
            "connector_error",
          ),
        );
      }
      const headers: Record<string, string> = {
        "content-type": streamed ? "text/event-stream" : "application/json",
      };
      const protocolVersion = response.headers.get("mcp-protocol-version");
      if (protocolVersion !== null && KNOWN_PROTOCOL_VERSIONS[protocolVersion] === true) {
        headers["mcp-protocol-version"] = protocolVersion;
      }
      const issuedSessionId = response.headers.get("mcp-session-id");
      if (issuedSessionId !== null) {
        headers["mcp-session-id"] = sessions.bind(
          record.connectorId,
          providerSessionId,
          issuedSessionId,
        );
      }
      const body = response.body;
      // Ids the agent itself sent may be echoed back unchanged even if tainted.
      const redaction: RedactionContext = {
        credentials: credentialSet(outcome.secrets),
        agentIds:
          request.body === undefined
            ? new Set()
            : agentRequestIds(new TextDecoder().decode(request.body)),
        refusal: errorMessageFor(
          request.body,
          `${record.displayName} sent a response Scient could not verify, so it was withheld.`,
        ),
      };
      return {
        status: response.status,
        headers,
        body:
          body === null
            ? Stream.empty.pipe(Stream.ensuring(release))
            : Stream.fromReadableStream({
                evaluate: () =>
                  streamed ? redactEventStream(body, redaction) : redactJsonStream(body, redaction),
                onError: (error) => error,
              }).pipe(
                Stream.onError(() =>
                  Effect.logWarning("connector response stream ended early", {
                    connectorId: record.connectorId,
                  }),
                ),
                Stream.ignore,
                // The permit and the upstream exchange live as long as the body.
                Stream.ensuring(release),
              ),
      } satisfies ConnectorForwardResponse;
    },
  );

  return ConnectorRuntime.of({
    list: Effect.fn("ConnectorRuntime.list")(function* () {
      const state = yield* store.read;
      return {
        revision: yield* Ref.get(revision),
        connectors: state.connectors.map(toSummary),
        diagnostics: state.diagnostics,
      };
    }),
    changes: Stream.fromPubSub(changes),
    add,
    addFromPlugin: Effect.fn("ConnectorRuntime.addFromPlugin")(function* (input) {
      const url = yield* checkUrl(input.url, STRICT_EGRESS_POLICY);
      const existing = (yield* store.read).connectors.find(
        (record) =>
          record.source.type === "plugin" &&
          record.source.pluginId === input.pluginId &&
          record.url === url,
      );
      if (existing) return existing.connectorId;
      const createdAt = yield* isoNow;
      const description = input.description?.trim();
      const created = yield* commitNewRecord({
        connectorId: yield* newConnectorId,
        serverName: input.displayName,
        displayName: input.displayName,
        ...(description ? { description } : {}),
        url,
        source: { type: "plugin", pluginId: input.pluginId },
        // Installing a bundle never signs in or grants anything.
        auth: { type: "oauth", usesOwnClient: false },
        status: "needs-auth",
        enabled: true,
        authRevision: 0,
        availability: { type: "all-projects" },
        createdAt,
        updatedAt: createdAt,
      });
      yield* publishChange;
      return created.connectorId;
    }),
    removeByPlugin: Effect.fn("ConnectorRuntime.removeByPlugin")(function* (pluginId) {
      const records = (yield* store.read).connectors.filter(
        (record) => record.source.type === "plugin" && record.source.pluginId === pluginId,
      );
      for (const record of records) yield* removeRecord(record);
    }),
    startSignIn,
    completeSignIn,
    update: Effect.fn("ConnectorRuntime.update")(function* (input) {
      if (input.enabled === true) {
        const record = yield* requireRecord(input.connectorId);
        if (!(yield* isPluginEligible(record))) {
          return yield* extensionsError(
            "unsupported",
            "This connector belongs to a Scient plugin that is disabled or needs reinstalling; enable the plugin instead.",
          );
        }
      }
      const availability =
        input.availability === undefined ? undefined : yield* checkAvailability(input.availability);
      yield* updateRecord(input.connectorId, (current, updatedAt) => ({
        ...current,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(availability === undefined ? {} : { availability }),
        updatedAt,
      }));
    }),
    remove: Effect.fn("ConnectorRuntime.remove")(function* (input) {
      yield* removeRecord(yield* requireRecord(input.connectorId));
    }),
    test,
    resolveDelivery: Effect.fn("ConnectorRuntime.resolveDelivery")(function* (input) {
      const state = yield* store.read;
      const eligible: EligibleConnector[] = [];
      const skipped: Array<EligibleConnector & { readonly reason: ExtensionDeliverySkipReason }> =
        [];
      for (const record of state.connectors) {
        if (!isLive(record.connectorId)) continue;
        const reason: ExtensionDeliverySkipReason | undefined =
          !record.enabled || !(yield* isPluginEligible(record))
            ? "disabled"
            : !isAvailableIn(record, input.projectId)
              ? "project-deselected"
              : record.status === "connected"
                ? undefined
                : record.status;
        if (reason === undefined) eligible.push(eligibleOf(record));
        else skipped.push({ ...eligibleOf(record), reason });
      }
      return { eligible, skipped };
    }),
    isGranted: Effect.fn("ConnectorRuntime.isGranted")(function* (input) {
      const state = yield* store.read;
      const record = state.connectors.find((entry) => entry.connectorId === input.connectorId);
      return (
        record !== undefined &&
        isLive(record.connectorId) &&
        record.enabled &&
        record.status === "connected" &&
        isAvailableIn(record, input.projectId) &&
        (yield* isPluginEligible(record))
      );
    }),
    forward,
  });
});

export const layer = Layer.effect(
  ConnectorRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeConnectorRuntime({ stateDir: config.stateDir });
  }),
);
