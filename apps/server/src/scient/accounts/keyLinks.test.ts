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

const keep = (accounts: ReadonlyArray<unknown>, values: Readonly<Record<string, string>>) => {
  const links: Array<unknown> = [];
  const settings = {
    subscribeChanges: Effect.succeed(Stream.empty),
    getSettings: Effect.succeed({
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          environment: [{ name: "OPENAI_API_KEY", value: "typed-key", sensitive: true }],
        },
      },
    }),
    updateProviderInstance: () => Effect.die("the variable already holds the key"),
  } as unknown as ServerSettingsService["Service"];
  const fake = fakeAccounts({ accounts: accounts as never, values });
  const service = {
    ...fake.service,
    setKeyLink: (target: unknown, id: unknown) => Effect.sync(() => void links.push([target, id])),
  } as typeof fake.service;
  return Effect.scoped(
    makeAccountKeyLinks(service).pipe(
      Effect.flatMap((linkKey) => linkKey({ instanceId, variable: "OPENAI_API_KEY" })),
      Effect.as({ saves: fake.saves, links }),
      Effect.provideService(ServerSettingsService, settings),
    ),
  );
};

it.effect("keeps a variable's own key in Accounts and links the variable to it", () =>
  Effect.gen(function* () {
    const { saves, links } = yield* keep([], { token: "typed-key" });
    expect(saves).toEqual([
      {
        name: "Codex · OPENAI_API_KEY",
        details: {
          kind: "api-key",
          sites: [],
          auth: { type: "bearer" },
          envName: "OPENAI_API_KEY",
        },
        secrets: { token: { type: "scient", value: "typed-key" } },
      },
    ]);
    expect(links).toEqual([
      [{ instanceId, variable: "OPENAI_API_KEY", accountId: "acc_saved_0001" }, "acc_saved_0001"],
    ]);
  }),
);

it.effect("links to an account already holding the same key instead of keeping it twice", () =>
  Effect.gen(function* () {
    // Saved under another variable name, or none: still the same key.
    const existing = {
      accountId,
      details: { kind: "api-key", envName: "OPENAI_KEY" },
      secrets: { token: { source: { type: "scient" } } },
    };
    const { saves, links } = yield* keep([existing], { token: "typed-key" });
    expect(saves).toEqual([]);
    expect(links).toEqual([[{ instanceId, variable: "OPENAI_API_KEY", accountId }, accountId]]);
  }),
);

it.effect("never opens a key kept in another store just to compare it", () =>
  Effect.gen(function* () {
    // Its 1Password reference may be disconnected; comparing must not need it.
    const external = {
      accountId,
      details: { kind: "api-key", envName: "GITHUB_TOKEN" },
      secrets: { token: { source: { type: "1password", reference: "op://v/i/f" } } },
    };
    const { saves, links } = yield* keep([external], { token: "typed-key" });
    expect(saves).toHaveLength(1);
    expect(links).toEqual([
      [{ instanceId, variable: "OPENAI_API_KEY", accountId: "acc_saved_0001" }, "acc_saved_0001"],
    ]);
  }),
);
