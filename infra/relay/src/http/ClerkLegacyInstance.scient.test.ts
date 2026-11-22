// SCIENT-FORK:START clerk-legacy-instance — whole file.
import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { afterEach, vi } from "vite-plus/test";

import { clerkInstanceForJwt } from "../auth/ClerkInstances.ts";
import type * as RelayConfiguration from "../Config.ts";
import { verifyRelayClientBearerToken } from "./Api.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const publishableKey = (frontendApi: string) => `pk_test_${btoa(`${frontendApi}$`)}`;
const base64Url = (value: string) =>
  btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const jwtFrom = (issuer: string) =>
  `${base64Url('{"alg":"RS256"}')}.${base64Url(JSON.stringify({ iss: issuer, sub: "x" }))}.sig`;

const primaryOnly: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("sk_live_primary"),
  clerkPublishableKey: publishableKey("clerk.example.com"),
  clerkJwtAudience: "scient-connect-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const withLegacy: RelayConfiguration.RelayConfiguration["Service"] = {
  ...primaryOnly,
  clerkLegacy: {
    secretKey: Redacted.make("sk_test_legacy"),
    publishableKey: publishableKey("legacy-osprey.clerk.accounts.dev"),
  },
};

const legacyJwt = jwtFrom("https://legacy-osprey.clerk.accounts.dev");
const primaryJwt = jwtFrom("https://clerk.example.com");

const oauthClient = (userId: string | null) =>
  ({
    authenticateRequest: vi.fn().mockResolvedValue({
      isAuthenticated: userId !== null,
      toAuth: () => ({ userId }),
    }),
  }) as never;

describe("Clerk legacy instance", () => {
  afterEach(() => {
    vi.mocked(verifyToken).mockReset();
    vi.mocked(createClerkClient).mockReset();
  });

  it("picks the legacy instance only for tokens it issued", () => {
    expect(clerkInstanceForJwt(withLegacy, legacyJwt).name).toBe("legacy");
    expect(clerkInstanceForJwt(withLegacy, primaryJwt).name).toBe("primary");
    expect(clerkInstanceForJwt(withLegacy, "not-a-jwt").name).toBe("primary");
    expect(clerkInstanceForJwt(withLegacy, jwtFrom("https://evil.example")).name).toBe("primary");
    expect(clerkInstanceForJwt(primaryOnly, legacyJwt).name).toBe("primary");
  });

  it.effect("verifies a legacy session JWT with the legacy keys", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_dev",
        aud: withLegacy.clerkJwtAudience,
      } as never);
      expect(yield* verifyRelayClientBearerToken(withLegacy, legacyJwt)).toEqual({
        sub: "user_dev",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith(legacyJwt, {
        secretKey: "sk_test_legacy",
        audience: withLegacy.clerkJwtAudience,
      });
    }),
  );

  it.effect("keeps production session JWTs on the production keys", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_prod",
        aud: withLegacy.clerkJwtAudience,
      } as never);
      yield* verifyRelayClientBearerToken(withLegacy, primaryJwt);
      expect(verifyToken).toHaveBeenCalledTimes(1);
      expect(verifyToken).toHaveBeenCalledWith(primaryJwt, {
        secretKey: "sk_live_primary",
        audience: withLegacy.clerkJwtAudience,
      });
    }),
  );

  it.effect("tries the legacy instance for an OAuth token production rejects", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient)
        .mockReturnValueOnce(oauthClient(null))
        .mockReturnValueOnce(oauthClient("user_dev_cli"));
      expect(yield* verifyRelayClientBearerToken(withLegacy, "oat_legacy")).toEqual({
        sub: "user_dev_cli",
        mode: "clerk_oauth_bearer",
      });
      expect(vi.mocked(createClerkClient).mock.calls).toEqual([
        [{ secretKey: "sk_live_primary", publishableKey: withLegacy.clerkPublishableKey }],
        [{ secretKey: "sk_test_legacy", publishableKey: withLegacy.clerkLegacy!.publishableKey }],
      ]);
    }),
  );

  it.effect("rejects a token neither instance accepts", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue(oauthClient(null));
      const exit = yield* Effect.exit(verifyRelayClientBearerToken(withLegacy, "oat_unknown"));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(createClerkClient).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("checks only production when no legacy instance is set", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue(oauthClient(null));
      const exit = yield* Effect.exit(verifyRelayClientBearerToken(primaryOnly, "oat_unknown"));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(createClerkClient).toHaveBeenCalledTimes(1);
    }),
  );
});
// SCIENT-FORK:END clerk-legacy-instance
