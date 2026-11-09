import {
  AccountId,
  AccountsError,
  defaultAccountControls,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { makeKeptAgentKeys } from "./keptAgentKeys.ts";
import type { RemovedAgent, RemovedAgentKeeper } from "./removedAgentKeys.ts";

const kept = (accountId: string, agent: string, setting: string): AccountSummary => ({
  accountId: AccountId.make(accountId),
  name: setting,
  details: { kind: "api-key", sites: [], auth: { type: "bearer" }, keptFrom: { agent, setting } },
  secrets: { token: { source: { type: "scient" } } },
  controls: defaultAccountControls("api-key"),
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const agent = (environment: ReadonlyArray<object>, config: object = {}) => ({
  driver: "antigravity",
  displayName: "Antigravity",
  environment,
  config,
});

const fakeSettings = (instances: Record<string, unknown>) => {
  const updates: Array<{ instanceId: string; instance: Record<string, unknown> }> = [];
  let keeper: RemovedAgentKeeper | undefined;
  const service = {
    getSettings: Effect.sync(() => ({ providerInstances: instances })),
    updateProviderInstance: (mutation: (typeof updates)[number]) =>
      Effect.sync(() => {
        updates.push(mutation);
        return {};
      }),
    setRemovedAgentKeeper: (next: RemovedAgentKeeper) =>
      Effect.sync(() => {
        keeper = next;
      }),
  } as unknown as ServerSettingsService["Service"];
  return { service, updates, keeper: () => keeper! };
};

it.effect("keeps a removed agent's typed keys in Accounts once each, and drops its links", () =>
  Effect.gen(function* () {
    const settings = fakeSettings({});
    const fake = fakeAccounts({
      accounts: [kept("acc_oldkey01", "antigravity", "OLD_KEY")],
      values: { token: "kept-before" },
    });
    const links: Array<unknown> = [];
    const accounts = {
      ...fake.service,
      snapshot: fake.service.snapshot.pipe(
        Effect.map((snapshot): AccountsSnapshot => ({
          ...snapshot,
          keyLinks: [
            {
              instanceId: "antigravity",
              variable: "LINKED_KEY",
              accountId: AccountId.make("acc_oldkey01"),
            },
            // Its account was deleted: the key isn't saved back.
            {
              instanceId: "antigravity",
              variable: "DELETED_KEY",
              accountId: AccountId.make("acc_gone0001"),
            },
          ],
        })),
      ),
      setKeyLink: (target: unknown, accountId?: AccountId) =>
        Effect.sync(() => {
          links.push({ target, accountId });
        }),
    };
    yield* makeKeptAgentKeys(accounts).pipe(
      Effect.provideService(ServerSettingsService, settings.service),
    );
    yield* settings.keeper()([
      {
        instanceId: "antigravity",
        instance: agent(
          [
            { name: "LINKED_KEY", value: "from-accounts", sensitive: true },
            { name: "DELETED_KEY", value: "deleted-by-user", sensitive: true },
            { name: "OLD_KEY", value: "kept-before", sensitive: true },
            // As read settings carry a stored variable: its value, still marked redacted.
            { name: "NEW_KEY", value: "typed-key", sensitive: true, valueRedacted: true },
            { name: "HOME_DIR", value: "/home", sensitive: false },
          ],
          { apiKey: "typed-api-key" },
        ) as RemovedAgent["instance"],
      },
    ]);
    expect(fake.saves.map(({ name, details }) => ({ name, details }))).toEqual([
      {
        name: "Antigravity · NEW_KEY",
        details: {
          kind: "api-key",
          sites: [],
          auth: { type: "bearer" },
          envName: "NEW_KEY",
          keptFrom: { agent: "antigravity", setting: "NEW_KEY" },
        },
      },
      {
        name: "Antigravity · API key",
        details: {
          kind: "api-key",
          sites: [],
          auth: { type: "bearer" },
          keptFrom: { agent: "antigravity", setting: "config.apiKey" },
        },
      },
    ]);
    expect(links).toEqual([
      { target: expect.objectContaining({ variable: "LINKED_KEY" }), accountId: undefined },
      { target: expect.objectContaining({ variable: "DELETED_KEY" }), accountId: undefined },
    ]);
  }),
);

it.effect("fails, so the removal fails, when Accounts can't keep a key", () =>
  Effect.gen(function* () {
    const settings = fakeSettings({});
    const fake = fakeAccounts();
    const accounts = {
      ...fake.service,
      save: () => Effect.fail(new AccountsError({ reason: "unavailable", message: "Locked." })),
    };
    yield* makeKeptAgentKeys(accounts).pipe(
      Effect.provideService(ServerSettingsService, settings.service),
    );
    const error = yield* settings
      .keeper()([
        {
          instanceId: "antigravity",
          instance: agent([], { apiKey: "typed-api-key" }) as RemovedAgent["instance"],
        },
      ])
      .pipe(Effect.flip);
    expect(error.message).toBe("Locked.");
  }),
);

it.effect("puts kept keys back into an agent of the same kind, and only that kind", () =>
  Effect.gen(function* () {
    const settings = fakeSettings({
      antigravity_2: agent([{ name: "HOME_DIR", value: "/home", sensitive: false }]),
    });
    const fake = fakeAccounts({
      accounts: [
        kept("acc_envkey01", "antigravity", "NEW_KEY"),
        kept("acc_fieldkey1", "antigravity", "config.apiKey"),
        kept("acc_otherkey1", "claudeAgent", "ANTHROPIC_API_KEY"),
      ],
      values: { token: "saved-key" },
    });
    const links: Array<unknown> = [];
    const accounts = {
      ...fake.service,
      setKeyLink: (target: unknown, accountId?: AccountId) =>
        Effect.sync(() => {
          links.push({ target, accountId });
        }),
    };
    const restore = yield* makeKeptAgentKeys(accounts).pipe(
      Effect.provideService(ServerSettingsService, settings.service),
    );
    yield* restore({
      instanceId: "antigravity_2",
      accountIds: [AccountId.make("acc_envkey01"), AccountId.make("acc_fieldkey1")],
    });
    expect(settings.updates).toEqual([
      {
        operation: "upsert",
        instanceId: "antigravity_2",
        instance: {
          ...agent([
            { name: "HOME_DIR", value: "/home", sensitive: false },
            { name: "NEW_KEY", value: "saved-key", sensitive: true },
          ]),
          config: { apiKey: "saved-key" },
        },
      },
    ]);
    expect(links).toEqual([
      {
        target: { instanceId: "antigravity_2", variable: "NEW_KEY" },
        accountId: "acc_envkey01",
      },
    ]);
    const refused = yield* restore({
      instanceId: "antigravity_2",
      accountIds: [AccountId.make("acc_otherkey1")],
    }).pipe(Effect.flip);
    expect(refused.reason).toBe("invalid-input");
  }),
);
