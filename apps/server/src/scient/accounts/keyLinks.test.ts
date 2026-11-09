import { AccountId, ProviderInstanceId, type AccountsSnapshot } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import * as AccountKeyLinks from "./keyLinks.ts";
import { makeAccountKeyLinks } from "./keyLinks.ts";

const accountId = AccountId.make("acc_fixture1");
const instanceId = ProviderInstanceId.make("codex");
const link = { accountId, instanceId, variable: "OPENAI_API_KEY" };

const run = (value: string) => {
  const updates: Array<unknown> = [];
  const settings = {
    subscribeChanges: Effect.succeed(Stream.empty),
    getSettings: Effect.succeed({
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          environment: [
            { name: "OPENAI_API_KEY", value, sensitive: true },
            { name: "CODEX_HOME", value: "/home", sensitive: false },
          ],
        },
      },
    }),
    updateProviderInstance: (mutation: unknown) =>
      Effect.sync(() => {
        updates.push(mutation);
        return {};
      }),
  } as unknown as ServerSettingsService["Service"];
  const fake = fakeAccounts({ values: { token: "saved-key" } });
  return Effect.scoped(
    makeAccountKeyLinks(fake.service).pipe(
      Effect.flatMap((linkKey) => linkKey(link)),
      Effect.as(updates),
      Effect.provideService(ServerSettingsService, settings),
    ),
  );
};

it.effect("copies the saved key into the variable and leaves the others alone", () =>
  Effect.gen(function* () {
    const [update] = (yield* run("old")) as Array<{
      instanceId: string;
      instance: { environment: unknown };
    }>;
    expect(update?.instanceId).toBe(instanceId);
    expect(update?.instance.environment).toEqual([
      { name: "OPENAI_API_KEY", value: "saved-key", sensitive: true },
      { name: "CODEX_HOME", value: "/home", sensitive: false },
    ]);
  }),
);

it.effect("writes nothing when the variable already has the key", () =>
  Effect.gen(function* () {
    expect(yield* run("saved-key")).toEqual([]);
  }),
);

it.effect("follows a key rotated in Accounts after the layer is built", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<AccountsSnapshot>();
    const updated = yield* Deferred.make<unknown>();
    const settings = {
      subscribeChanges: Effect.succeed(Stream.empty),
      getSettings: Effect.succeed({
        providerInstances: {
          [instanceId]: {
            driver: "codex",
            environment: [{ name: "OPENAI_API_KEY", value: "old-key", sensitive: true }],
          },
        },
      }),
      updateProviderInstance: (mutation: unknown) =>
        Deferred.succeed(updated, mutation).pipe(Effect.as({})),
    } as unknown as ServerSettingsService["Service"];
    const fake = fakeAccounts({ values: { token: "rotated-key" } });
    yield* Layer.build(
      AccountKeyLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AccountsService, { ...fake.service, changes: Stream.fromQueue(changes) }),
            Layer.succeed(ServerSettingsService, settings),
          ),
        ),
      ),
    );
    yield* Queue.offer(changes, {
      accounts: [{ accountId, updatedAt: "2026-11-09T00:00:00.000Z" }],
      keyLinks: [link],
    } as unknown as AccountsSnapshot);
    const mutation = (yield* Deferred.await(updated)) as {
      instance: { environment: ReadonlyArray<unknown> };
    };
    expect(mutation.instance.environment).toEqual([
      { name: "OPENAI_API_KEY", value: "rotated-key", sensitive: true },
    ]);
  }).pipe(Effect.scoped),
);
