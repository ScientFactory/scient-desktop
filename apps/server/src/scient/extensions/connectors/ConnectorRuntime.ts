/**
 * Disconnect tombstones before other work and aborts the lifetime signal. Serialize
 * refresh/sign-in/disconnect under one lifecycle lock so in-flight work cannot send, persist, or
 * retain grants afterward; revoke grants obtained across the fence.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Hash-only credential fingerprints never expose secrets.
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type ConnectorAddInput,
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
  type ProviderInstanceId,
  type VaultSecretRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { AccountsService } from "../../accounts/AccountsService.ts";
import {
  type ConnectorSessionsShape,
  makeConnectorSessions,
} from "../../accounts/connectorSessions.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AnalyticsService } from "../../../telemetry/AnalyticsService.ts";
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
import { extractToolParameters } from "./toolParameters.ts";
import {
  connectorHostOf,
  discoveryFinisher,
  discoveryRequestOf,
  KNOWN_PROTOCOL_VERSIONS,
  unavailableDiscoveryAnswer,
} from "./ConnectorDiscovery.ts";
import { sweepRemovedHistory } from "../../storage/FolderHistory.ts";
import { ConnectorCredentialStore } from "./ConnectorCredentialStore.ts";
import {
  applySignIn,
  isConnectorOAuthError,
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
  isConnectorEgressRejected,
  CONNECTOR_CONTROL_TIMEOUT_MS,
  CONNECTOR_CONTROL_MAX_RESPONSE_BYTES,
  controlFetch,
  describeEgressFailure,
  egressPolicyFor,
  type ConnectorFetch,
  makeConnectorFetch,
  proxyFetch,
  STRICT_EGRESS_POLICY,
} from "./ConnectorOutbound.ts";
import { probeConnector } from "./ConnectorProbe.ts";
import { bundleFetch } from "./LocalBundleDownload.ts";
import {
  agentRequestIds,
  requestIdToken,
  credentialSet,
  type CredentialSet,
  type RedactionContext,
  isProtectableCredential,
  MIN_CREDENTIAL_LENGTH,
  redactEventStream,
  redactJsonStream,
  redactText,
} from "./ConnectorRedaction.ts";
import { ConnectorSessionBindings } from "./ConnectorSessionBindings.ts";
import {
  GitHubSourceControlCredential,
  isCredentialDestination,
} from "./GitHubSourceControlCredential.ts";
import type { SourceControlCredential } from "@t3tools/source-control-core/server/driver";
import { curatedServerForUrl } from "../discover/curatedCatalog.ts";
import {
  type ConnectorAuthRecord,
  type ConnectorRecord,
  type ConnectorStateData,
  makeConnectorStateStore,
} from "./ConnectorStateStore.ts";
import type { McpInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import * as LocalDuplexProcess from "../../execution/LocalDuplexProcess.ts";
import { makeConnectorLogs } from "./ConnectorLogs.ts";
import { observeFeature } from "./observedFeature.ts";
import {
  connectorChangeEvents,
  connectorFacts,
  connectorInventoryEvents,
  type ExtensionEvent,
} from "../../../telemetry/ExtensionAnalytics.ts";
import { callTools, makeLocalConnectorAuthoring } from "./LocalConnectorAuthoring.ts";
import { type LocalSignInHandler, makeLocalConnectorHost } from "./LocalConnectorProcesses.ts";
import { makeLocalConnectors } from "./LocalConnectors.ts";
import { makeRunTool, type RunTool } from "./PackageSource.ts";

const MAX_CONNECTORS = 30;
/** Refresh this long before the access token expires. */
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
/**
 * Upstream exchanges per connector, held until the response body completes or
 * is cancelled (open SSE streams included). A full connector answers busy
 * instead of queueing.
 */
export const MAX_IN_FLIGHT_PER_CONNECTOR = 32;
/** Days a removed connector can still be brought back with Undo. */
const REMOVED_HISTORY_DAYS = 30;
const MAX_SERVER_NAME_BASE = 44;
/** Source Control is followed at most this often, from listings and session starts. */
const FOLLOW_SOURCE_CONTROL_MS = 60_000;
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
  /** Owner-only files: a signed-in connector's session. */
  readonly secretsDir?: string;
  /** Stands in for Accounts' connector sessions (tests). */
  readonly signInSessions?: ConnectorSessionsShape;
  /** Stands in for npm and uv when a copy brings in a package's code (tests). */
  readonly runTool?: RunTool;
  /** Stands in for the network when a registry bundle is downloaded (tests). */
  readonly bundleFetch?: ConnectorFetch;
  /** Told when a change reaches a connector's lock, before it waits there (tests). */
  readonly onConnectorLock?: (connectorId: string) => void;
}

type Credential =
  | {
      readonly type: "ok";
      readonly headers: Readonly<Record<string, string>>;
      readonly accessToken: string | undefined;
      /** Every credential value applied or held for this request, for redaction. */
      readonly secrets: ReadonlyArray<string | undefined>;
      /** Borrowed from Source Control, which is told when the service refuses it. */
      readonly borrowed?: SourceControlCredential;
    }
  | { readonly type: "lost"; readonly message: string }
  | { readonly type: "failed"; readonly message: string }
  | CredentialRejected;

/**
 * The service (or its authorization server) refused the credential for good: the person has to
 * fix it, so every request fails, discovery too. Only benign unavailability meets the empty server.
 */
type CredentialRejected = {
  readonly type: "rejected";
  readonly message: string;
  /** A refused exchange whose body is still open, disposed of without waiting. */
  readonly response?: Response;
};

type SendOutcome =
  | {
      readonly type: "response";
      readonly response: Response;
      readonly secrets: ReadonlyArray<string | undefined>;
      /** The current credentials, for an exchange that can gain some while it streams. */
      readonly live?: () => CredentialSet;
      /** What a 403 to a request that carried a credential said about it, read once. */
      readonly forbidden?: ForbiddenClassification;
    }
  | { readonly type: "lost"; readonly message: string }
  | { readonly type: "failed"; readonly message: string }
  | CredentialRejected;

type RefreshOutcome =
  | { readonly type: "ok"; readonly session: ConnectorOAuthSession }
  | { readonly type: "transient"; readonly session: ConnectorOAuthSession }
  | { readonly type: "lost"; readonly message: string }
  | CredentialRejected;

class ConnectorUpstreamError extends Schema.TaggedError<ConnectorUpstreamError>()(
  "ConnectorUpstreamError",
  { cause: Schema.Defect() },
) {}

/** Thrown into the MCP SDK client when the credential is lost or the request failed. */
class ConnectorUnavailableError extends Schema.TaggedError<ConnectorUnavailableError>()(
  "ConnectorUnavailableError",
  { kind: Schema.Literals(["lost", "failed"]), message: Schema.String },
) {}

const isConnectorUnavailableError = Schema.is(ConnectorUnavailableError);

const policyOf = (record: Pick<ConnectorRecord, "source" | "url">): ConnectorEgressPolicy =>
  egressPolicyFor(record.url, record.source);

/** Availability alone; the grant also requires the connector to be enabled. */
const isAvailableIn = (record: ConnectorRecord, projectId: ProjectId | undefined) =>
  record.availability.type === "all-projects" ||
  (projectId !== undefined && record.availability.projectIds.includes(projectId));

/** Names nothing: the agent that asked may not learn what the connector is called. */
const NOT_FOR_THIS_AGENT =
  "This connector is not available to this agent. The person can choose this agent on its page in Settings → Extensions.";

/** Whether the agent is one the person chose; every agent when none were chosen or it is unknown. */
const isForAgent = (record: ConnectorRecord, providerInstanceId: ProviderInstanceId | undefined) =>
  record.agents === undefined ||
  providerInstanceId === undefined ||
  record.agents.includes(providerInstanceId);

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
    case "source-control":
      return { type: "source-control", host: auth.host, account: auth.account };
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
  ...(record.agents === undefined ? {} : { agents: record.agents }),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
});

const eligibleOf = (record: ConnectorRecord): EligibleConnector => ({
  connectorId: record.connectorId,
  serverName: record.serverName,
  displayName: record.displayName,
  authRevision: record.authRevision,
});

const secretFingerprint = (secrets: ReadonlyArray<string | undefined>): string =>
  NodeCrypto.createHash("sha256")
    .update(secrets.filter((secret): secret is string => secret !== undefined).join("\0"))
    .digest("hex");

const pluginKeyRefusalMessage = (record: Pick<ConnectorRecord, "displayName">) =>
  `${record.displayName} rejected the key bound in Scient Accounts. Ask the user to update that account, then retry.`;

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

/** Standard MCP CallToolResult with isError: true for valid tool calls hitting an unavailable connector. */
const toolCallErrorJson = (body: Uint8Array | undefined, message: string): string | undefined => {
  const parsed = discoveryRequestOf(body);
  if (parsed?.method !== "tools/call" || parsed.idToken === undefined) return undefined;
  return `{"jsonrpc":"2.0","id":${parsed.idToken},"result":${JSON.stringify({
    content: [{ type: "text", text: message }],
    isError: true,
  })}}`;
};

/**
 * A server-owned refusal, never HTTP 401 (it would start OAuth against Scient): POST gets a
 * JSON-RPC error, GET/DELETE `status` with JSON. Discovery meets an empty server instead, so one
 * unavailable connector never fails an agent's whole session.
 */
const refusal = (
  request: Pick<ConnectorForwardRequest, "method" | "body">,
  message: string,
  status: number,
  error: string,
): ConnectorForwardResponse => {
  if (request.method !== "POST")
    return {
      status,
      headers: { "content-type": "application/json" },
      body: jsonBody({ error, message }),
    };
  const discovery = unavailableDiscoveryAnswer(discoveryRequestOf(request.body), message);
  if (discovery?.status === 202) return { status: 202, headers: {}, body: Stream.empty };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Stream.make(
      new TextEncoder().encode(discovery?.json ?? errorMessageFor(request.body, message)),
    ),
  };
};

/**
 * Confirmed vendor credential or scope refusal: discovery completes quietly with an empty server
 * (live status is published to Extensions and the thread indicator), valid `tools/call` requests
 * receive an actionable MCP `CallToolResult` with `isError: true`, and other methods receive a
 * JSON-RPC error.
 */
const credentialRefusal = (
  request: Pick<ConnectorForwardRequest, "method" | "body">,
  message: string,
): ConnectorForwardResponse => {
  if (request.method !== "POST") {
    return {
      status: 403,
      headers: { "content-type": "application/json" },
      body: jsonBody({ error: "connector_unavailable", message }),
    };
  }
  const discovery = unavailableDiscoveryAnswer(discoveryRequestOf(request.body), message);
  if (discovery?.status === 202) return { status: 202, headers: {}, body: Stream.empty };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Stream.make(
      new TextEncoder().encode(
        discovery?.json ??
          toolCallErrorJson(request.body, message) ??
          errorMessageFor(request.body, message),
      ),
    ),
  };
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

/** Error codes a service uses when it refuses the credential itself, read case-insensitively. */
const CREDENTIAL_ERROR_CODES = new Set([
  "invalid_token",
  "insufficient_scope",
  "invalid_api_key",
  "unauthorized",
  "unauthenticated",
  "authentication_error",
]);
const CREDENTIAL_EVIDENCE_MAX_BYTES = 16 * 1024;
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

type ForbiddenClassification = "none" | "insufficient-scope" | "bad-credential";

/**
 * The `error` auth-param of the Bearer challenge in a `WWW-Authenticate` value (RFC 9110 §11.6.1):
 * read token by token, so a quoted value or another scheme's parameters never count.
 */
export const bearerChallengeError = (header: string | null): string | undefined => {
  if (header === null) return undefined;
  const token = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y;
  const quoted = /"((?:[^"\\]|\\.)*)"/y;
  let index = 0;
  let scheme: string | undefined;
  const skip = (pattern: RegExp) => {
    pattern.lastIndex = index;
    const match = pattern.exec(header);
    if (match !== null) index = pattern.lastIndex;
    return match;
  };
  while (index < header.length) {
    skip(/[\s,]*/y);
    const name = skip(token)?.[0];
    if (name === undefined) return undefined;
    skip(/[ \t]*/y);
    if (header[index] !== "=") {
      // A new challenge: its scheme, then token68 (consumed up to the next comma) or parameters.
      scheme = name.toLowerCase();
      skip(/[ \t]*/y);
      skip(/[A-Za-z0-9\-._~+/]+=*(?=[ \t]*(?:,|$))/y);
      continue;
    }
    index += 1;
    skip(/[ \t]*/y);
    const value =
      header[index] === '"' ? skip(quoted)?.[1]?.replace(/\\(.)/gu, "$1") : skip(token)?.[0];
    if (value === undefined) return undefined;
    if (scheme === "bearer" && name.toLowerCase() === "error") return value.toLowerCase();
  }
  return undefined;
};

const classifyCredentialCode = (parsed: unknown): ForbiddenClassification => {
  const error = fieldOf(parsed, "error");
  const candidates = [
    error,
    fieldOf(parsed, "code"),
    fieldOf(parsed, "error_code"),
    fieldOf(error, "code"),
    fieldOf(error, "type"),
    fieldOf(error, "status"),
  ]
    .filter((code): code is string => typeof code === "string")
    .map((code) => code.toLowerCase());
  if (candidates.includes("insufficient_scope")) return "insufficient-scope";
  if (candidates.some((code) => CREDENTIAL_ERROR_CODES.has(code))) return "bad-credential";
  return "none";
};

/**
 * Classifies an HTTP 403 using bounded header/JSON inspection: distinguishes revoked/invalid
 * credentials from insufficient OAuth scopes and ordinary access-policy denials.
 */
const classifyForbiddenResponse = (response: Response, signal: AbortSignal) =>
  Effect.promise(async (interrupted): Promise<ForbiddenClassification> => {
    // RFC 6750: only the challenge's error code says why; a bare realm is a policy answer.
    const challengeError = bearerChallengeError(response.headers.get("www-authenticate"));
    if (challengeError === "insufficient_scope") return "insufficient-scope";
    if (challengeError === "invalid_token") return "bad-credential";
    const body = response.body;
    if (!(response.headers.get("content-type")?.toLowerCase() ?? "").includes("json")) {
      return "none";
    }
    if (body === null) return "none";
    const reader = body.getReader();
    const stop = () => void reader.cancel().catch(() => undefined);
    interrupted.addEventListener("abort", stop, { once: true });
    signal.addEventListener("abort", stop, { once: true });
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    try {
      while (size < CREDENTIAL_EVIDENCE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
    } catch {
      return "none";
    } finally {
      stop();
      interrupted.removeEventListener("abort", stop);
      signal.removeEventListener("abort", stop);
    }
    if (size >= CREDENTIAL_EVIDENCE_MAX_BYTES) return "none";
    return decodeJsonText(Buffer.concat(chunks).toString("utf8")).pipe(
      Option.map(classifyCredentialCode),
      Option.getOrElse((): ForbiddenClassification => "none"),
    );
  });

export const makeConnectorRuntime = Effect.fn("ConnectorRuntime.make")(function* (
  options: ConnectorRuntimeOptions,
) {
  const credentials = yield* ConnectorCredentialStore;
  const accounts = yield* Effect.serviceOption(AccountsService);
  const github = yield* Effect.serviceOption(GitHubSourceControlCredential);
  const pluginHttp = new Map<
    string,
    {
      readonly record: ConnectorRecord;
      readonly authorize: Parameters<
        NonNullable<ConnectorRuntimeShape["registerPluginKeyHttp"]>
      >[0]["authorize"];
    }
  >();
  const eligibility = yield* PluginConnectorEligibility;
  const projects = yield* ProjectStoreV2;
  const analytics = Option.getOrUndefined(yield* Effect.serviceOption(AnalyticsService));
  const recordExtensionEvents = (events: ReadonlyArray<ExtensionEvent>) =>
    analytics === undefined || events.length === 0
      ? Effect.void
      : Effect.forEach(
          events,
          (event) => analytics.record(event.name, event.properties).pipe(Effect.ignoreCause()),
          { discard: true },
        );
  const savedStore = yield* makeConnectorStateStore(options.stateDir);
  // Every saved change, from any path (Extensions, agents, plugins, sign-in), says what it did.
  const store: typeof savedStore = {
    read: savedStore.read,
    // The saved before and after travel with the result, so each run reports its own change.
    update: (transform) =>
      savedStore
        .update((current) =>
          Effect.map(transform(current), ([result, next]) => {
            const change =
              next === current ? undefined : ([current.connectors, next.connectors] as const);
            return [[result, change] as const, next] as const;
          }),
        )
        .pipe(
          Effect.flatMap(([result, change]) =>
            change === undefined
              ? Effect.succeed(result)
              : recordExtensionEvents(connectorChangeEvents(...change)).pipe(Effect.as(result)),
          ),
        ),
  };
  yield* recordExtensionEvents(connectorInventoryEvents((yield* store.read).connectors));
  const clock = yield* Clock.Clock;
  const random = yield* SecureRandom.SecureRandom;
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
  /**
   * Sign-ins the service refused for good (the refresh, or the refreshed token), by connector:
   * the credential generation the refusal published and what to tell the agent, never a token.
   * Until the person signs in again, or turns the connector off or removes it, every request
   * hears the refusal, discovery too, instead of the empty server.
   */
  const refusedSignIns = new Map<
    string,
    { readonly authRevision: number; readonly message: string }
  >();
  /** SHA-256 fingerprints of rejected non-OAuth secrets so unchanged bad keys stay blocked until updated. */
  const rejectedCredentialFingerprints = new Map<string, string>();
  /** Accounts' binding revision when a plugin key was refused; a later revision may hold a new key. */
  const pluginRefusalBindingRevisions = new Map<string, number | undefined>();
  /** Raised when a plugin key's refusal starts or ends, so its next delivery reloads the tools. */
  const pluginKeyRevisions = new Map<string, number>();
  const accountsBindingRevision =
    Option.isSome(accounts) && accounts.value.bindingRevision !== undefined
      ? accounts.value.bindingRevision
      : Effect.undefined;
  const bumpPluginKeyRevision = (connectorId: string) =>
    pluginKeyRevisions.set(connectorId, (pluginKeyRevisions.get(connectorId) ?? 0) + 1);
  const standingRefusal = (record: ConnectorRecord): string | undefined => {
    const refused = refusedSignIns.get(record.connectorId);
    if (refused === undefined) return undefined;
    if (record.status !== "connected" && refused.authRevision === record.authRevision) {
      return refused.message;
    }
    // A new sign-in or credential replaced the refused one.
    refusedSignIns.delete(record.connectorId);
    return undefined;
  };
  /** A plugin's connector is usable only while an enabled, verified plugin owns it. */
  const isPluginEligible = (record: ConnectorRecord) =>
    eligibility.isEligible({
      connectorId: record.connectorId,
      pluginId: record.source.type === "plugin" ? record.source.pluginId : undefined,
    });
  /**
   * Why an agent may not use a connector from a chat in `projectId`, the rules delivery uses
   * (on, eligible, available in the project); undefined when it may. Fixing one the user turned
   * off is allowed (`offAllowed`): agents may turn it on anyway, while the project is the user's.
   */
  const unusableIn = Effect.fn("ConnectorRuntime.unusableIn")(function* (
    record: ConnectorRecord,
    projectId: ProjectId | undefined,
    offAllowed = false,
    providerInstanceId?: ProviderInstanceId,
  ) {
    if (!isForAgent(record, providerInstanceId)) return NOT_FOR_THIS_AGENT;
    if (!(yield* isPluginEligible(record)))
      return `${record.displayName} belongs to a plugin that is off or not verified.`;
    if (!record.enabled && !offAllowed)
      return `${record.displayName} is off. Turn it on first (scient_connector_control).`;
    if (!isAvailableIn(record, projectId))
      return `${record.displayName} isn't available in this chat's project; the user can make it available on its page in Settings → Extensions.`;
    return undefined;
  });

  /** Best-effort revocation outside the connector's lifetime (it may already be aborted). */
  /** What the agent hears when a service refused this connector's key. */
  const refusedKeyMessage = (record: ConnectorRecord) =>
    pluginHttp.has(record.connectorId)
      ? pluginKeyRefusalMessage(record)
      : record.auth.type === "source-control"
        ? `GitHub refused Source Control's credential for ${record.auth.account}. Check the sign-in in Settings → Source Control.`
        : `${record.displayName} rejected the credential stored in Scient. Ask the user to update it in Scient Settings → Extensions.`;
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
  const updateRecord = Effect.fn("ConnectorRuntime.updateRecord")(function* (
    connectorId: string,
    change: (record: ConnectorRecord, updatedAt: string) => ConnectorRecord,
  ) {
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

  const observed = observeFeature(analytics);
  const logs = yield* makeConnectorLogs(options.stateDir);
  const broker = yield* Effect.serviceOption(PreviewAutomationBroker);
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  const signInSessions =
    options.signInSessions !== undefined
      ? Option.some(options.signInSessions)
      : options.secretsDir !== undefined &&
          Option.isSome(accounts) &&
          Option.isSome(broker) &&
          Option.isSome(environment)
        ? Option.some(
            yield* makeConnectorSessions({ secretsDir: options.secretsDir }).pipe(
              Effect.provideService(AccountsService, accounts.value),
              Effect.provideService(PreviewAutomationBroker, broker.value),
              Effect.provideService(ServerEnvironment, environment.value),
            ),
          )
        : Option.none();
  const localHost = yield* makeLocalConnectorHost({
    onEvent: (event) => {
      switch (event.type) {
        case "stderr":
          return logs.append(event.connectorId, event.text, {
            keep: !event.connectorId.startsWith("check_"),
          });
        case "started":
        case "stopped":
          return publishChange;
        case "ready":
          return updateRecord(event.connectorId, (current, updatedAt) =>
            current.lastError === undefined
              ? current
              : { ...current, lastError: undefined, updatedAt },
          ).pipe(Effect.ignore);
        case "failed":
          return updateRecord(event.connectorId, (current, updatedAt) =>
            current.lastError === event.message
              ? current
              : { ...current, lastError: event.message, updatedAt },
          ).pipe(Effect.ignore);
      }
    },
  });
  yield* localHost.sweepIdle.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  const localConnectors = yield* makeLocalConnectors({
    stateDir: options.stateDir,
    accounts,
    projects,
    sessions: signInSessions,
    bundleFetch: options.bundleFetch ?? bundleFetch,
  });
  /** One connector as clients see it; a local one reads its manifest for what it needs. */
  const summarizeWith =
    (names: ReadonlyMap<VaultSecretRef, string>) =>
    (record: ConnectorRecord): Effect.Effect<ConnectorSummary> =>
      record.local === undefined
        ? Effect.succeed(toSummary(record))
        : localConnectors.summarize(record, record.local, names).pipe(
            Effect.map((local) => ({
              ...toSummary(record),
              local: { ...local, running: localHost.running(record.connectorId) },
            })),
          );
  const keyNamesFor = (records: ReadonlyArray<ConnectorRecord>) =>
    records.some((record) => record.local !== undefined)
      ? localConnectors.keyNames
      : Effect.succeed(new Map<VaultSecretRef, string>());
  const summaryOf = (record: ConnectorRecord) =>
    Effect.flatMap(keyNamesFor([record]), (names) => summarizeWith(names)(record));

  const authoring = makeLocalConnectorAuthoring({
    local: localConnectors,
    host: localHost,
    logs,
    sessions: signInSessions,
    records: Effect.map(store.read, (state) => state.connectors),
    summaryOf: (record) => summaryOf(record),
    newConnectorId: Effect.suspend(() => newConnectorId),
    add: (record) => commitNewRecord(record).pipe(Effect.tap(() => publishChange)),
    update: (connectorId, change) => updateRecord(connectorId, change),
    drop: (record) => Effect.suspend(() => removeRecord(record, { keepCopy: false })),
    revive: (connectorId) => {
      removed.delete(connectorId);
    },
    isoNow,
    runTool: options.runTool ?? (yield* makeRunTool),
    unusableIn,
    ...(options.onConnectorLock === undefined ? {} : { onLock: options.onConnectorLock }),
  });

  // Undo copies of connectors removed over 30 days ago, and never brought back, are forgotten.
  yield* Effect.gen(function* () {
    const live = new Set<string>(
      (yield* store.read).connectors.map((record) => record.connectorId),
    );
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      sweepRemovedHistory(localConnectors.historyRoot, {
        now,
        olderThanMs: REMOVED_HISTORY_DAYS * 24 * 60 * 60 * 1000,
        live: (key) => live.has(key),
      }),
    );
  }).pipe(Effect.ignore, Effect.forkScoped);

  /** Marks whether signing in again needs the person; the connector page shows Sign in. */
  const markNeedsUser = (connectorId: string, needsUser: boolean) =>
    updateRecord(connectorId, (current, updatedAt) =>
      current.local === undefined || (current.local.signInNeedsUser === true) === needsUser
        ? current
        : {
            ...current,
            local: needsUser
              ? { ...current.local, signInNeedsUser: true }
              : (({ signInNeedsUser: _dropped, ...rest }) => rest)(current.local),
            updatedAt,
          },
    ).pipe(Effect.ignore);

  /** The site ended a signed-in connector's session: sign in again, or say who must. */
  const signInHandler = (record: ConnectorRecord): LocalSignInHandler => ({
    expired: (generation) =>
      observed("connectors.session.refresh")(
        Effect.gen(function* () {
          const current = (yield* findRecord(record.connectorId)) ?? record;
          const renewed = yield* localConnectors.signInAgain(current, generation);
          yield* markNeedsUser(record.connectorId, renewed.type === "needs-user");
          return renewed;
        }),
        (renewed) =>
          renewed.type === "signed-in"
            ? {}
            : { outcome: renewed.type === "needs-user" ? "needs-user" : "error" },
      ).pipe(
        Effect.map((renewed) =>
          renewed.type === "signed-in"
            ? ({ retry: true } as const)
            : ({
                retry: false,
                message:
                  renewed.type === "needs-user"
                    ? `${renewed.message} Tell the user; there is a Sign in button on the connector's page.`
                    : `${record.displayName} could not sign in again: ${renewed.message}`,
              } as const),
        ),
      ),
    stillExpired: Effect.gen(function* () {
      yield* markNeedsUser(record.connectorId, true);
      const site = yield* localConnectors.signInSiteOf(record.local!);
      const host = site !== undefined && URL.canParse(site) ? new URL(site).host : "The site";
      return `${host} still ended the session right after Scient signed in again. The connector may not send the session the way the site expects; fix it with scient_connector_copy, or ask the user to sign in on the connector's page.`;
    }),
  });

  const exchangeLocal = Effect.fn("ConnectorRuntime.exchangeLocal")(function* (
    record: ConnectorRecord,
    request: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly sessionId: string | undefined;
      readonly body: Uint8Array | undefined;
      readonly signal: AbortSignal;
    },
    location: ConnectorForwardRequest["location"],
  ) {
    // A key turned off, removed or changed in Accounts stops the copies holding it; the agent's
    // next request starts a fresh one, which asks Accounts again.
    if (
      request.sessionId !== undefined &&
      !(yield* localConnectors.stillAuthorized(record, location))
    ) {
      yield* localHost.stop(
        record.connectorId,
        `${record.displayName} restarted because its key or sign-in changed in Accounts.`,
      );
      // A sign-in that was turned off or removed leaves no session behind.
      if (record.local?.signIn !== undefined && Option.isSome(signInSessions))
        yield* signInSessions.value.remove(record.connectorId);
    }
    const response = yield* localHost.exchange(
      { connectorId: record.connectorId, displayName: record.displayName },
      request,
      localConnectors.start(record, record.serverName, location),
      record.local?.signIn === undefined ? undefined : signInHandler(record),
    );
    return {
      type: "response",
      response,
      // A program may echo its own key back; agents never receive one long enough to matter.
      secrets: localConnectors.secretsFor(record.connectorId).filter(isProtectableCredential),
      // A new sign-in during the exchange adds cookies; each answer is checked against all of them.
      live: () => localConnectors.credentialsFor(record.connectorId),
    } satisfies SendOutcome;
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
   * Apply credential failures only to the generation that observed them; late old-key errors cannot
   * overwrite a new sign-in. Status publication must not fail the request; auth revision changes
   * only on credential loss/state transition, not repeated status.
   */
  const markStatus = (
    record: ConnectorRecord,
    status: ConnectorRecord["status"],
    lastError: string,
    /** The service refused the sign-in for good: later requests keep hearing this. */
    refusal?: string,
  ) =>
    isLive(record.connectorId)
      ? Effect.suspend(() => {
          let marked: ConnectorRecord | undefined;
          return updateRecord(record.connectorId, (current, updatedAt) => {
            marked =
              current.authRevision !== record.authRevision
                ? undefined
                : {
                    ...current,
                    status,
                    lastError,
                    ...(status !== current.status && status !== "connected"
                      ? { authRevision: current.authRevision + 1 }
                      : {}),
                    updatedAt,
                  };
            return marked ?? current;
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (refusal === undefined || marked === undefined) return;
                refusedSignIns.set(record.connectorId, {
                  authRevision: marked.authRevision,
                  message: refusal,
                });
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("connector status could not be saved", {
                connectorId: record.connectorId,
                reason: error.reason,
              }),
            ),
          );
        })
      : Effect.void;

  /**
   * An OAuth grant was refused outside the lifecycle lock. Under the lock (so
   * no sign-in can commit in between), the loss is published only if that
   * grant still owns the connector.
   */
  const markGrantLost = (
    connectorId: string,
    grantId: string,
    lastError: string,
    refusal?: string,
  ) =>
    lifecycle(connectorId).withPermits(1)(
      Effect.gen(function* () {
        const current = yield* findRecord(connectorId);
        if (current === undefined) return;
        const entry = yield* loadOAuth(current).pipe(Effect.orElseSucceed(() => undefined));
        if (entry?.material.session?.grantId !== grantId) return;
        yield* markStatus(current, "needs-auth", lastError, refusal);
      }),
    );

  /** A borrowed or updated credential is back: bump authRevision so providers refresh stale catalogs. */
  const markConnected = (record: ConnectorRecord) =>
    updateRecord(record.connectorId, (current, updatedAt) =>
      current.authRevision !== record.authRevision || current.status === "connected"
        ? current
        : {
            ...current,
            status: "connected",
            authRevision: current.authRevision + 1,
            lastError: undefined,
            updatedAt,
          },
    ).pipe(
      Effect.tap(() => Effect.sync(() => sessions.dropConnector(record.connectorId))),
      Effect.ignore,
    );

  const isGitHubDestination = (url: string) =>
    Option.isSome(github) && isCredentialDestination(url, github.value.mcpUrl);

  const accountGone = (account: string) =>
    `Source Control no longer has a GitHub sign-in for ${account}. Sign in to GitHub as ${account} again, or remove GitHub and add it with another account.`;

  /** Source Control's credential for the record's own account; never another account's. */
  const borrow = Effect.fn("ConnectorRuntime.borrow")(function* (
    record: ConnectorRecord,
    auth: Extract<ConnectorAuthRecord, { type: "source-control" }>,
  ) {
    const lost = { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
    if (Option.isNone(github) || !isCredentialDestination(record.url, github.value.mcpUrl)) {
      yield* markStatus(
        record,
        "needs-credential",
        "Scient sends Source Control's GitHub credential only to GitHub's own MCP server.",
      );
      return lost;
    }
    const lent = yield* github.value.get(auth.host, { account: auth.account }).pipe(Effect.result);
    if (Result.isFailure(lent)) {
      yield* Effect.logWarning("connector could not borrow Source Control's credential", {
        connectorId: record.connectorId,
      });
      return { type: "failed", message: lent.failure.message } satisfies Credential;
    }
    const borrowed = Option.getOrUndefined(lent.success);
    const token = borrowed === undefined ? "" : Redacted.value(borrowed.token);
    if (borrowed === undefined || !isProtectableCredential(token)) {
      yield* markStatus(record, "needs-credential", accountGone(auth.account));
      return lost;
    }
    if (record.status !== "connected") yield* markConnected(record);
    return {
      type: "ok",
      headers: { authorization: `Bearer ${token}` },
      accessToken: undefined,
      secrets: [token],
      borrowed,
    } satisfies Credential;
  });

  const readStoredOAuth = Effect.fn("ConnectorRuntime.readStoredOAuth")(function* (
    record: ConnectorRecord,
  ) {
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
   * Re-read the current record under the lifecycle lock: callers may hold pre-sign-in tokens.
   * Refresh single-flight there so queued callers reuse the new grant and any loss is published for
   * the actual current credential.
   */
  const refreshSession = (snapshot: ConnectorRecord, staleAccessToken: string | undefined) =>
    lifecycle(snapshot.connectorId).withPermits(1)(
      Effect.gen(function* () {
        const record = yield* findRecord(snapshot.connectorId);
        if (record === undefined || record.auth.type !== "oauth" || !isLive(record.connectorId)) {
          return { type: "lost", message: lostGrantMessage(snapshot) } satisfies RefreshOutcome;
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
        // The grant being refreshed is gone (or unusable): drop its session from
        // memory and storage, then publish the loss for the record it belongs to.
        const loseGrant = Effect.fn("ConnectorRuntime.loseGrant")(function* (
          lastError: string,
          refusal?: string,
        ) {
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
          yield* markStatus(record, "needs-auth", lastError, refusal);
          return { type: "lost", message: lostGrantMessage(record) } satisfies RefreshOutcome;
        });
        if (Exit.isSuccess(refreshed) && !sessionProtectable(refreshed.value)) {
          yield* revokeLater(record, refreshed.value);
          return yield* loseGrant(UNPROTECTABLE_GRANT);
        }
        if (Exit.isSuccess(refreshed)) return yield* commitRefresh(record, entry, refreshed.value);
        const failure = Option.getOrUndefined(Exit.findErrorOption(refreshed))?.cause;
        if (isGrantLost(failure)) {
          const lost = yield* loseGrant(
            "The sign-in expired or was revoked. Sign in again to reconnect.",
            lostGrantMessage(record),
          );
          return { type: "rejected", message: lost.message } satisfies RefreshOutcome;
        }
        yield* Effect.logWarning("connector token refresh failed; keeping the connection", {
          connectorId: record.connectorId,
        });
        return { type: "transient", session } satisfies RefreshOutcome;
      }),
    );

  const credentialFor = Effect.fn("ConnectorRuntime.credentialFor")(function* (
    record: ConnectorRecord,
    scope?: McpInvocationScope,
  ) {
    if (!isLive(record.connectorId)) {
      return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
    }
    const plugin = pluginHttp.get(record.connectorId);
    if (plugin) {
      const resolved = yield* plugin.authorize(scope).pipe(Effect.result);
      if (
        resolved._tag === "Failure" ||
        !resolved.success.secrets.every(
          (secret) => isProtectableCredential(secret) && !/[\r\n\0]/.test(secret),
        )
      )
        return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
      return { type: "ok", ...resolved.success, accessToken: undefined } satisfies Credential;
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
        const stored = yield* auth.storage === "bound"
          ? Option.isSome(accounts)
            ? accounts.value
                .resolveBound(auth.credentialRef, {
                  kind: "connector",
                  connectorId: record.connectorId,
                  origin: new URL(record.url).origin,
                })
                .pipe(
                  Effect.map((value) => Option.some(Redacted.value(value))),
                  Effect.orElseSucceed(() => Option.none<string>()),
                )
            : Effect.succeed(Option.none<string>())
          : credentials
              .readOwned(auth.credentialRef, {
                type: "connector",
                connectorId: record.connectorId,
              })
              .pipe(
                Effect.map(Option.map((value) => new TextDecoder().decode(value.material))),
                Effect.orElseSucceed(() => Option.none<string>()),
              );
        if (Option.isNone(stored)) {
          yield* markStatus(record, "needs-credential", "The stored credential is missing.");
          return { type: "lost", message: lostGrantMessage(record) } satisfies Credential;
        }
        const value = stored.value;
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
          if (record.status === "connected") {
            yield* markStatus(
              record,
              "needs-auth",
              "The saved sign-in is missing. Sign in again.",
              lostGrantMessage(record),
            );
          }
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
          if (refreshed.type === "lost" || refreshed.type === "rejected") {
            return refreshed satisfies Credential;
          }
          session = refreshed.session;
        }
        return {
          type: "ok",
          headers: { authorization: `Bearer ${session.accessToken}` },
          accessToken: session.accessToken,
          secrets: [...held, ...sessionSecrets(session)],
        } satisfies Credential;
      }
      case "source-control":
        return yield* borrow(record, auth);
    }
  });

  /**
   * After a 401 to a borrowed credential: Source Control forgets that token, and the request is
   * sent once more only with a different one for the same account.
   */
  const replayBorrowed = Effect.fn("ConnectorRuntime.replayBorrowed")(function* (
    record: ConnectorRecord,
    auth: Extract<ConnectorAuthRecord, { type: "source-control" }>,
    refused: Extract<Credential, { type: "ok" }>,
    send: (
      headers: Readonly<Record<string, string>>,
    ) => Effect.Effect<Exit.Exit<Response, ConnectorUpstreamError>>,
    refusedCredential: (
      response: Response,
      secrets: ReadonlyArray<string | undefined>,
    ) => Effect.Effect<{
      readonly refused: boolean;
      readonly forbidden: ForbiddenClassification | undefined;
    }>,
    scope?: McpInvocationScope,
  ) {
    const message = refusedKeyMessage(record);
    const rejected = Effect.gen(function* () {
      rejectedCredentialFingerprints.set(record.connectorId, secretFingerprint(refused.secrets));
      yield* markStatus(record, "needs-credential", message, message);
      return { type: "rejected", message } satisfies SendOutcome;
    });
    if (Option.isNone(github) || refused.borrowed === undefined) return yield* rejected;
    yield* github.value.invalidate(auth.host, refused.borrowed);
    const next: Credential = yield* credentialFor(record, scope);
    // Source Control has no other token for the account (and has said so): the refusal stands.
    if (next.type === "lost" && isLive(record.connectorId)) {
      rejectedCredentialFingerprints.set(record.connectorId, secretFingerprint(refused.secrets));
      const latest = (yield* findRecord(record.connectorId)) ?? record;
      yield* markStatus(latest, "needs-credential", message, message);
      return { type: "rejected", message } satisfies SendOutcome;
    }
    if (next.type !== "ok") return next satisfies SendOutcome;
    if (!isLive(record.connectorId)) {
      return { type: "lost", message: lostGrantMessage(record) } satisfies SendOutcome;
    }
    if (
      next.borrowed === undefined ||
      Redacted.value(next.borrowed.token) === Redacted.value(refused.borrowed.token)
    ) {
      return yield* rejected;
    }
    const replay = yield* send(next.headers);
    if (Exit.isFailure(replay)) {
      return {
        type: "failed",
        message: describeEgressFailure(Option.getOrUndefined(Exit.findErrorOption(replay))?.cause),
      } satisfies SendOutcome;
    }
    const verdict = yield* refusedCredential(replay.value, next.secrets);
    if (verdict.refused) {
      yield* cancelBody(replay.value);
      yield* github.value.invalidate(auth.host, next.borrowed);
      return yield* rejected;
    }
    return {
      type: "response",
      response: replay.value,
      secrets: [...refused.secrets, ...next.secrets],
      ...(verdict.forbidden === undefined ? {} : { forbidden: verdict.forbidden }),
    } satisfies SendOutcome;
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
    scope?: McpInvocationScope,
    /** The person asked to check it: a key refused before is tried once more. */
    recheck = false,
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
      }).pipe(
        Effect.tap((response) =>
          Effect.annotateCurrentSpan("http.response.status_code", response.status),
        ),
        Effect.withSpan("ConnectorRuntime.upstreamHeaders", {
          attributes: { "http.request.method": request.method },
        }),
        Effect.exit,
      );
    const gone = { type: "lost", message: lostGrantMessage(record) } satisfies SendOutcome;
    // What a 403 said about the credential it carried; none was sent, nothing was refused.
    const forbiddenVerdict = (response: Response, secrets: ReadonlyArray<string | undefined>) =>
      response.status === 403 &&
      record.local === undefined &&
      secrets.some((secret) => secret !== undefined)
        ? Effect.suspend(() => {
            const evidence = response.clone();
            return classifyForbiddenResponse(evidence, signal).pipe(
              // An unread copy would hold the original body back.
              Effect.ensuring(
                Effect.sync(() => void evidence.body?.cancel().catch(() => undefined)),
              ),
            );
          })
        : Effect.succeed<ForbiddenClassification | undefined>(undefined);
    // A 401, or a 403 whose challenge or body names the credential it carried as the reason.
    const refusedCredential = (response: Response, secrets: ReadonlyArray<string | undefined>) =>
      response.status === 401
        ? Effect.succeed({ refused: true, forbidden: undefined })
        : forbiddenVerdict(response, secrets).pipe(
            Effect.map((forbidden) => ({ refused: forbidden === "bad-credential", forbidden })),
          );

    const credential: Credential = yield* credentialFor(record, scope);
    if (credential.type !== "ok") return credential satisfies SendOutcome;
    if (!isLive(record.connectorId)) return gone;
    const currentFingerprint =
      credential.secrets.length > 0 ? secretFingerprint(credential.secrets) : undefined;
    // The same key the service refused is not sent again until it changes or the person checks.
    if (
      !recheck &&
      record.auth.type !== "oauth" &&
      currentFingerprint !== undefined &&
      rejectedCredentialFingerprints.get(record.connectorId) === currentFingerprint
    ) {
      return { type: "rejected", message: refusedKeyMessage(record) } satisfies SendOutcome;
    }
    const first = yield* send(credential.headers);
    if (Exit.isFailure(first)) {
      if (!isLive(record.connectorId)) return gone;
      return {
        type: "failed",
        message: describeEgressFailure(Option.getOrUndefined(Exit.findErrorOption(first))?.cause),
      } satisfies SendOutcome;
    }
    const firstVerdict = yield* refusedCredential(first.value, credential.secrets);
    if (!firstVerdict.refused) {
      if (first.value.ok && rejectedCredentialFingerprints.delete(record.connectorId)) {
        if (pluginHttp.has(record.connectorId)) {
          pluginRefusalBindingRevisions.delete(record.connectorId);
          bumpPluginKeyRevision(record.connectorId);
          yield* publishChange;
        }
      }
      return {
        type: "response",
        response: first.value,
        secrets: credential.secrets,
        ...(firstVerdict.forbidden === undefined ? {} : { forbidden: firstVerdict.forbidden }),
      } satisfies SendOutcome;
    }
    if (pluginHttp.has(record.connectorId)) {
      if (
        currentFingerprint !== undefined &&
        rejectedCredentialFingerprints.get(record.connectorId) !== currentFingerprint
      ) {
        rejectedCredentialFingerprints.set(record.connectorId, currentFingerprint);
        pluginRefusalBindingRevisions.set(record.connectorId, yield* accountsBindingRevision);
        bumpPluginKeyRevision(record.connectorId);
        yield* publishChange;
      }
      // This transient registration has no persisted connector status and no OAuth grant.
      // Hand the rejected exchange back without awaiting an untrusted response body's cancel.
      return {
        type: "rejected",
        response: first.value,
        message: pluginKeyRefusalMessage(record),
      } satisfies SendOutcome;
    }
    yield* cancelBody(first.value);
    if (record.auth.type === "source-control" && credential.borrowed !== undefined) {
      return yield* replayBorrowed(record, record.auth, credential, send, refusedCredential, scope);
    }
    if (record.auth.type !== "oauth") {
      if (currentFingerprint !== undefined) {
        rejectedCredentialFingerprints.set(record.connectorId, currentFingerprint);
      }
      const rejectedMessage = refusedKeyMessage(record);
      yield* markStatus(
        record,
        "needs-credential",
        "The service rejected the stored credential.",
        rejectedMessage,
      );
      return {
        type: "rejected",
        message: rejectedMessage,
      } satisfies SendOutcome;
    }
    const refreshed = yield* refreshSession(record, credential.accessToken);
    if (refreshed.type === "lost" || refreshed.type === "rejected") {
      return refreshed satisfies SendOutcome;
    }
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
    const replaySecrets = [...credential.secrets, ...sessionSecrets(refreshed.session)];
    const replayVerdict = yield* refusedCredential(replay.value, replaySecrets);
    if (replayVerdict.refused) {
      yield* cancelBody(replay.value);
      // Only if the refused grant still owns the connector: a sign-in may have
      // committed while this replay was in flight.
      yield* markGrantLost(
        record.connectorId,
        refreshed.session.grantId,
        "The service no longer accepts this sign-in.",
        lostGrantMessage(record),
      );
      return { type: "rejected", message: lostGrantMessage(record) } satisfies SendOutcome;
    }
    return {
      type: "response",
      response: replay.value,
      secrets: replaySecrets,
      ...(replayVerdict.forbidden === undefined ? {} : { forbidden: replayVerdict.forbidden }),
    } satisfies SendOutcome;
  });

  /** Adding GitHub, whatever its sign-in, is the user's go to connect it again. */
  const withNewRecord = Effect.fn("ConnectorRuntime.withNewRecord")(function* (
    current: ConnectorStateData,
    record: ConnectorRecord,
  ) {
    if (current.connectors.length >= MAX_CONNECTORS) {
      return yield* extensionsError(
        "limit-reached",
        `Scient supports at most ${MAX_CONNECTORS} connected services.`,
      );
    }
    const duplicate = current.connectors.find((existing) => existing.url === record.url);
    if (duplicate) {
      return yield* extensionsError(
        "invalid-input",
        `This service is already connected as ${duplicate.displayName}.`,
      );
    }
    const serverName = uniqueServerName(
      record.serverName,
      new Set(current.connectors.map((existing) => existing.serverName)),
    );
    const created: ConnectorRecord = { ...record, serverName };
    const next: ConnectorStateData = {
      connectors: [...current.connectors, created],
      githubFromSourceControlDeclined:
        current.githubFromSourceControlDeclined && !isGitHubDestination(record.url),
    };
    return [created, next] as const;
  });

  const commitNewRecord = (record: ConnectorRecord) =>
    store.update((current) => withNewRecord(current, record));

  const newConnectorId = random
    .randomBytes(12)
    .pipe(
      Effect.map((bytes) => ConnectorId.make(`con_${Buffer.from(bytes).toString("base64url")}`)),
    );

  const checkUrl = (raw: string, policy: ConnectorEgressPolicy) => {
    const checked = checkConnectorUrl(raw, policy);
    return isConnectorEgressRejected(checked)
      ? Effect.fail(extensionsError("invalid-input", checked.message))
      : Effect.succeed(checked.href);
  };

  const probeFailure = (
    result: {
      readonly type: "not-an-mcp-server" | "unreachable" | "busy";
      readonly message: string;
    },
    name = "This service",
  ) =>
    extensionsError(
      result.type === "busy" ? "unreachable" : result.type,
      result.type === "busy" ? `${name} is busy right now. Try again in a minute.` : result.message,
    );

  const tooShort = (what: string) =>
    extensionsError(
      "invalid-input",
      `The ${what} is too short to be a credential (at least ${MIN_CREDENTIAL_LENGTH} characters).`,
    );

  /** GitHub with Source Control's account. Adding it again repoints the one already there. */
  const connectSourceControl = Effect.fn("ConnectorRuntime.connectSourceControl")(
    function* (input: {
      readonly url: string;
      readonly policy: ConnectorEgressPolicy;
      readonly source: ConnectorRecord["source"];
      readonly displayName: string;
      readonly description: string | undefined;
      readonly account: string | undefined;
      readonly agents: ConnectorRecord["agents"];
    }) {
      if (Option.isNone(github) || !isCredentialDestination(input.url, github.value.mcpUrl)) {
        return yield* extensionsError(
          "invalid-input",
          "Source Control's GitHub account connects only GitHub's own MCP server.",
        );
      }
      const source = github.value;
      const lent = yield* source
        .get("github.com", input.account === undefined ? undefined : { account: input.account })
        .pipe(Effect.mapError((error) => extensionsError("unreachable", error.message)));
      if (Option.isNone(lent)) {
        return yield* extensionsError(
          "sign-in-failed",
          input.account === undefined
            ? "Source Control has no GitHub account. Sign in with GitHub first."
            : `Source Control has no GitHub sign-in for ${input.account}.`,
        );
      }
      const probe = yield* Effect.promise((signal) =>
        probeConnector({
          signal,
          url: input.url,
          fetch: controlFetch(input.policy),
          headers: { authorization: `Bearer ${Redacted.value(lent.value.token)}` },
        }),
      );
      if (probe.type === "auth-required") {
        yield* source.invalidate("github.com", lent.value);
        return yield* extensionsError(
          "sign-in-failed",
          "GitHub refused Source Control's credential. Check the sign-in in Settings → Source Control.",
        );
      }
      if (probe.type !== "open") return yield* probeFailure(probe, input.displayName);
      const auth = {
        type: "source-control",
        host: "github.com",
        account: lent.value.login,
      } as const;
      const updatedAt = yield* isoNow;
      const record: ConnectorRecord = {
        connectorId: yield* newConnectorId,
        serverName: input.displayName,
        displayName: input.displayName,
        ...(input.description === undefined ? {} : { description: input.description }),
        url: input.url,
        source: input.source,
        auth,
        status: "connected",
        enabled: true,
        authRevision: 0,
        availability: { type: "all-projects" },
        ...(input.agents === undefined ? {} : { agents: input.agents }),
        createdAt: updatedAt,
        updatedAt,
      };
      const connected = yield* store.update((current) => {
        const existing = current.connectors.find(
          (entry) =>
            entry.auth.type === "source-control" &&
            isLive(entry.connectorId) &&
            isCredentialDestination(entry.url, source.mcpUrl),
        );
        if (existing === undefined) return withNewRecord(current, record);
        // On, off and the projects it reaches stay as the user left them.
        const repointed: ConnectorRecord = {
          ...existing,
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          auth,
          status: "connected",
          lastError: undefined,
          authRevision:
            existing.auth.type === "source-control" && existing.auth.account === auth.account
              ? existing.authRevision
              : existing.authRevision + 1,
          updatedAt,
        };
        return Effect.succeed([
          repointed,
          {
            connectors: current.connectors.map((entry) => (entry === existing ? repointed : entry)),
            githubFromSourceControlDeclined: false,
          },
        ] as const);
      });
      yield* publishChange;
      return {
        connector: yield* summaryOf(connected),
        nextStep: "ready",
      } satisfies ConnectorAddResult;
    },
  );

  /** The folder and keys first, then the record; a failed commit removes what was made. */
  const addLocal = Effect.fn("ConnectorRuntime.addLocal")(function* (
    input: Parameters<ConnectorRuntimeShape["add"]>[0],
    target: Extract<
      ConnectorAddInput["target"],
      {
        readonly type:
          | "local-bundle"
          | "local-command"
          | "local-package"
          | "local-import"
          | "registry-bundle";
      }
    >,
  ) {
    if ((yield* store.read).connectors.length >= MAX_CONNECTORS) {
      return yield* extensionsError(
        "limit-reached",
        `Scient supports at most ${MAX_CONNECTORS} connected services.`,
      );
    }
    const connectorId = yield* newConnectorId;
    const prepared = yield* localConnectors.prepare(connectorId, target, input.displayName);
    const createdAt = yield* isoNow;
    const description = input.description ?? prepared.description;
    const committed = yield* commitNewRecord({
      connectorId,
      serverName: prepared.displayName,
      displayName: prepared.displayName,
      ...(description === undefined ? {} : { description }),
      url: `scient-local:${connectorId}`,
      source:
        prepared.registry === undefined
          ? { type: "local" }
          : { type: "local", registry: prepared.registry },
      auth: { type: "none" },
      status: "connected",
      enabled: true,
      authRevision: 0,
      availability: { type: "all-projects" },
      ...(input.agents === undefined ? {} : { agents: input.agents }),
      createdAt,
      updatedAt: createdAt,
      local: { ...prepared.local, changedBy: input.changedBy ?? "you" },
    }).pipe(Effect.tapError(() => prepared.cleanup));
    yield* publishChange;
    return {
      connector: yield* summaryOf(committed),
      nextStep: "ready",
    } satisfies ConnectorAddResult;
  });

  const add: ConnectorRuntimeShape["add"] = Effect.fn("ConnectorRuntime.add")(function* (input) {
    const target = input.target;
    if (
      target.type === "local-bundle" ||
      target.type === "local-command" ||
      target.type === "local-package" ||
      target.type === "local-import" ||
      target.type === "registry-bundle"
    ) {
      return yield* addLocal(input, target);
    }
    const policy = egressPolicyFor(target.url, { type: target.type });
    const url = yield* checkUrl(target.url, policy);
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
      (target.type === "registry"
        ? (target.name.split("/").pop() ?? target.name)
        : new URL(url).hostname);
    if (
      curated?.id === "github" &&
      input.credential?.type !== "source-control" &&
      input.credential?.strategy !== "bearer"
    )
      return yield* extensionsError(
        "invalid-input",
        "Add GitHub with your Source Control account or a personal access token.",
      );
    const description = input.description ?? curated?.description;
    if (input.credential?.type === "source-control") {
      return yield* connectSourceControl({
        url,
        policy,
        source:
          target.type === "registry"
            ? { type: "registry", name: target.name, version: target.version }
            : { type: "url" },
        displayName,
        description,
        account: input.credential.account,
        agents: input.agents,
      });
    }
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
        storage: entered.type === "bound" ? "bound" : "owned",
        ...(entered.headerName === undefined ? {} : { headerName: entered.headerName }),
      } as const;
      const value =
        entered.type === "bound"
          ? Option.isSome(accounts)
            ? Redacted.value(
                yield* accounts.value
                  .resolveBound(entered.secretRef, {
                    kind: "connector",
                    connectorId,
                    origin: new URL(url).origin,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      extensionsError(
                        "invalid-input",
                        "This account key is unavailable for this service.",
                      ),
                    ),
                  ),
              )
            : yield* extensionsError("unsupported", "Accounts is unavailable on this server.")
          : entered.value;
      if (
        entered.type === "bound" &&
        !enteredSecrets(entered.strategy, value).every(isProtectableCredential)
      )
        return yield* tooShort("credential");
      const probe = yield* Effect.promise((signal) =>
        probeConnector({
          signal,
          url,
          fetch,
          headers: credentialHeadersFor(credentialAuth, value),
        }),
      );
      if (probe.type === "auth-required") {
        return yield* extensionsError("sign-in-failed", "The service rejected this credential.");
      }
      if (probe.type !== "open") return yield* probeFailure(probe, displayName);
      const credentialRef =
        entered.type === "bound"
          ? entered.secretRef
          : yield* credentials.put(owner, entered.strategy, new TextEncoder().encode(value), {
              label: `${displayName} credential`,
            });
      auth = { ...credentialAuth, credentialRef };
      status = "connected";
    } else {
      const probe = yield* Effect.promise((signal) => probeConnector({ url, fetch, signal }));
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
        return yield* probeFailure(probe, displayName);
      }
    }
    const record: ConnectorRecord = {
      connectorId,
      serverName: displayName,
      displayName,
      ...(description === undefined ? {} : { description }),
      url,
      source:
        target.type === "registry"
          ? { type: "registry", name: target.name, version: target.version }
          : { type: "url" },
      auth,
      status,
      enabled: true,
      authRevision: 0,
      availability: { type: "all-projects" },
      ...(input.agents === undefined ? {} : { agents: input.agents }),
      createdAt,
      updatedAt: createdAt,
    };
    // Credential first, then the record that refers to it; a failed record
    // commit removes the credential so nothing is left unreferenced.
    const created = yield* commitNewRecord(record).pipe(
      Effect.tapError(() =>
        "credentialRef" in auth &&
        auth.credentialRef !== undefined &&
        !(auth.type === "credential" && auth.storage === "bound")
          ? credentials.remove(auth.credentialRef).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    yield* publishChange;
    return {
      connector: yield* summaryOf(created),
      nextStep: status === "connected" ? "ready" : "sign-in-required",
    } satisfies ConnectorAddResult;
  });

  const removeRecord = Effect.fn("ConnectorRuntime.removeRecord")(function* (
    record: ConnectorRecord,
    options: { readonly keepCopy?: boolean } = {},
  ) {
    const connectorId = record.connectorId;
    // Fence first: in-flight refreshes, exchanges and proxied requests are
    // aborted and can no longer send, persist or keep what they obtain.
    removed.add(connectorId);
    lifetimes.get(connectorId)?.abort();
    flows.cancelConnector(connectorId);
    sessions.dropConnector(connectorId);
    yield* localHost.stop(connectorId, `${record.displayName} was removed in Scient.`);
    const committed = yield* lifecycle(connectorId)
      .withPermits(1)(
        Effect.gen(function* () {
          const oauth =
            oauthCache.get(connectorId) ??
            (yield* readStoredOAuth(record).pipe(Effect.orElseSucceed(() => undefined)));
          // Commit the removal before cleanup: the connector stops being
          // delivered and granted even if credential cleanup or revocation fails.
          // Removing GitHub, in the same write, keeps Source Control's account from coming back.
          yield* store.update((current) =>
            Effect.succeed([
              undefined,
              {
                connectors: current.connectors.filter((entry) => entry.connectorId !== connectorId),
                githubFromSourceControlDeclined:
                  current.githubFromSourceControlDeclined || isGitHubDestination(record.url),
              } satisfies ConnectorStateData,
            ] as const),
          );
          publishOAuth(connectorId, undefined);
          yield* publishChange;
          const ref =
            record.auth.type === "none" ||
            record.auth.type === "source-control" ||
            (record.auth.type === "credential" && record.auth.storage === "bound")
              ? undefined
              : record.auth.credentialRef;
          if (ref !== undefined) {
            yield* credentials
              .remove(ref)
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("connector credential could not be removed", { connectorId }),
                ),
              );
          }
          // Its keys are Accounts keys the user may use elsewhere, so they stay. A local connector's
          // folder and record are kept so Undo can bring it back.
          if (record.local !== undefined) {
            if (options.keepCopy === false) yield* localConnectors.discard(record.local);
            else yield* authoring.keepRemoved(record);
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
    refusedSignIns.delete(connectorId);
  });

  const startSignInSteps: ConnectorRuntimeShape["startSignIn"] = Effect.fn(
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
    const probe = yield* Effect.promise((signal) =>
      probeConnector({ url: record.url, fetch, signal }),
    );
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
    if (probe.type !== "auth-required") return yield* probeFailure(probe, record.displayName);
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
        isConnectorOAuthError(error)
          ? extensionsError(
              error.reason,
              curatedServerForUrl(record.url) && error.reason === "registration-unsupported"
                ? "Sign-in is not available for this service right now."
                : error.message,
            )
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

  // OAuth 2.0 authorization error codes (RFC 6749 §4.1.2.1, OIDC); any other is "service_error".
  const OAUTH_ERROR_CODES = new Set([
    "invalid_request",
    "unauthorized_client",
    "unsupported_response_type",
    "invalid_scope",
    "server_error",
    "temporarily_unavailable",
    "login_required",
    "consent_required",
    "interaction_required",
  ]);
  // How each sign-in ended, kept beside its result for the analytics wrapper below.
  const signInEnds = new WeakMap<object, { record?: ConnectorRecord; reason: string }>();
  const signInFailed = (
    displayName: string | undefined,
    message: string,
    reason: string,
    record?: ConnectorRecord,
  ) => {
    const result = { outcome: "failed" as const, displayName, message };
    signInEnds.set(result, { reason, ...(record === undefined ? {} : { record }) });
    return result;
  };

  const completeSignInSteps: ConnectorRuntimeShape["completeSignIn"] = Effect.fn(
    "ConnectorRuntime.completeSignIn",
  )(function* (query) {
    const claimed = query.state === undefined ? undefined : flows.claim(query.state);
    if (claimed === undefined) {
      return signInFailed(
        undefined,
        "This sign-in link is invalid or has expired. Start sign-in again from Scient.",
        "expired_link",
      );
    }
    const removedMessage = "This connected service was removed before sign-in finished.";
    const record = yield* findRecord(claimed.connectorId);
    if (record === undefined || record.auth.type !== "oauth" || !isLive(record.connectorId)) {
      return signInFailed(undefined, removedMessage, "removed");
    }
    const fail = (message: string, reason: string) =>
      markStatus(record, record.status, message).pipe(
        Effect.as(signInFailed(record.displayName, message, reason, record)),
      );
    if (query.error !== undefined) {
      const code = query.error.replace(/[^\w.-]/g, "").slice(0, 64);
      return yield* fail(
        code === "access_denied"
          ? "Sign-in was cancelled or denied."
          : `The service could not complete sign-in${code ? ` (${code})` : ""}.`,
        code === "access_denied"
          ? "denied"
          : OAUTH_ERROR_CODES.has(code)
            ? `service_${code}`
            : "service_error",
      );
    }
    if (query.code === undefined || query.code.length === 0) {
      return yield* fail("The service did not return an authorization code.", "no_code");
    }
    const code = query.code;
    const exchanged = yield* Effect.tryPromise({
      try: () => flows.complete(claimed, code),
      catch: (error) =>
        isConnectorOAuthError(error) ? error.message : "Sign-in could not be completed.",
    }).pipe(Effect.exit);
    if (Exit.isFailure(exchanged)) {
      if (!isLive(record.connectorId)) return signInFailed(undefined, removedMessage, "removed");
      return yield* fail(
        Option.getOrElse(Exit.findErrorOption(exchanged), () => "Sign-in could not be completed."),
        "exchange_failed",
      );
    }
    const result = exchanged.value;
    if (!sessionProtectable(result.session)) {
      // The service now issues credentials Scient cannot protect: the connector
      // needs a new sign-in whatever its previous status, and the grant is revoked.
      yield* revokeLater(record, result.session);
      yield* markStatus(record, "needs-auth", UNPROTECTABLE_GRANT);
      return signInFailed(record.displayName, UNPROTECTABLE_GRANT, "unprotectable", record);
    }
    // Commit under the lifecycle lock, so a refresh of the previous grant or a
    // disconnect cannot interleave; anything that loses the race is revoked.
    return yield* lifecycle(record.connectorId).withPermits(1)(
      Effect.gen(function* () {
        const current = yield* findRecord(record.connectorId);
        if (current === undefined || current.auth.type !== "oauth" || !isLive(record.connectorId)) {
          yield* revokeLater(record, result.session);
          return signInFailed(undefined, removedMessage, "removed");
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
          return yield* fail("The sign-in could not be saved.", "save_failed");
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
        })).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              sessions.dropConnector(record.connectorId);
              refusedSignIns.delete(record.connectorId);
              rejectedCredentialFingerprints.delete(record.connectorId);
            }),
          ),
          Effect.exit,
        );
        if (Exit.isFailure(updated)) {
          yield* revokeLater(record, session);
          // Only a credential created by this sign-in is discarded; an existing one keeps its client.
          if (saved.value.ref !== previousRef) {
            yield* credentials.remove(saved.value.ref).pipe(Effect.ignore);
          }
          return signInFailed(
            record.displayName,
            "The sign-in could not be saved.",
            "save_failed",
            record,
          );
        }
        if (previousRef !== undefined && previousRef !== saved.value.ref) {
          // The previous entry could not be read, so a new one replaced it.
          yield* credentials.remove(previousRef).pipe(Effect.ignore);
        }
        publishOAuth(record.connectorId, { material, version: saved.value.version });
        const connected = {
          outcome: "connected" as const,
          displayName: record.displayName,
          message: `${record.displayName} is connected. You can close this tab and return to Scient.`,
        };
        signInEnds.set(connected, { reason: "connected", record });
        return connected;
      }),
    );
  });

  /** Sign-ins people start, and how each one ended: connected, or why it did not. */
  const startSignIn: ConnectorRuntimeShape["startSignIn"] = (input) =>
    findRecord(input.connectorId).pipe(
      Effect.flatMap((record) =>
        startSignInSteps(input).pipe(
          Effect.onExit((exit) =>
            record === undefined
              ? Effect.void
              : recordExtensionEvents([
                  {
                    name: "extension.sign_in.started",
                    properties: {
                      owner: "scient",
                      ...connectorFacts(record),
                      outcome: Exit.isSuccess(exit) ? "ok" : "error",
                      ...(Exit.isSuccess(exit)
                        ? {}
                        : {
                            failureClass: Option.match(Exit.findErrorOption(exit), {
                              onNone: () => "unknown",
                              onSome: (error) => error.reason,
                            }),
                          }),
                    },
                  },
                ]),
          ),
        ),
      ),
    );
  const completeSignIn: ConnectorRuntimeShape["completeSignIn"] = (query) =>
    completeSignInSteps(query).pipe(
      Effect.tap((result) => {
        const end = signInEnds.get(result);
        return recordExtensionEvents([
          {
            name: "extension.sign_in.finished",
            properties: {
              owner: "scient",
              ...(end?.record === undefined ? {} : connectorFacts(end.record)),
              outcome: result.outcome === "connected" ? "ok" : "error",
              reason: (end?.reason ?? "unknown").replace(/[^\w.-]/g, "").slice(0, 64),
            },
          },
        ]);
      }),
    );

  const test: ConnectorRuntimeShape["test"] = Effect.fn("ConnectorRuntime.test")(function* (input) {
    const record = yield* requireRecord(input.connectorId);
    const checkedAt = yield* isoNow;
    const localLocation =
      input.location?.projectId === undefined
        ? undefined
        : { projectId: input.location.projectId, worktreePath: input.location.worktreePath };
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
    // An agent that was not chosen learns nothing about it, not even that it needs a sign-in; a
    // plain check of one that is merely off still works, as before.
    if (!isForAgent(record, input.location?.providerInstanceId))
      return result("error", NOT_FOR_THIS_AGENT);
    if (record.status === "needs-auth") return result("needs-auth", "Sign in to use this service.");
    // Calling its tools is using it: only where a chat would get it (on, eligible, this project).
    if ((input.calls?.length ?? 0) > 0) {
      const unusable = yield* unusableIn(
        record,
        input.location?.projectId,
        false,
        input.location?.providerInstanceId,
      );
      if (unusable !== undefined) return result("error", unusable);
    }
    if (record.local !== undefined) {
      const local = (yield* summaryOf(record)).local;
      if (local?.problem !== undefined) return result("error", local.problem);
      if (local !== undefined && local.missing.length > 0) {
        return result("needs-setup", `Needs ${local.missing.join(", ")}.`);
      }
      // What the caller's project may use: a sign-in or key scoped elsewhere is missing here.
      const ready = yield* localConnectors
        .start(record, record.serverName, localLocation, { checking: true })
        .pipe(Effect.result);
      if (ready._tag === "Success" && ready.success.missing.length > 0)
        return result("needs-setup", `Needs ${ready.success.missing.join(", ")}.`);
    }
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
      if (record.local !== undefined) {
        const method = init?.method ?? "GET";
        const body = init?.body;
        const outcome = await run(
          exchangeLocal(
            record,
            {
              method: method === "POST" || method === "DELETE" ? method : "GET",
              sessionId: headers["mcp-session-id"],
              body: typeof body === "string" ? new TextEncoder().encode(body) : undefined,
              signal: init?.signal ?? new AbortController().signal,
            },
            localLocation,
          ),
        );
        applied.push(...outcome.secrets);
        return outcome.response;
      }
      const outcome: SendOutcome = await run(
        sendAuthorized(
          record,
          {
            method: init?.method ?? "GET",
            headers,
            body: init?.body as string | undefined,
            signal: init?.signal ?? undefined,
          },
          (_url, requestInit) => fetch(url, requestInit),
          undefined,
          true,
        ),
      );
      if (outcome.type === "response") {
        applied.push(...outcome.secrets);
        {
          const classified = outcome.forbidden;
          if (classified === "insufficient-scope") {
            void outcome.response.body?.cancel().catch(() => undefined);
            const scopeMessage = `${record.displayName} needs additional permissions (insufficient scope). Check the account or reconnect in Settings → Extensions.`;
            await run(markStatus(record, record.status, scopeMessage));
            throw new ConnectorUnavailableError({ kind: "failed", message: scopeMessage });
          }
        }
        return outcome.response;
      }
      if (outcome.type === "rejected") {
        void outcome.response?.body?.cancel().catch(() => undefined);
        // A refused sign-in reads as needing sign-in; a refused key names what refused it.
        throw new ConnectorUnavailableError({
          kind: record.auth.type === "oauth" ? "lost" : "failed",
          message: outcome.message,
        });
      }
      throw new ConnectorUnavailableError({ kind: outcome.type, message: outcome.message });
    };
    // Server-provided text reaches the settings UI and agents; a reflected credential must not.
    const credentialsNow = () =>
      record.local === undefined
        ? credentialSet(applied)
        : localConnectors.credentialsFor(record.connectorId);
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
            calls:
              input.calls === undefined
                ? undefined
                : await callTools(client, input.calls, credentialsNow),
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
      if (isConnectorUnavailableError(error)) {
        return error.kind === "lost"
          ? result("needs-auth", "Sign in again to use this service.")
          : result("unreachable", error.message);
      }
      if (isConnectorEgressRejected(error) || error instanceof TypeError) {
        return result("unreachable", describeEgressFailure(error));
      }
      // Scient writes a local program's start and stop failures for people; the program's own
      // error text may still carry its key or session.
      if (record.local !== undefined && error instanceof Error) {
        const message = redactText(
          error.message,
          localConnectors.credentialsFor(record.connectorId),
        )
          .replace(/^MCP error -?\d+: /, "")
          .trim();
        if (message.length > 0) return result("error", message);
      }
      return result("error", "The service did not complete the MCP handshake and tool listing.");
    }
    // The person checked a refused key and the service took it: deliver it again.
    if (
      record.status === "needs-credential" &&
      (record.auth.type === "credential" || record.auth.type === "source-control")
    ) {
      rejectedCredentialFingerprints.delete(record.connectorId);
      yield* markConnected(record);
    } else if (record.lastError !== undefined) {
      yield* updateRecord(record.connectorId, (current, updatedAt) => ({
        ...current,
        lastError: undefined,
        updatedAt,
      })).pipe(Effect.ignore);
    }
    const credentials = credentialsNow();
    const clean = (text: string | undefined) => {
      const trimmed = text === undefined ? "" : redactText(text, credentials).trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const serverName = clean(listed.value.serverName);
    const serverVersion = clean(listed.value.serverVersion);
    return {
      ...result("ok"),
      ...(serverName === undefined ? {} : { serverName }),
      ...(serverVersion === undefined ? {} : { serverVersion }),
      ...(listed.value.calls === undefined ? {} : { calls: listed.value.calls }),
      tools: listed.value.tools.flatMap((tool) => {
        const name = clean(tool.name);
        if (name === undefined) return [];
        const title = clean(tool.title);
        const parameters = extractToolParameters(tool.inputSchema, (text) =>
          redactText(text, credentials),
        );
        return [
          {
            name,
            ...(parameters === undefined ? {} : { parameters }),
            ...(title === undefined ? {} : { title }),
            ...(tool.description === undefined
              ? {}
              : { description: redactText(tool.description, credentials) }),
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

  /**
   * Follows Source Control: connects GitHub with its account unless GitHub is there or the user
   * removed it, and moves Source Control connectors between connected and needs-credential.
   * Never changes whether a connector is on or which projects receive it.
   */
  const followSourceControl = Effect.fn("ConnectorRuntime.followSourceControl")(function* () {
    if (Option.isNone(github)) return;
    const source = github.value;
    const state = yield* store.read;
    if (!state.writable) return;
    const present = state.connectors.filter((record) =>
      isCredentialDestination(record.url, source.mcpUrl),
    );
    for (const record of present) {
      if (record.auth.type !== "source-control" || !isLive(record.connectorId)) continue;
      const lent = yield* source
        .get(record.auth.host, { account: record.auth.account })
        .pipe(Effect.option);
      // Source Control could not answer just now: leave the status as it is.
      if (Option.isNone(lent)) continue;
      if (Option.isSome(lent.value)) {
        const borrowedFp = secretFingerprint([Redacted.value(lent.value.value.token)]);
        const rejectedFp = rejectedCredentialFingerprints.get(record.connectorId);
        if (rejectedFp === undefined || rejectedFp !== borrowedFp) {
          rejectedCredentialFingerprints.delete(record.connectorId);
          if (record.status !== "connected") yield* markConnected(record);
        }
      } else if (record.status === "connected") {
        yield* markStatus(record, "needs-credential", accountGone(record.auth.account));
      }
    }
    if (present.length > 0 || state.githubFromSourceControlDeclined) return;
    const lent = yield* source.get("github.com").pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(lent)) return;
    const curated = curatedServerForUrl(source.mcpUrl);
    const displayName = curated?.displayName ?? "GitHub";
    const createdAt = yield* isoNow;
    const record: ConnectorRecord = {
      connectorId: yield* newConnectorId,
      serverName: displayName,
      displayName,
      ...(curated?.description === undefined ? {} : { description: curated.description }),
      url: source.mcpUrl,
      source:
        curated?.registry === undefined
          ? { type: "url" }
          : { type: "registry", name: curated.registry.name, version: curated.registry.version },
      auth: { type: "source-control", host: "github.com", account: lent.value.login },
      status: "connected",
      enabled: true,
      authRevision: 0,
      availability: { type: "all-projects" },
      createdAt,
      updatedAt: createdAt,
    };
    // Checked again inside the write, so a removal that got there first wins.
    const created = yield* store
      .update((current) =>
        current.githubFromSourceControlDeclined ||
        current.connectors.some((entry) => isCredentialDestination(entry.url, source.mcpUrl))
          ? Effect.succeed([false, current] as const)
          : withNewRecord(current, record).pipe(Effect.map(([, next]) => [true, next] as const)),
      )
      .pipe(Effect.orElseSucceed(() => false));
    if (created) yield* publishChange;
  });

  let followedAt = Number.NEGATIVE_INFINITY;
  const followLock = Semaphore.makeUnsafe(1);
  const followSourceControlNow = followLock.withPermits(1)(
    Effect.suspend(() => {
      if (now() - followedAt < FOLLOW_SOURCE_CONTROL_MS) return Effect.void;
      followedAt = now();
      return followSourceControl();
    }),
  );

  /**
   * The agent's session is gone. A program Scient runs takes its session down when it stops, so
   * the agent's discovery meets the empty server, as on a new session (some agents end the whole
   * turn on a 404 here); anything else hears the session is gone and starts a new one.
   */
  const sessionGone = Effect.fn("ConnectorRuntime.sessionGone")(function* (
    record: ConnectorRecord,
    request: Pick<ConnectorForwardRequest, "body">,
  ) {
    const stopped =
      record.local === undefined
        ? undefined
        : unavailableDiscoveryAnswer(
            discoveryRequestOf(request.body),
            (yield* summaryOf(record)).local?.problem ?? `${record.displayName} stopped running.`,
          );
    if (stopped === undefined) return sessionNotFound;
    return stopped.status === 202
      ? ({ status: 202, headers: {}, body: Stream.empty } satisfies ConnectorForwardResponse)
      : ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Stream.make(new TextEncoder().encode(stopped.json)),
        } satisfies ConnectorForwardResponse);
  });

  const forward: ConnectorRuntimeShape["forward"] = Effect.fn("ConnectorRuntime.forward")(
    function* (request) {
      const state = yield* store.read;
      const record =
        state.connectors.find((entry) => entry.connectorId === request.connectorId) ??
        pluginHttp.get(request.connectorId)?.record;
      const rpc = request.method === "POST" ? parseRpcRequest(request.body) : {};
      const correlationId = yield* random.uuidV4();
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
      // Which connector agents actually use: one event per tool call, with what the agent got.
      const recordToolCall = (
        outcome: "ok" | "error" | "denied",
        detail: { readonly failureClass?: string; readonly httpStatus?: number } = {},
      ) =>
        record !== undefined && rpc.method === "tools/call" && rpc.toolName !== undefined
          ? recordExtensionEvents([
              {
                name: "extension.tool.called",
                properties: {
                  owner: "scient",
                  ...connectorFacts(record),
                  tool: rpc.toolName.slice(0, 128),
                  outcome,
                  status: record.status,
                  ...(request.scope.thread === undefined
                    ? {}
                    : { callerProviderInstance: request.scope.thread.providerInstanceId }),
                  ...detail,
                },
              },
            ])
          : Effect.void;
      const usable =
        record !== undefined &&
        isLive(record.connectorId) &&
        record.enabled &&
        (yield* isPluginEligible(record));
      if (!usable || record.status !== "connected") {
        yield* recordToolUse("denied");
        yield* recordToolCall("denied", {
          failureClass: usable
            ? record.status
            : record?.enabled === false
              ? "disabled"
              : "unavailable",
        });
        // A sign-in the service refused stays the person's to fix: discovery keeps failing.
        const refused = usable ? standingRefusal(record) : undefined;
        if (refused !== undefined) return credentialRefusal(request, refused);
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
        if (upstreamSessionId === undefined) {
          yield* recordToolCall("error", { failureClass: "session_gone" });
          return yield* sessionGone(record, request);
        }
      }

      const permits = semaphoreFor(inFlight, record.connectorId, MAX_IN_FLIGHT_PER_CONNECTOR);
      if (!(yield* Semaphore.takeIfAvailable(permits, 1))) {
        yield* recordToolCall("error", { failureClass: "busy" });
        return refusal(
          request,
          `${record.displayName} has too many requests in progress. Retry shortly.`,
          503,
          "connector_busy",
        );
      }
      // @effect-diagnostics-next-line abortControllerInEffect:off - The returned body owns this exchange beyond the request fiber; release aborts it on body completion or cancellation.
      const exchange = new AbortController();
      let released = false;
      const release = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        exchange.abort();
        return Semaphore.release(permits, 1).pipe(Effect.asVoid);
      });

      const outcome: SendOutcome =
        record.local === undefined
          ? yield* sendAuthorized(
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
              request.scope,
            ).pipe(Effect.onInterrupt(() => release))
          : yield* exchangeLocal(
              record,
              {
                method: request.method,
                sessionId: upstreamSessionId,
                body: request.body,
                signal: exchange.signal,
              },
              request.location,
            ).pipe(Effect.onInterrupt(() => release));
      if (outcome.type !== "response") {
        yield* release;
        if (outcome.type === "rejected" && outcome.response !== undefined) {
          const refused = outcome.response;
          // release aborts the socket before best-effort disposal. A vendor may leave its
          // 401 body open; the agent's auth error must not wait for EOF or cancellation.
          yield* Effect.sync(() => {
            void refused.body?.cancel().catch(() => undefined);
          });
        }
        yield* recordToolUse(outcome.type === "lost" ? "denied" : "allowed", "error");
        yield* recordToolCall("error", { failureClass: outcome.type });
        // A refused key, Source Control token or sign-in is the user's to fix, so the agent's
        // session hears it fail; a connector that is gone or a failed transport meets the empty
        // server.
        return outcome.type === "rejected"
          ? credentialRefusal(request, outcome.message)
          : connectorUnavailableResponse(request, outcome.message);
      }
      const response = outcome.response;
      yield* recordToolUse("allowed", response.ok ? "ok" : "error");
      // A 200 that is not an MCP answer reaches the agent as an error (below), so it is one here.
      const answerType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const mcpAnswer =
        answerType.includes("text/event-stream") || answerType.includes("application/json");
      yield* recordToolCall(
        response.ok && mcpAnswer ? "ok" : "error",
        response.ok
          ? mcpAnswer
            ? {}
            : { failureClass: "not_mcp" }
          : { failureClass: "http", httpStatus: response.status },
      );
      const settle = (result: ConnectorForwardResponse) =>
        cancelBody(response).pipe(Effect.andThen(release), Effect.as(result));

      if (response.status === 404 && proxySessionId !== undefined) {
        sessions.drop(proxySessionId);
        return yield* settle(yield* sessionGone(record, request));
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
        const message = response.ok
          ? `${record.displayName} did not answer like an MCP server.`
          : `${record.displayName} answered with HTTP ${response.status}.`;
        // Insufficient scope reports permissions and keeps the grant; any other 403 is the
        // service's answer.
        if (outcome.forbidden === "insufficient-scope") {
          const scopeMessage = `${record.displayName} needs additional permissions (insufficient scope). Check the account or permissions in Settings → Extensions.`;
          const discovery = discoveryRequestOf(request.body);
          if (
            discovery !== undefined &&
            discovery.method !== "tools/call" &&
            !pluginHttp.has(record.connectorId)
          ) {
            yield* markStatus(record, record.status, scopeMessage);
          }
          return yield* settle(credentialRefusal(request, scopeMessage));
        }
        return yield* settle(refusal(request, message, 502, "connector_error"));
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
        get credentials() {
          return outcome.live?.() ?? credentialSet(outcome.secrets);
        },
        agentIds:
          request.body === undefined
            ? new Set()
            : agentRequestIds(new TextDecoder().decode(request.body)),
        refusal: errorMessageFor(
          request.body,
          `${record.displayName} sent a response Scient could not verify, so it was withheld.`,
        ),
        finish: discoveryFinisher(discoveryRequestOf(request.body), {
          displayName: record.displayName,
          host: record.local === undefined ? connectorHostOf(record.url) : undefined,
        }),
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
    pluginKeyRefusals: Effect.fn("ConnectorRuntime.pluginKeyRefusals")(() =>
      Effect.sync(() =>
        [...pluginHttp.values()].flatMap(({ record }) =>
          rejectedCredentialFingerprints.has(record.connectorId)
            ? [
                {
                  connectorId: record.connectorId,
                  serverName: record.serverName,
                  displayName: record.displayName,
                  message: pluginKeyRefusalMessage(record),
                },
              ]
            : [],
        ),
      ),
    ),
    registerPluginKeyHttp: Effect.fn("ConnectorRuntime.registerPluginKeyHttp")(function* (input) {
      if (!pluginHttp.has(input.connectorId) && pluginHttp.size >= 1000)
        return yield* new ExtensionsError({
          reason: "limit-reached",
          message:
            "Plugin server registrations reached their session limit. Restart Scient to release unused registrations.",
        });
      const url = yield* checkUrl(input.url, STRICT_EGRESS_POLICY);
      // Accounts changed since a key was refused: the provider reloads the tools so its next
      // request compares the bound value; the same refused value still never leaves.
      if (rejectedCredentialFingerprints.has(input.connectorId)) {
        const bindingRevision = yield* accountsBindingRevision;
        if (
          bindingRevision === undefined ||
          bindingRevision !== pluginRefusalBindingRevisions.get(input.connectorId)
        ) {
          pluginRefusalBindingRevisions.set(input.connectorId, bindingRevision);
          bumpPluginKeyRevision(input.connectorId);
        }
      }
      const createdAt = yield* isoNow;
      const record: ConnectorRecord = {
        connectorId: input.connectorId,
        serverName: input.serverName,
        displayName: input.displayName,
        url,
        source: { type: "url" },
        auth: { type: "none" },
        status: "connected",
        enabled: true,
        authRevision: pluginKeyRevisions.get(input.connectorId) ?? 0,
        availability: input.projectId
          ? { type: "projects", projectIds: [input.projectId] }
          : { type: "all-projects" },
        createdAt,
        updatedAt: createdAt,
      };
      pluginHttp.set(input.connectorId, { record, authorize: input.authorize });
      return eligibleOf(record);
    }),
    list: Effect.fn("ConnectorRuntime.list")(function* () {
      yield* followSourceControlNow;
      const state = yield* store.read;
      return {
        revision: yield* Ref.get(revision),
        connectors: yield* Effect.forEach(
          state.connectors,
          summarizeWith(yield* keyNamesFor(state.connectors)),
        ),
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
      const restarts = input.restart === true || input.localSetup !== undefined;
      const commit = Effect.gen(function* () {
        let local: ConnectorRecord["local"];
        if (input.localSetup !== undefined) {
          const record = yield* requireRecord(input.connectorId);
          if (record.local === undefined) {
            return yield* extensionsError("invalid-input", "Only local connectors have setup.");
          }
          local = yield* localConnectors.setup(record, input.localSetup);
        }
        yield* updateRecord(input.connectorId, (current, updatedAt) => {
          const nextLocal = local ?? current.local;
          // null gives it to every agent again; a list keeps each agent once.
          const { agents: _previous, ...base } = current;
          const agents =
            input.agents === undefined
              ? current.agents
              : input.agents === null
                ? undefined
                : [...new Set(input.agents)];
          return {
            ...base,
            ...(agents === undefined ? {} : { agents }),
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(availability === undefined ? {} : { availability }),
            // A restart asked for after the person signed in starts with the new session.
            ...(nextLocal === undefined
              ? {}
              : {
                  local:
                    input.restart === true && nextLocal.signInNeedsUser
                      ? (({ signInNeedsUser: _dropped, ...rest }) => rest)(nextLocal)
                      : nextLocal,
                }),
            ...(restarts ? { lastError: undefined } : {}),
            updatedAt,
          };
        });
      });
      // New setup is one more change to the connector's folder record: never inside a save.
      yield* input.localSetup === undefined
        ? commit
        : authoring.exclusive(input.connectorId)(commit);
      // Turned off, the person has dealt with the refused sign-in: it meets the empty server.
      // Under the lifecycle lock, so a refresh already running when it was turned off (which
      // publishes its refusal under that lock) settles first and cannot bring the refusal back.
      if (input.enabled === false) {
        yield* lifecycle(input.connectorId).withPermits(1)(
          Effect.sync(() => {
            refusedSignIns.delete(input.connectorId);
            rejectedCredentialFingerprints.delete(input.connectorId);
          }),
        );
      }
      // Turned off, set up again or restarted: running copies stop; the next request starts anew.
      if (restarts || input.enabled === false) {
        yield* localHost.stop(
          input.connectorId,
          input.enabled === false ? "This connector was turned off in Scient." : "Restarting.",
        );
      }
    }),
    remove: Effect.fn("ConnectorRuntime.remove")(function* (input) {
      yield* authoring.exclusive(input.connectorId)(
        Effect.flatMap(requireRecord(input.connectorId), (record) => removeRecord(record)),
      );
    }),
    copyForAgent: Effect.fn("ConnectorRuntime.copyForAgent")(function* (input) {
      const { variant: _variant, ...copied } = yield* observed("connectors.agent.copy")(
        authoring.copy(input),
        (result) => ({ variant: result.variant }),
      );
      return copied;
    }),
    checkFolder: Effect.fn("ConnectorRuntime.checkFolder")(function* (input, location) {
      return yield* observed("connectors.agent.check", {
        variant: input.connector === undefined ? "new" : "fix",
      })(authoring.check(input, location), (checked) => ({
        checked: checked.ok,
        tools: checked.tools.length,
        missing: checked.missing.length,
        calls: checked.calls.length,
      }));
    }),
    saveFolder: Effect.fn("ConnectorRuntime.saveFolder")(function* (input, location) {
      const saved = yield* observed("connectors.agent.save")(
        authoring.save(input, location),
        (result) => ({
          variant: result.variant,
          tools: result.tools.length,
          missing: result.summary.local?.missing.length ?? 0,
        }),
      );
      return { connector: saved.summary, tools: saved.tools };
    }),
    undo: Effect.fn("ConnectorRuntime.undo")(function* (input) {
      yield* observed("connectors.undo")(authoring.undo(input.connectorId), (undone) => ({
        variant: undone.kind,
      }));
    }),
    exportLocal: Effect.fn("ConnectorRuntime.exportLocal")(function* (input) {
      return yield* observed("connectors.export")(authoring.exportBundle(input.connectorId));
    }),
    test,
    inspectLocal: localConnectors.inspect,
    importables: Effect.fn("ConnectorRuntime.importables")(function* () {
      return { servers: yield* localConnectors.importables((yield* store.read).connectors) };
    }),
    resolveDelivery: Effect.fn("ConnectorRuntime.resolveDelivery")(function* (input) {
      yield* followSourceControlNow;
      const initial = yield* store.read;
      // A key refused in this process that changed since under the same reference is delivered
      // again; an unchanged one waits for the person to update or check it.
      for (const record of initial.connectors) {
        if (
          record.status === "needs-credential" &&
          record.auth.type === "credential" &&
          rejectedCredentialFingerprints.has(record.connectorId)
        ) {
          const resolved = yield* credentialFor(record);
          if (resolved.type === "ok") {
            const fp = secretFingerprint(resolved.secrets);
            if (fp !== rejectedCredentialFingerprints.get(record.connectorId)) {
              rejectedCredentialFingerprints.delete(record.connectorId);
              yield* markConnected(record);
            }
          }
        }
      }
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
              : !isForAgent(record, input.providerInstanceId)
                ? "agent-deselected"
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
      const record =
        state.connectors.find((entry) => entry.connectorId === input.connectorId) ??
        pluginHttp.get(input.connectorId)?.record;
      return (
        record !== undefined &&
        isLive(record.connectorId) &&
        record.enabled &&
        isAvailableIn(record, input.projectId) &&
        isForAgent(record, input.providerInstanceId) &&
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
    return yield* makeConnectorRuntime({
      stateDir: config.stateDir,
      secretsDir: config.secretsDir,
    });
  }),
).pipe(Layer.provide(LocalDuplexProcess.layer));
