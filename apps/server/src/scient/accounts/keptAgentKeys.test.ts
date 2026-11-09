import {
  AccountId,
  defaultAccountControls,
  type AccountSaveInput,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { makeKeptAgentKeys } from "./keptAgentKeys.ts";

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

const fakeSettings = (instances: Record<string, unknown>) =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<unknown>();
    const updates: Array<{ instanceId: string; instance: Record<string, unknown> }> = [];
    const service = {
      getSettings: Effect.sync(() => ({ providerInstances: instances })),
      subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
      updateProviderInstance: (mutation: (typeof updates)[number]) =>
        Effect.sync(() => {
          updates.push(mutation);
          return {};
        }),
    } as unknown as ServerSettingsService["Service"];
    return { service, changes, updates };
  });

it.effect("keeps a removed agent's typed keys in Accounts once each", () =>
  Effect.gen(function* () {
    const settings = yield* fakeSettings({
      antigravity: agent(
        [
          { name: "LINKED_KEY", value: "from-accounts", sensitive: true },
          { name: "OLD_KEY", value: "kept-before", sensitive: true },
          // As read settings carry a stored variable: its value, still marked redacted.
          { name: "NEW_KEY", value: "typed-key", sensitive: true, valueRedacted: true },
          { name: "HOME_DIR", value: "/home", sensitive: false },
        ],
        { apiKey: "typed-api-key" },
      ),
    });
    const fake = fakeAccounts({
      accounts: [kept("acc_oldkey01", "antigravity", "OLD_KEY")],
      values: { token: "kept-before" },
    });
    const done = yield* Deferred.make<void>();
    const saves: Array<AccountSaveInput> = [];
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
          ],
        })),
      ),
      save: (input: AccountSaveInput) =>
        fake.service.save(input).pipe(
          Effect.tap(() => {
            saves.push(input);
            return saves.length === 2 ? Deferred.succeed(done, undefined) : Effect.void;
          }),
        ),
    };
    yield* makeKeptAgentKeys(accounts).pipe(
      Effect.provideService(ServerSettingsService, settings.service),
    );
    yield* Queue.offer(settings.changes, { providerInstances: {} });
    yield* Deferred.await(done);
    expect(saves.map(({ name, details }) => ({ name, details }))).toEqual([
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
  }).pipe(Effect.scoped),
);

it.effect("puts kept keys back into an agent of the same kind, and only that kind", () =>
  Effect.gen(function* () {
    const settings = yield* fakeSettings({
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
  }).pipe(Effect.scoped),
);
