// @effect-diagnostics nodeBuiltinImport:off -- Promise-based OAuth flow state for the MCP SDK.
/**
 * Keep sign-in state/verifiers server-only, single-claim, bounded, and expiring. Register clients
 * per issuer/redirect URI and use PKCE S256 plus the resource indicator.
 */
import * as NodeCrypto from "node:crypto";

import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  OAuthError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { type ConnectorFetch, ConnectorEgressRejected } from "./ConnectorOutbound.ts";
import { isProtectableCredential } from "./ConnectorRedaction.ts";

export const CONNECTOR_OAUTH_CALLBACK_PATH = "/oauth/connectors/callback";
const PENDING_SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SIGN_INS = 16;

const ClientInformation = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter((value) => typeof value.client_id === "string" && value.client_id.length > 0),
);

const OAuthSessionSchema = Schema.Struct({
  /**
   * Identifies one sign-in. Refreshes keep it; a new sign-in replaces it, so a
   * refresh that started under an older grant can tell it was superseded.
   */
  grantId: Schema.String,
  authorizationServerUrl: Schema.String,
  authorizationServerMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** RFC 8707 resource, sent on every token and refresh request. */
  resource: Schema.String,
  issuer: Schema.String,
  redirectUri: Schema.String,
  client: ClientInformation,
  accessToken: Schema.String,
  tokenType: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  /** Epoch milliseconds. */
  expiresAt: Schema.optional(Schema.Number),
});

const OAuthMaterialSchema = Schema.Struct({
  format: Schema.Literal(1),
  ownClient: Schema.optional(
    Schema.Struct({ clientId: Schema.String, clientSecret: Schema.optional(Schema.String) }),
  ),
  registrations: Schema.Array(
    Schema.Struct({ issuer: Schema.String, redirectUri: Schema.String, client: ClientInformation }),
  ),
  session: Schema.optional(OAuthSessionSchema),
});
const OAuthMaterialJson = Schema.fromJsonString(OAuthMaterialSchema);
const decodeMaterialJson = Schema.decodeUnknownExit(OAuthMaterialJson);
const encodeMaterialJson = Schema.encodeSync(OAuthMaterialJson);

export type ConnectorOAuthSession = typeof OAuthSessionSchema.Type;
export type ConnectorOAuthMaterial = typeof OAuthMaterialSchema.Type;

export const emptyOAuthMaterial: ConnectorOAuthMaterial = { format: 1, registrations: [] };

export const encodeOAuthMaterial = (material: ConnectorOAuthMaterial): Uint8Array =>
  new TextEncoder().encode(encodeMaterialJson(material));

export const decodeOAuthMaterial = (bytes: Uint8Array): ConnectorOAuthMaterial | undefined => {
  const decoded = decodeMaterialJson(new TextDecoder().decode(bytes));
  return Exit.isSuccess(decoded) ? decoded.value : undefined;
};

const asClientInformation = (client: Readonly<Record<string, unknown>>) =>
  client as unknown as OAuthClientInformationMixed;

export class ConnectorOAuthError extends Error {
  override readonly name = "ConnectorOAuthError";
  readonly reason: "limit-reached" | "registration-unsupported" | "sign-in-failed" | "unreachable";
  constructor(reason: ConnectorOAuthError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const STANDARD_OAUTH_ERRORS: Readonly<Record<string, true>> = {
  invalid_request: true,
  invalid_client: true,
  invalid_grant: true,
  unauthorized_client: true,
  unsupported_grant_type: true,
  invalid_scope: true,
  access_denied: true,
  server_error: true,
  temporarily_unavailable: true,
  unsupported_response_type: true,
  invalid_client_metadata: true,
  invalid_target: true,
};

/**
 * RFC 8707: every authorization, token and refresh request names the connector
 * as its resource. An advertised protected-resource `resource` must match the
 * connector address; without protected-resource metadata the canonical
 * connector URL is used, never nothing.
 */
const validateResource = async (serverUrl: string | URL, advertised?: string): Promise<URL> => {
  const canonical = resourceUrlFromServerUrl(serverUrl);
  if (advertised === undefined) return canonical;
  if (!checkResourceAllowed({ requestedResource: canonical, configuredResource: advertised })) {
    throw new ConnectorOAuthError(
      "sign-in-failed",
      "The service advertised a protected resource that does not match its address.",
    );
  }
  return new URL(advertised);
};

/** Refresh or exchange failures that mean the grant is gone, not a transient fault. */
export const isGrantLost = (error: unknown): boolean =>
  error instanceof InvalidGrantError ||
  error instanceof InvalidClientError ||
  error instanceof UnauthorizedClientError;

const classifyFailure = (error: unknown, fallback: string): ConnectorOAuthError => {
  if (error instanceof ConnectorOAuthError) return error;
  if (error instanceof ConnectorEgressRejected) {
    return new ConnectorOAuthError("unreachable", error.message);
  }
  if (
    error instanceof Error &&
    error.message.includes("does not support dynamic client registration")
  ) {
    return new ConnectorOAuthError(
      "registration-unsupported",
      "This service does not support automatic client registration. Add it again with your own OAuth client ID.",
    );
  }
  if (error instanceof OAuthError) {
    // Only standard codes are echoed; vendor-chosen text never reaches messages.
    const code = STANDARD_OAUTH_ERRORS[error.errorCode] === true ? ` (${error.errorCode})` : "";
    return new ConnectorOAuthError("sign-in-failed", `${fallback}${code}.`);
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) {
    return new ConnectorOAuthError("unreachable", "The sign-in server could not be reached.");
  }
  return new ConnectorOAuthError("sign-in-failed", `${fallback}.`);
};

/**
 * Accepts only `http://127.0.0.1|localhost|[::1]:<port>` or an `https` origin,
 * exactly (no path, query, fragment or credentials). Returns the normalized origin.
 */
export const normalizeCallbackOrigin = (raw: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    raw.replace(/\/$/, "") !== url.origin
  ) {
    return undefined;
  }
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol === "http:" &&
    url.port !== "" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  ) {
    return url.origin;
  }
  return undefined;
};

const sessionFromTokens = (input: {
  readonly tokens: OAuthTokens;
  readonly now: number;
  readonly previous?: ConnectorOAuthSession;
  readonly base: Omit<
    ConnectorOAuthSession,
    "accessToken" | "tokenType" | "refreshToken" | "scope" | "expiresAt"
  >;
}): ConnectorOAuthSession => {
  const refreshToken = input.tokens.refresh_token ?? input.previous?.refreshToken;
  const scope = input.tokens.scope ?? input.previous?.scope;
  return {
    ...input.base,
    accessToken: input.tokens.access_token,
    tokenType: input.tokens.token_type,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(scope === undefined ? {} : { scope }),
    ...(input.tokens.expires_in === undefined
      ? {}
      : { expiresAt: input.now + input.tokens.expires_in * 1_000 }),
  };
};

/** The outcome of a completed code exchange, merged into material by the caller. */
export interface ConnectorSignInResult {
  readonly session: ConnectorOAuthSession;
  /** A client registered by this flow, stored per `(issuer, redirect_uri)`. */
  readonly registration:
    | {
        readonly issuer: string;
        readonly redirectUri: string;
        readonly client: Readonly<Record<string, unknown>>;
      }
    | undefined;
}

/** A stored client is usable only without a secret or with one Scient can protect. */
const hasProtectableSecret = (client: Readonly<Record<string, unknown>>) =>
  typeof client.client_secret !== "string" || isProtectableCredential(client.client_secret);

/**
 * The material a successful sign-in commits. Registrations whose secret is too
 * short are retired at every issuer and redirect URI (not only the one just
 * used), so legacy material can never block the new grant.
 */
export const applySignIn = (
  material: ConnectorOAuthMaterial,
  result: ConnectorSignInResult,
): ConnectorOAuthMaterial => {
  const registration = result.registration;
  const kept = material.registrations.filter(
    (entry) =>
      hasProtectableSecret(entry.client) &&
      (registration === undefined ||
        entry.issuer !== registration.issuer ||
        entry.redirectUri !== registration.redirectUri),
  );
  return {
    ...material,
    registrations: registration === undefined ? kept : [...kept, registration],
    session: result.session,
  };
};

interface PendingSignIn {
  readonly state: string;
  readonly connectorId: string;
  readonly serverUrl: string;
  readonly redirectUri: string;
  readonly issuer: string;
  readonly discovery: OAuthDiscoveryState;
  readonly client: OAuthClientInformationMixed;
  /** True when the client came from dynamic registration in this flow. */
  readonly registered: boolean;
  readonly codeVerifier: string;
  readonly fetch: ConnectorFetch;
  readonly expiresAt: number;
}

export interface ClaimedSignIn {
  readonly connectorId: string;
  readonly pending: PendingSignIn;
}

const clientMetadataFor = (redirectUri: string): OAuthClientMetadata => ({
  client_name: "Scient",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

const issuerOf = (state: OAuthDiscoveryState) =>
  state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;

export class ConnectorOAuthFlows {
  private readonly pending = new Map<string, PendingSignIn>();
  /**
   * Starts in progress, reserved before the first await so the cap holds under
   * concurrency. The latest start per connector owns its reservation; an older
   * or cancelled start never installs state.
   */
  private readonly starting = new Map<string, symbol>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  private prune() {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(state);
    }
  }

  /** Forget pending and in-progress sign-ins for a connector (removal, or a newer sign-in). */
  cancelConnector(connectorId: string): void {
    this.starting.delete(connectorId);
    for (const [state, entry] of this.pending) {
      if (entry.connectorId === connectorId) this.pending.delete(state);
    }
  }

  async start(input: {
    readonly connectorId: string;
    readonly serverUrl: string;
    readonly callbackOrigin: string;
    readonly material: ConnectorOAuthMaterial;
    readonly fetch: ConnectorFetch;
    readonly resourceMetadataUrl: URL | undefined;
    readonly scope: string | undefined;
  }): Promise<{ readonly authorizationUrl: string; readonly expiresAt: number }> {
    this.prune();
    this.cancelConnector(input.connectorId);
    if (this.pending.size + this.starting.size >= MAX_PENDING_SIGN_INS) {
      throw new ConnectorOAuthError(
        "limit-reached",
        "Too many sign-ins are in progress. Finish or wait for one to expire, then try again.",
      );
    }
    const reservation = Symbol(input.connectorId);
    this.starting.set(input.connectorId, reservation);
    try {
      return await this.startReserved(input, reservation);
    } finally {
      if (this.starting.get(input.connectorId) === reservation) {
        this.starting.delete(input.connectorId);
      }
    }
  }

  private async startReserved(
    input: Parameters<ConnectorOAuthFlows["start"]>[0],
    reservation: symbol,
  ): Promise<{ readonly authorizationUrl: string; readonly expiresAt: number }> {
    const ownSecret = input.material.ownClient?.clientSecret;
    if (ownSecret !== undefined && !isProtectableCredential(ownSecret)) {
      throw new ConnectorOAuthError(
        "sign-in-failed",
        "The stored OAuth client secret is shorter than Scient can keep out of agent output (16 characters). Remove the service and add it again with a longer client secret.",
      );
    }
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    const redirectUri = `${input.callbackOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}`;
    const ownClient = input.material.ownClient;
    let discovery: OAuthDiscoveryState | undefined;
    let registeredClient: OAuthClientInformationMixed | undefined;
    let usedClient: OAuthClientInformationMixed | undefined;
    let authorizationUrl: URL | undefined;
    let codeVerifier: string | undefined;
    let invalidatedRegistration = false;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirectUri;
      },
      get clientMetadata() {
        return clientMetadataFor(redirectUri);
      },
      state: () => state,
      clientInformation: () => {
        if (registeredClient) return (usedClient = registeredClient);
        if (ownClient) {
          return (usedClient = {
            client_id: ownClient.clientId,
            ...(ownClient.clientSecret === undefined
              ? {}
              : { client_secret: ownClient.clientSecret }),
          });
        }
        if (discovery === undefined || invalidatedRegistration) return undefined;
        const issuer = issuerOf(discovery);
        const stored = input.material.registrations.find(
          (entry) => entry.issuer === issuer && entry.redirectUri === redirectUri,
        );
        // A stored registration whose secret is too short to protect is not
        // reused: returning nothing makes the flow register a new client.
        const usable = stored !== undefined && hasProtectableSecret(stored.client);
        return (usedClient = usable ? asClientInformation(stored.client) : undefined);
      },
      saveClientInformation: (information) => {
        registeredClient = information;
        usedClient = information;
      },
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: (url) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: (verifier) => {
        codeVerifier = verifier;
      },
      codeVerifier: () => codeVerifier ?? "",
      saveDiscoveryState: (next) => {
        discovery = next;
      },
      discoveryState: () => undefined,
      validateResourceURL: validateResource,
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "client") {
          registeredClient = undefined;
          invalidatedRegistration = true;
        }
      },
    };
    try {
      const result = await auth(provider, {
        serverUrl: input.serverUrl,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.resourceMetadataUrl === undefined
          ? {}
          : { resourceMetadataUrl: input.resourceMetadataUrl }),
        fetchFn: input.fetch,
      });
      if (
        result !== "REDIRECT" ||
        authorizationUrl === undefined ||
        codeVerifier === undefined ||
        discovery === undefined ||
        usedClient === undefined
      ) {
        throw new ConnectorOAuthError("sign-in-failed", "The service did not start a sign-in.");
      }
    } catch (error) {
      throw classifyFailure(error, "Sign-in could not be started");
    }
    if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
      throw new ConnectorOAuthError(
        "sign-in-failed",
        "The service returned an unusable sign-in page.",
      );
    }
    const issuedSecret = registeredClient?.client_secret;
    if (typeof issuedSecret === "string" && !isProtectableCredential(issuedSecret)) {
      throw new ConnectorOAuthError(
        "sign-in-failed",
        "The service registered a client secret shorter than Scient can keep out of agent output (16 characters), so Scient will not use it.",
      );
    }
    if (this.starting.get(input.connectorId) !== reservation) {
      throw new ConnectorOAuthError(
        "sign-in-failed",
        "A newer sign-in or a disconnect replaced this one.",
      );
    }
    const expiresAt = this.now() + PENDING_SIGN_IN_TTL_MS;
    this.pending.set(state, {
      state,
      connectorId: input.connectorId,
      serverUrl: input.serverUrl,
      redirectUri,
      issuer: issuerOf(discovery),
      discovery,
      client: usedClient,
      registered: registeredClient !== undefined,
      codeVerifier,
      fetch: input.fetch,
      expiresAt,
    });
    return { authorizationUrl: authorizationUrl.href, expiresAt };
  }

  /** Single claim: the state is consumed whether or not the exchange succeeds. */
  claim(state: string): ClaimedSignIn | undefined {
    this.prune();
    const entry = this.pending.get(state);
    if (entry === undefined) return undefined;
    this.pending.delete(state);
    return { connectorId: entry.connectorId, pending: entry };
  }

  /** Exchanges the code; the caller fences and persists the result. */
  async complete(claimed: ClaimedSignIn, code: string): Promise<ConnectorSignInResult> {
    const { pending } = claimed;
    let tokens: OAuthTokens | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return pending.redirectUri;
      },
      get clientMetadata() {
        return clientMetadataFor(pending.redirectUri);
      },
      clientInformation: () => pending.client,
      tokens: () => undefined,
      saveTokens: (next) => {
        tokens = next;
      },
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => pending.codeVerifier,
      discoveryState: () => pending.discovery,
      saveDiscoveryState: () => undefined,
      validateResourceURL: validateResource,
    };
    let resource: URL | undefined;
    try {
      const result = await auth(provider, {
        serverUrl: pending.serverUrl,
        authorizationCode: code,
        fetchFn: pending.fetch,
      });
      resource = await selectResourceURL(
        pending.serverUrl,
        provider,
        pending.discovery.resourceMetadata,
      );
      if (result !== "AUTHORIZED" || tokens === undefined) {
        throw new ConnectorOAuthError("sign-in-failed", "The service did not issue a token.");
      }
    } catch (error) {
      throw classifyFailure(error, "Sign-in could not be completed");
    }
    if (resource === undefined) {
      throw new ConnectorOAuthError("sign-in-failed", "Sign-in could not be completed.");
    }
    const metadata = pending.discovery.authorizationServerMetadata;
    return {
      registration: pending.registered
        ? {
            issuer: pending.issuer,
            redirectUri: pending.redirectUri,
            client: pending.client as unknown as Readonly<Record<string, unknown>>,
          }
        : undefined,
      session: sessionFromTokens({
        tokens,
        now: this.now(),
        base: {
          grantId: NodeCrypto.randomUUID(),
          authorizationServerUrl: pending.discovery.authorizationServerUrl,
          ...(metadata === undefined
            ? {}
            : {
                authorizationServerMetadata: metadata as unknown as Readonly<
                  Record<string, unknown>
                >,
              }),
          resource: resource.href,
          issuer: pending.issuer,
          redirectUri: pending.redirectUri,
          client: pending.client as unknown as Readonly<Record<string, unknown>>,
        },
      }),
    };
  }
}

/** Rejects with the SDK's OAuth error classes; see `isGrantLost`. */
export const refreshConnectorSession = async (
  session: ConnectorOAuthSession,
  fetch: ConnectorFetch,
  now: number,
): Promise<ConnectorOAuthSession> => {
  if (session.refreshToken === undefined) {
    throw new InvalidGrantError("No refresh token is available.");
  }
  const metadata = session.authorizationServerMetadata as AuthorizationServerMetadata | undefined;
  const tokens = await refreshAuthorization(session.authorizationServerUrl, {
    ...(metadata === undefined ? {} : { metadata }),
    clientInformation: asClientInformation(session.client),
    refreshToken: session.refreshToken,
    resource: new URL(session.resource),
    fetchFn: fetch,
  });
  const {
    accessToken: _a,
    tokenType: _t,
    refreshToken: _r,
    scope: _s,
    expiresAt: _e,
    ...base
  } = session;
  return sessionFromTokens({ tokens, now, previous: session, base });
};

/** Best-effort RFC 7009 revocation of the refresh and access tokens. */
export const revokeConnectorSession = async (
  session: ConnectorOAuthSession,
  fetch: ConnectorFetch,
): Promise<void> => {
  // RFC 7009 / RFC 8414 `revocation_endpoint`; absent from the SDK's metadata type.
  const endpoint = session.authorizationServerMetadata?.revocation_endpoint;
  if (typeof endpoint !== "string") return;
  const client = asClientInformation(session.client);
  const usePost =
    "token_endpoint_auth_method" in client &&
    client.token_endpoint_auth_method === "client_secret_post";
  for (const [token, hint] of [
    [session.refreshToken, "refresh_token"],
    [session.accessToken, "access_token"],
  ] as const) {
    if (token === undefined) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (client.client_secret !== undefined && !usePost) {
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`,
      ).toString("base64")}`;
    } else {
      body.set("client_id", client.client_id);
      if (client.client_secret !== undefined) body.set("client_secret", client.client_secret);
    }
    await fetch(endpoint, { method: "POST", headers, body })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
};
