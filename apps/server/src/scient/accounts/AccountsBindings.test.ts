import { describe, expect, it } from "@effect/vitest";
import { ConnectorId, VaultSecretRef, defaultAccountControls } from "@t3tools/contracts";
import { Effect, Stream } from "effect";
import { accountTokenRef } from "./AccountBoundRef.ts";
import { makeHarness, secretEquals, syntheticValue, website } from "./Accounts.testkit.ts";

const consumer = {
  connectorId: ConnectorId.make("con_synthetic01"),
  origin: "https://api.example.com",
};
const apiKey = (value = syntheticValue()) => ({
  name: "Synthetic API",
  details: { kind: "api-key" as const, sites: ["example.com"], auth: { type: "bearer" as const } },
  secrets: { token: { type: "scient" as const, value } },
});

describe("Accounts connector bindings", () => {
  it.effect("resolves current keys, records use, and never copies a binding value", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const input = apiKey();
      const { accountId } = yield* service.save(input);
      const ref = accountTokenRef(accountId);
      yield* service.save(website());
      expect(yield* service.listBindable({ origin: consumer.origin })).toEqual([
        { ref, name: input.name },
      ]);
      expect(yield* service.listBindable({ origin: "https://example.net" })).toEqual([]);
      expect(
        secretEquals(yield* service.resolveBound(ref, consumer), input.secrets.token.value),
      ).toBe(true);
      const activity = yield* service.changes.pipe(
        Stream.filter((snapshot) => snapshot.recentActivity.length > 0),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(activity[0]?.recentActivity[0]).toMatchObject({
        target: { type: "account", accountId },
        action: "request",
        decision: "allowed",
        detail: consumer.origin,
      });
      const replacement = syntheticValue();
      yield* service.save({
        ...input,
        accountId,
        secrets: { token: { type: "scient", value: replacement } },
      });
      expect(secretEquals(yield* service.resolveBound(ref, consumer), replacement)).toBe(true);
      yield* service.remove(accountId);
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
    }),
  );

  it.effect("rejects invalid refs, non-key accounts, missing tokens and mismatched origins", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      expect(
        (yield* service
          .resolveBound(VaultSecretRef.make("account:acc_invalid01:password"), consumer)
          .pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
      const { accountId: websiteId } = yield* service.save(website());
      expect(
        (yield* service.resolveBound(accountTokenRef(websiteId), consumer).pipe(Effect.flip))
          .reason,
      ).toBe("denied");
      const { accountId } = yield* service.save(apiKey());
      const ref = accountTokenRef(accountId);
      expect(
        (yield* service
          .resolveBound(ref, { ...consumer, origin: "https://notexample.com" })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.save({ ...apiKey(), accountId, secrets: { token: { type: "clear" } } });
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
    }),
  );

  it.effect("treats a user binding as Ask approval while enforcing both Off switches", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const input = apiKey();
      const { accountId } = yield* service.save({
        ...input,
        controls: { ...defaultAccountControls("api-key"), access: "ask" },
      });
      const ref = accountTokenRef(accountId);
      expect(
        secretEquals(yield* service.resolveBound(ref, consumer), input.secrets.token.value),
      ).toBe(true);
      expect((yield* service.snapshot).approvals).toEqual([]);
      yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe("denied");
      yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      yield* service.setAgentAccess(false);
      expect((yield* service.resolveBound(ref, consumer).pipe(Effect.flip)).reason).toBe("denied");
    }),
  );
});
