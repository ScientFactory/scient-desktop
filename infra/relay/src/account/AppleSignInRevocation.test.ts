// SCIENT-FORK:START account-deletion — whole file.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test generates and verifies a P-256 key.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as RelayConfiguration from "../Config.ts";
import * as AppleSignInRevocation from "./AppleSignInRevocation.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const appleSignIn: RelayConfiguration.AppleSignInCredentials = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: Redacted.make(privateKeyPem),
  clientIds: ["com.example.mobile"],
};

const settings = (
  overrides: Partial<RelayConfiguration.RelayConfiguration["Service"]> = {},
): RelayConfiguration.RelayConfiguration["Service"] => ({
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("sk"),
  clerkPublishableKey: "pk",
  clerkJwtAudience: "relay",
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  cloudMintPrivateKey: Redacted.make("mint-private"),
  cloudMintPublicKey: "mint-public",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: "dev",
  appleSignIn,
  ...overrides,
});

interface SeenRequest {
  readonly url: string;
  readonly form: URLSearchParams;
}

const formOf = (request: HttpClientRequest.HttpClientRequest): URLSearchParams => {
  const body = request.body;
  if (body._tag !== "Uint8Array") throw new Error(`unexpected body ${body._tag}`);
  return new URLSearchParams(new TextDecoder().decode(body.body));
};

const layerWith = (
  config: RelayConfiguration.RelayConfiguration["Service"],
  respond: (request: SeenRequest) => Response,
  seen: Array<SeenRequest>,
) =>
  Layer.effect(AppleSignInRevocation.AppleSignInRevocation, AppleSignInRevocation.make).pipe(
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const entry = { url: request.url, form: formOf(request) };
          seen.push(entry);
          return Effect.succeed(HttpClientResponse.fromWeb(request, respond(entry)));
        }),
      ),
    ),
  );

const revokeWith = (input: { readonly authorizationCode: string; readonly clientId: string }) =>
  Effect.gen(function* () {
    const service = yield* AppleSignInRevocation.AppleSignInRevocation;
    return yield* service.revoke(input);
  });

const decodeSegment = (segment: string) =>
  JSON.parse(new TextDecoder().decode(Result.getOrThrow(Base64Url.decode(segment))));

describe("Sign in with Apple revocation", () => {
  it.effect("redeems the code, then revokes the refresh token with a valid client secret", () => {
    const seen: Array<SeenRequest> = [];
    return Effect.gen(function* () {
      const service = yield* AppleSignInRevocation.AppleSignInRevocation;
      yield* service.revoke({ authorizationCode: "code-1", clientId: "com.example.mobile" });

      expect(seen.map((request) => request.url)).toEqual([
        "https://appleid.apple.com/auth/token",
        "https://appleid.apple.com/auth/revoke",
      ]);
      const [redeem, revoke] = seen;
      expect(redeem!.form.get("grant_type")).toBe("authorization_code");
      expect(redeem!.form.get("code")).toBe("code-1");
      expect(redeem!.form.get("client_id")).toBe("com.example.mobile");
      expect(revoke!.form.get("token")).toBe("refresh-1");
      expect(revoke!.form.get("token_type_hint")).toBe("refresh_token");

      const [header, payload, signature] = redeem!.form.get("client_secret")!.split(".");
      expect(decodeSegment(header!)).toEqual({ alg: "ES256", kid: "KEY1234567" });
      const claims = decodeSegment(payload!);
      expect(claims).toMatchObject({
        iss: "TEAM123456",
        aud: "https://appleid.apple.com",
        sub: "com.example.mobile",
      });
      expect(claims.exp - claims.iat).toBe(300);
      const verified = NodeCrypto.verify(
        "sha256",
        new TextEncoder().encode(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Result.getOrThrow(Base64Url.decode(signature!)),
      );
      expect(verified).toBe(true);
    }).pipe(
      Effect.provide(
        layerWith(
          settings(),
          (request) =>
            request.url.endsWith("/auth/token")
              ? Response.json({ access_token: "access-1", refresh_token: "refresh-1" })
              : new Response("", { status: 200 }),
          seen,
        ),
      ),
    );
  });

  it.effect("reports Apple's error code without the authorization code", () => {
    const seen: Array<SeenRequest> = [];
    return Effect.gen(function* () {
      const service = yield* AppleSignInRevocation.AppleSignInRevocation;
      const error = yield* Effect.flip(
        service.revoke({ authorizationCode: "stale", clientId: "com.example.mobile" }),
      );
      expect(error).toMatchObject({
        stage: "redeem-code",
        status: 400,
        appleError: "invalid_grant",
      });
      expect(JSON.stringify(error)).not.toContain("stale");
      expect(seen).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerWith(
          settings(),
          () => Response.json({ error: "invalid_grant" }, { status: 400 }),
          seen,
        ),
      ),
    );
  });

  it.effect("refuses client IDs outside the allowlist and missing configuration", () => {
    const seen: Array<SeenRequest> = [];
    const respond = () => new Response("", { status: 200 });
    return Effect.gen(function* () {
      const notAllowed = yield* Effect.flip(
        revokeWith({ authorizationCode: "code", clientId: "com.other.app" }).pipe(
          Effect.provide(layerWith(settings(), respond, seen)),
        ),
      );
      expect(notAllowed.stage).toBe("client-not-allowed");

      const { appleSignIn: _omitted, ...withoutApple } = settings();
      const notConfigured = yield* Effect.flip(
        revokeWith({ authorizationCode: "code", clientId: "com.example.mobile" }).pipe(
          Effect.provide(layerWith(withoutApple, respond, seen)),
        ),
      );
      expect(notConfigured.stage).toBe("not-configured");
      expect(seen).toHaveLength(0);
    });
  });
});
// SCIENT-FORK:END account-deletion
