// FILE: openaiNativeOAuth.ts
// Purpose: Native ChatGPT OAuth sign-in for the Codex provider. Runs the same
//          PKCE authorization-code flow as `codex login` (identical client id,
//          loopback callback, and credential format) so the resulting
//          auth.json is indistinguishable from one written by the Codex CLI,
//          which then owns the credentials and their refresh lifecycle.
//          Tokens never leave this module except as the auth.json file inside
//          CODEX_HOME; nothing is logged or sent to the renderer.
// Layer: Server provider integration

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { Deferred, Effect } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite";

/** Mirrors codex-rs `login`: public OAuth client used by `codex login`. */
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
/** Loopback ports registered for the client's redirect URI (primary, fallback). */
export const OPENAI_OAUTH_CALLBACK_PORTS: readonly number[] = [1455, 1457];
export const OPENAI_OAUTH_CALLBACK_PATH = "/auth/callback";
/** Scope string matches codex-rs verbatim so issued tokens behave identically. */
const OPENAI_OAUTH_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OPENAI_OAUTH_ORIGINATOR = "codex_cli_rs";

export type OpenAiNativeOAuthFailureReason =
  | "port_in_use"
  | "authorization_denied"
  | "state_mismatch"
  | "token_exchange_failed"
  | "credentials_write_failed";

export class OpenAiNativeOAuthError extends Error {
  constructor(
    readonly reason: OpenAiNativeOAuthFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "OpenAiNativeOAuthError";
  }
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildOpenAiAuthorizeUrl(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
}): string {
  const url = new URL(`${input.issuer.replace(/\/$/u, "")}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: OPENAI_OAUTH_ORIGINATOR,
  }).toString();
  return url.toString();
}

/**
 * Extracts the ChatGPT account id from the id_token's
 * `https://api.openai.com/auth` claim without validating the signature; the
 * token was just received over TLS from the issuer's token endpoint.
 */
export function parseChatGptAccountId(idToken: string): string | null {
  const segments = idToken.split(".");
  if (segments.length !== 3 || !segments[1]) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return null;
    const authClaim = (claims as Record<string, unknown>)["https://api.openai.com/auth"];
    if (typeof authClaim !== "object" || authClaim === null) return null;
    const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

export interface OpenAiTokenBundle {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string | null;
}

/**
 * Serializes credentials exactly as codex-rs `AuthDotJson` does: `auth_mode`
 * is optional and omitted, `OPENAI_API_KEY` is always present (null under
 * ChatGPT-subscription auth), and `last_refresh` is an RFC3339 UTC timestamp.
 */
export function serializeCodexAuthJson(
  tokens: OpenAiTokenBundle,
  options?: { readonly apiKey?: string | null | undefined; readonly now?: Date },
): string {
  return `${JSON.stringify(
    {
      OPENAI_API_KEY: options?.apiKey ?? null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
      },
      last_refresh: (options?.now ?? new Date()).toISOString(),
    },
    null,
    2,
  )}\n`;
}

export function writeCodexAuthJson(input: {
  readonly codexHome: string;
  readonly tokens: OpenAiTokenBundle;
  readonly apiKey?: string | null;
}) {
  return writeFileStringAtomically({
    filePath: path.join(input.codexHome, "auth.json"),
    contents: serializeCodexAuthJson(input.tokens, { apiKey: input.apiKey }),
  });
}

const SUCCESS_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signed in</title>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; margin: 0; color: #1a1a1a; background: #fafafa; }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; font-weight: 600; }
      p { color: #555; }
      @media (prefers-color-scheme: dark) { body { color: #ededed; background: #111; } p { color: #aaa; } }
    </style>
  </head>
  <body>
    <main>
      <h1>You're signed in to ChatGPT</h1>
      <p>You can close this tab and return to Scient.</p>
    </main>
  </body>
</html>
`;

const FAILURE_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign-in not completed</title>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; margin: 0; color: #1a1a1a; background: #fafafa; }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; font-weight: 600; }
      p { color: #555; }
      @media (prefers-color-scheme: dark) { body { color: #ededed; background: #111; } p { color: #aaa; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign-in was not completed</h1>
      <p>Return to Scient to try again. No credentials were saved.</p>
    </main>
  </body>
</html>
`;

interface CallbackOutcome {
  readonly kind: "code";
  readonly code: string;
}

function listenOnFirstAvailablePort(
  server: http.Server,
  ports: readonly number[],
): Effect.Effect<number, OpenAiNativeOAuthError> {
  const tryPort = (port: number) =>
    Effect.callback<number, NodeJS.ErrnoException>((resume) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        resume(Effect.fail(error));
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resume(Effect.succeed((server.address() as AddressInfo).port));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  const attempt = (index: number): Effect.Effect<number, OpenAiNativeOAuthError> => {
    const port = ports[index];
    if (port === undefined) {
      return Effect.fail(
        new OpenAiNativeOAuthError(
          "port_in_use",
          "Another sign-in is already using the OpenAI login port. Close other Codex sign-in windows and try again.",
        ),
      );
    }
    return tryPort(port).pipe(
      Effect.catch((error) =>
        error.code === "EADDRINUSE" || error.code === "EACCES"
          ? attempt(index + 1)
          : Effect.fail(
              new OpenAiNativeOAuthError(
                "port_in_use",
                "Scient could not open the local sign-in callback port.",
              ),
            ),
      ),
    );
  };
  return attempt(0);
}

export interface RunOpenAiNativeOAuthFlowOptions {
  readonly codexHome: string;
  readonly onAuthorizationUrl: (url: string) => Effect.Effect<void>;
  readonly issuer?: string;
  readonly clientId?: string;
  readonly ports?: readonly number[];
  readonly fetchImpl?: typeof fetch;
}

/**
 * Runs the complete browser OAuth flow and writes auth.json into
 * `options.codexHome`. Succeeds with `void` once credentials are persisted;
 * the caller owns timeout, cancellation (interruption closes the callback
 * server), and post-flow verification. Requires an enclosing Scope.
 */
export const runOpenAiNativeOAuthFlow = Effect.fn("runOpenAiNativeOAuthFlow")(function* (
  options: RunOpenAiNativeOAuthFlowOptions,
) {
  const issuer = options.issuer ?? OPENAI_OAUTH_ISSUER;
  const clientId = options.clientId ?? OPENAI_OAUTH_CLIENT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const pkce = createPkcePair();
  const state = randomBytes(32).toString("base64url");
  const callbackOutcome = yield* Deferred.make<CallbackOutcome, OpenAiNativeOAuthError>();

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== OPENAI_OAUTH_CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const error = requestUrl.searchParams.get("error");
    if (error) {
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(FAILURE_PAGE_HTML);
      Effect.runSync(
        Deferred.fail(
          callbackOutcome,
          new OpenAiNativeOAuthError(
            "authorization_denied",
            "The browser sign-in was denied or cancelled. No credentials were saved.",
          ),
        ).pipe(Effect.asVoid),
      );
      return;
    }
    const code = requestUrl.searchParams.get("code");
    const returnedState = requestUrl.searchParams.get("state");
    if (!code || returnedState !== state) {
      response
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(FAILURE_PAGE_HTML);
      Effect.runSync(
        Deferred.fail(
          callbackOutcome,
          new OpenAiNativeOAuthError(
            "state_mismatch",
            "The sign-in response could not be validated. Try again from Scient.",
          ),
        ).pipe(Effect.asVoid),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_PAGE_HTML);
    const outcome: CallbackOutcome = { kind: "code", code };
    Effect.runSync(Deferred.succeed(callbackOutcome, outcome).pipe(Effect.asVoid));
  });
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      // Waiting keep-alive connections must not delay interruption cleanup.
      server.closeAllConnections();
    }),
  );

  const boundPort = yield* listenOnFirstAvailablePort(
    server,
    options.ports ?? OPENAI_OAUTH_CALLBACK_PORTS,
  );
  const redirectUri = `http://localhost:${boundPort}${OPENAI_OAUTH_CALLBACK_PATH}`;
  yield* options.onAuthorizationUrl(
    buildOpenAiAuthorizeUrl({
      issuer,
      clientId,
      redirectUri,
      codeChallenge: pkce.challenge,
      state,
    }),
  );

  const { code } = yield* Deferred.await(callbackOutcome);

  const exchange = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(`${issuer.replace(/\/$/u, "")}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: pkce.verifier,
        }).toString(),
      });
      if (!response.ok) throw new Error(`Token endpoint returned ${response.status}`);
      return (await response.json()) as {
        readonly id_token?: string;
        readonly access_token?: string;
        readonly refresh_token?: string;
      };
    },
    catch: () =>
      new OpenAiNativeOAuthError(
        "token_exchange_failed",
        "OpenAI did not accept the sign-in response. Try again from Scient.",
      ),
  });
  if (!exchange.id_token || !exchange.access_token || !exchange.refresh_token) {
    return yield* Effect.fail(
      new OpenAiNativeOAuthError(
        "token_exchange_failed",
        "OpenAI returned an incomplete sign-in response. Try again from Scient.",
      ),
    );
  }

  const tokens: OpenAiTokenBundle = {
    idToken: exchange.id_token,
    accessToken: exchange.access_token,
    refreshToken: exchange.refresh_token,
    accountId: parseChatGptAccountId(exchange.id_token),
  };

  yield* writeCodexAuthJson({ codexHome: options.codexHome, tokens }).pipe(
    Effect.mapError(
      () =>
        new OpenAiNativeOAuthError(
          "credentials_write_failed",
          "Scient could not save the Codex credentials file.",
        ),
    ),
  );
});
