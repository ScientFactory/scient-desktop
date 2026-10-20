/**
 * `GET /oauth/connectors/callback`: where a vendor's authorization server
 * returns the user after connector sign-in. Unauthenticated by design: the
 * single-use `state` is the only authority, and the PKCE verifier never leaves
 * the server, so a leaked code is useless.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ConnectorRuntime, type ConnectorSignInCallbackOutcome } from "../ExtensionsServices.ts";
import { CONNECTOR_OAUTH_CALLBACK_PATH } from "./ConnectorOAuth.ts";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

export const renderCallbackPage = (outcome: ConnectorSignInCallbackOutcome): string => {
  const title =
    outcome.outcome === "connected"
      ? `${outcome.displayName ?? "Service"} connected`
      : "Sign-in did not complete";
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · Scient</title></head>`,
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(outcome.message)}</p>`,
    "</body>",
    "</html>",
  ].join("\n");
};

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
  return HttpServerResponse.text(renderCallbackPage(outcome), {
    status: outcome.outcome === "connected" ? 200 : 400,
    contentType: "text/html; charset=utf-8",
    headers: {
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

export const layer = HttpRouter.add("GET", CONNECTOR_OAUTH_CALLBACK_PATH, handler);
