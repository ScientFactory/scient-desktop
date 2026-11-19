import { createClerkClient } from "@clerk/backend";
import { ClerkAPIResponseError } from "@clerk/backend/errors";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as AccountDeletion from "./AccountDeletion.ts";
import * as AccountRecords from "./AccountRecords.ts";
import * as ClerkUsers from "./ClerkUsers.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn() }));

const publishableKey = (host: string) => `pk_test_${globalThis.btoa(`${host}$`)}`;

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("sk-primary"),
  clerkPublishableKey: publishableKey("clerk.example.test"),
  clerkJwtAudience: "relay",
  clerkLegacy: {
    secretKey: Redacted.make("sk-legacy"),
    publishableKey: publishableKey("legacy.clerk.example.test"),
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  cloudMintPrivateKey: Redacted.make("mint-private"),
  cloudMintPublicKey: "mint-public",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: "dev",
};

const sessionJwt = (issuer: string) =>
  `${globalThis.btoa("{}")}.${globalThis.btoa(JSON.stringify({ iss: issuer, sub: "user-1" }))}.sig`;

describe("account deletion", () => {
  it.effect("deletes the Clerk user only after a retried run removes every endpoint", () => {
    const calls: Array<string> = [];
    let deprovisionFails = true;
    let revoked = false;
    const linked = {
      environmentId: "env-1",
      label: "Laptop",
      environmentPublicKey: "key-1",
      endpoint: {
        httpBaseUrl: "https://e",
        wsBaseUrl: "wss://e",
        providerKind: "cloudflare_tunnel",
      },
      linkedAt: "2026-11-11T00:00:00.000Z",
    } as unknown as EnvironmentLinks.RelayLinkedEnvironmentRecord;
    const layer = AccountDeletion.layer.pipe(
      Layer.provide([
        Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
        Layer.mock(AccountRecords.AccountRecords, {
          listEnvironmentIds: () => Effect.succeed(["env-1"]),
          deleteForUser: () => Effect.sync(() => void calls.push("records")),
        }),
        Layer.mock(ClerkUsers.ClerkUsers, {
          deleteUser: () => Effect.sync(() => void calls.push("clerk")),
        }),
        Layer.mock(T3ChatAccounts.T3ChatAccounts, { available: false }),
        Layer.mock(EnvironmentLinks.EnvironmentLinks, {
          getForUser: () => Effect.sync(() => (revoked ? null : linked)),
          revokeForUser: () => Effect.sync(() => (calls.push("revoke"), (revoked = true))),
        }),
        Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {
          revokeForEnvironmentPublicKey: () => Effect.succeed(true),
        }),
        Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {
          prepareDeprovision: () => Effect.succeed(null),
          deprovision: (input) =>
            deprovisionFails
              ? Effect.fail(
                  new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "delete-tunnel",
                    cause: new Error("Cloudflare unavailable"),
                  }),
                )
              : Effect.sync(() => (calls.push("deprovision"), true)),
        }),
        Layer.mock(HookInbox.HookInbox, {}),
        Layer.succeed(RelayDb.RelayTransactions, { withTransaction: (effect) => effect }),
      ]),
    );

    return Effect.gen(function* () {
      const deletion = yield* AccountDeletion.AccountDeletion;
      const input = { userId: "user-1", token: "token" };
      const failed = yield* Effect.flip(deletion.deleteAccount(input));
      expect(failed.stage).toBe("unlink-environment");
      expect(calls).toEqual(["revoke"]);

      deprovisionFails = false;
      yield* deletion.deleteAccount(input);
      expect(calls).toEqual(["revoke", "deprovision", "records", "clerk"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("Clerk user deletion", () => {
  const deleteUser = (token: string, missingIn: ReadonlyArray<string>) => {
    const attempts: Array<string> = [];
    vi.mocked(createClerkClient).mockImplementation(
      (options) =>
        ({
          users: {
            deleteUser: async () => {
              attempts.push(options?.secretKey ?? "");
              if (missingIn.includes(options?.secretKey ?? "")) {
                throw new ClerkAPIResponseError("Not Found", { data: [], status: 404 });
              }
              return {};
            },
          },
        }) as unknown as ReturnType<typeof createClerkClient>,
    );
    return Effect.gen(function* () {
      const users = yield* ClerkUsers.ClerkUsers;
      yield* users.deleteUser({ userId: "user-1", token });
      return attempts;
    }).pipe(
      Effect.provide(
        ClerkUsers.layer.pipe(
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings)),
        ),
      ),
    );
  };

  it.effect("uses the instance that issued a session token", () =>
    Effect.gen(function* () {
      expect(yield* deleteUser(sessionJwt("https://legacy.clerk.example.test"), [])).toEqual([
        "sk-legacy",
      ]);
      expect(yield* deleteUser(sessionJwt("https://clerk.example.test"), [])).toEqual([
        "sk-primary",
      ]);
    }),
  );

  it.effect(
    "finds an opaque token's user in either instance and treats a deleted one as done",
    () =>
      Effect.gen(function* () {
        expect(yield* deleteUser("oat_opaque", ["sk-primary"])).toEqual([
          "sk-primary",
          "sk-legacy",
        ]);
        expect(yield* deleteUser("oat_opaque", ["sk-primary", "sk-legacy"])).toEqual([
          "sk-primary",
          "sk-legacy",
        ]);
      }),
  );
});
