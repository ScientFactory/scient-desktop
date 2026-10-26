// @effect-diagnostics nodeBuiltinImport:off -- Server-only nonce generation for the standalone callback page.
/**
 * `GET /oauth/connectors/callback`: where a vendor's authorization server
 * returns the user after connector sign-in. Unauthenticated by design: the
 * single-use `state` is the only authority, and the PKCE verifier never leaves
 * the server, so a leaked code is useless.
 */
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ConnectorRuntime, type ConnectorSignInCallbackOutcome } from "../ExtensionsServices.ts";
import { CONNECTOR_OAUTH_CALLBACK_PATH } from "./ConnectorOAuth.ts";

import { renderCallbackPage } from "./ConnectorCallbackPage.ts";
import { CURATED_SERVERS } from "../discover/curatedCatalog.ts";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
  const runtime = yield* ConnectorRuntime;
  const outcome = yield* runtime.completeSignIn({
    state: params.get("state") ?? undefined,
    code: params.get("code") ?? undefined,
    error: params.get("error") ?? undefined,
    errorDescription: params.get("error_description") ?? undefined,
  });
  const nonce = NodeCrypto.randomUUID();
  const icon = CURATED_SERVERS.find((server) => server.displayName === outcome.displayName)?.icon;
  return HttpServerResponse.text(renderCallbackPage(outcome, nonce, icon), {
    status: outcome.outcome === "connected" ? 200 : 400,
    contentType: "text/html; charset=utf-8",
    headers: {
      "content-security-policy": `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

export const layer = HttpRouter.add("GET", CONNECTOR_OAUTH_CALLBACK_PATH, handler);
