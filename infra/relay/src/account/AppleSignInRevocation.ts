// SCIENT-FORK:START account-deletion — whole file.
// Revokes a deleting account's Sign in with Apple tokens (App Store guideline 5.1.1(v), Apple
// TN3194). Clerk signs iPhone users in with Apple's identity token alone and keeps no Apple refresh
// token, so the phone gets a fresh authorization code; this redeems it and revokes the result.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createPrivateKey.
import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

const APPLE_ID_ORIGIN = "https://appleid.apple.com";
const APPLE_REQUEST_TIMEOUT = "5 seconds";
// Apple accepts client secrets valid for up to six months; each request signs a fresh short one.
const CLIENT_SECRET_LIFETIME_SECONDS = 300;

export class AppleSignInRevocationFailed extends Schema.TaggedError<AppleSignInRevocationFailed>()(
  "AppleSignInRevocationFailed",
  {
    stage: Schema.Literals([
      "not-configured",
      "client-not-allowed",
      "client-secret",
      "redeem-code",
      "revoke-token",
    ]),
    status: Schema.optional(Schema.Number),
    // Apple's OAuth error code, such as `invalid_grant`; never the code or the tokens.
    appleError: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Sign in with Apple revocation failed at '${this.stage}'`;
  }
}

export class AppleSignInRevocation extends Context.Service<
  AppleSignInRevocation,
  {
    readonly revoke: (input: {
      readonly authorizationCode: string;
      readonly clientId: string;
    }) => Effect.Effect<void, AppleSignInRevocationFailed>;
  }
>()("t3code-relay/account/AppleSignInRevocation") {}

const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
});
const ErrorResponse = Schema.Struct({ error: Schema.String });
const decodeTokenResponse = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse));
const decodeErrorResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse));

const appleErrorOf = (body: string): { readonly appleError?: string } => {
  const error = decodeErrorResponse(body);
  return error._tag === "Some" ? { appleError: error.value.error } : {};
};

const encodeJson = (value: unknown) =>
  Base64Url.encode(new TextEncoder().encode(JSON.stringify(value)));

const signingScalarCache = new Map<string, Uint8Array>();

function signingScalar(privateKeyPem: string): Uint8Array {
  const cached = signingScalarCache.get(privateKeyPem);
  if (cached) return cached;
  const jwk = NodeCrypto.createPrivateKey(privateKeyPem.replace(/\\n/g, "\n")).export({
    format: "jwk",
  });
  if (jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("The Sign in with Apple key is not a P-256 private key.");
  }
  const scalar = Result.getOrThrowWith(
    Base64Url.decode(jwk.d),
    () => new Error("The Sign in with Apple key scalar is not valid base64url."),
  );
  signingScalarCache.set(privateKeyPem, scalar);
  return scalar;
}

/** The ES256 client secret Apple's token and revoke endpoints expect. */
export function makeAppleClientSecret(input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly clientId: string;
  readonly issuedAtUnixSeconds: number;
}): string {
  const header = encodeJson({ alg: "ES256", kid: input.keyId });
  const payload = encodeJson({
    iss: input.teamId,
    iat: input.issuedAtUnixSeconds,
    exp: input.issuedAtUnixSeconds + CLIENT_SECRET_LIFETIME_SECONDS,
    aud: APPLE_ID_ORIGIN,
    sub: input.clientId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = p256
    .sign(
      sha256(new TextEncoder().encode(signingInput)),
      signingScalar(Redacted.value(input.privateKey)),
      { prehash: false },
    )
    .toCompactRawBytes();
  return `${signingInput}.${Base64Url.encode(signature)}`;
}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;

  const postForm = (
    stage: "redeem-code" | "revoke-token",
    path: string,
    params: Record<string, string>,
  ) =>
    HttpClientRequest.post(`${APPLE_ID_ORIGIN}${path}`).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyUrlParams(params),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
      ),
      Effect.timeout(APPLE_REQUEST_TIMEOUT),
      Effect.mapError((cause) => new AppleSignInRevocationFailed({ stage, cause })),
      Effect.flatMap(({ status, body }) =>
        status >= 200 && status < 300
          ? Effect.succeed(body)
          : Effect.fail(new AppleSignInRevocationFailed({ stage, status, ...appleErrorOf(body) })),
      ),
    );

  return AppleSignInRevocation.of({
    revoke: Effect.fn("relay.apple_sign_in.revoke")(function* (input) {
      const credentials = config.appleSignIn;
      if (!credentials) {
        return yield* new AppleSignInRevocationFailed({ stage: "not-configured" });
      }
      yield* Effect.annotateCurrentSpan({ "relay.apple_sign_in.client_id": input.clientId });
      if (!credentials.clientIds.includes(input.clientId)) {
        return yield* new AppleSignInRevocationFailed({ stage: "client-not-allowed" });
      }
      const issuedAtUnixSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const clientSecret = yield* Effect.try({
        try: () =>
          makeAppleClientSecret({ ...credentials, clientId: input.clientId, issuedAtUnixSeconds }),
        catch: (cause) => new AppleSignInRevocationFailed({ stage: "client-secret", cause }),
      });

      const tokenBody = yield* postForm("redeem-code", "/auth/token", {
        client_id: input.clientId,
        client_secret: clientSecret,
        code: input.authorizationCode,
        grant_type: "authorization_code",
      });
      const tokens = decodeTokenResponse(tokenBody);
      // Revoking the refresh token ends the app's authorization; the access token is the fallback.
      const token =
        tokens._tag === "Some"
          ? tokens.value.refresh_token
            ? { token: tokens.value.refresh_token, hint: "refresh_token" }
            : tokens.value.access_token
              ? { token: tokens.value.access_token, hint: "access_token" }
              : undefined
          : undefined;
      if (!token) {
        return yield* new AppleSignInRevocationFailed({ stage: "redeem-code", status: 200 });
      }

      yield* postForm("revoke-token", "/auth/revoke", {
        client_id: input.clientId,
        client_secret: clientSecret,
        token: token.token,
        token_type_hint: token.hint,
      });
    }),
  });
});

export const layer = Layer.effect(AppleSignInRevocation, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
// SCIENT-FORK:END account-deletion
