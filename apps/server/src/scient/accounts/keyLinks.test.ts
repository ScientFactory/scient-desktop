// @effect-diagnostics nodeBuiltinImport:off -- Digests of synthetic followed values.
import * as NodeCrypto from "node:crypto";
import {
  AccountId,
  AccountsError,
  ProviderInstanceId,
  defaultAccountControls,
  type AccountKeyLink,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fakeAccounts, makeHarness } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import * as AccountKeyLinks from "./keyLinks.ts";
import { makeAccountKeyLinks } from "./keyLinks.ts";

const accountId = AccountId.make("acc_fixture1");
const instanceId = ProviderInstanceId.make("codex");
const link = { accountId, instanceId, variable: "OPENAI_API_KEY" };
const controls = defaultAccountControls("api-key");
const saved = {
  accountId,
  controls,
  details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
  updatedAt: "2026-11-09T00:00:00.000Z",
};

/** Provider settings holding one agent's variables, changed in place as the real store does. */
const providerSettings = Effect.fn("KeyLinksTest.providerSettings")(function* (
  variables: ReadonlyArray<{ name: string; value: string; sensitive: boolean }>,
) {
  let environment = [...variables];
  const writes: Array<ReadonlyArray<unknown>> = [];
  const reads = yield* Queue.unbounded<void>();
  let waited = 0;
  const service = {
    subscribeChanges: Effect.succeed(Stream.empty),
    getSettings: Effect.sync(() => ({
      providerInstances: { [instanceId]: { driver: "codex", environment } },
    })),
    updateProviderVariable: (
      _: unknown,
      name: string,
      next: (value: unknown) => string | undefined,
    ) =>
      Effect.sync(() => {
        const variable = environment.find((item) => item.name === name);
        const value = variable ? next(variable.value) : undefined;
        if (value !== undefined) {
          environment = environment.map((item) =>
            item.name === name ? { name, value, sensitive: true } : item,
          );
          writes.push(environment);
        }
        return variable !== undefined;
      }).pipe(Effect.tap(() => Queue.offer(reads, undefined))),
  } as unknown as ServerSettingsService["Service"];
  return {
    service,
    writes,
    /** Waits until the follower has looked at the variable `count` times in all. */
    looked: (count: number) =>
      Effect.gen(function* () {
        for (; waited < count; waited++) yield* Queue.take(reads);
      }),
    type: (value: string) => {
      environment = environment.map((item) =>
        item.name === "OPENAI_API_KEY" ? { ...item, value } : item,
      );
    },
  };
});

const run = Effect.fn("KeyLinksTest.run")(function* (value: string, account: unknown = saved) {
  const settings = yield* providerSettings([
    { name: "OPENAI_API_KEY", value, sensitive: true },
    { name: "CODEX_HOME", value: "/home", sensitive: false },
  ]);
  const fake = fakeAccounts({ accounts: [account as never], values: { token: "saved-key" } });
  return yield* Effect.scoped(
    makeAccountKeyLinks(fake.service).pipe(
      Effect.flatMap((linkKey) => linkKey(link)),
      Effect.as(settings.writes),
      Effect.provideService(ServerSettingsService, settings.service),
    ),
  );
});

it.effect("copies the saved key into the variable and leaves the others alone", () =>
  Effect.gen(function* () {
    expect(yield* run("old")).toEqual([
      [
        { name: "OPENAI_API_KEY", value: "saved-key", sensitive: true },
        { name: "CODEX_HOME", value: "/home", sensitive: false },
      ],
    ]);
  }),
);

it.effect("never links a variable to a key kept for another use", () =>
  Effect.gen(function* () {
    const kept = {
      ...saved,
      details: { ...saved.details, privateTo: { kind: "text-generator", id: "gen", name: "Gen" } },
    };
    const refused = yield* Effect.flip(run("old", kept));
    expect(refused.message).toBe("This key stays with its own use.");
  }),
);

it.effect("writes nothing when the variable already has the key", () =>
  Effect.gen(function* () {
    expect(yield* run("saved-key")).toEqual([]);
  }),
);

it.effect("follows a key while it reaches agents, and never replaces a value typed there", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<AccountsSnapshot>();
    const settings = yield* providerSettings([
      { name: "OPENAI_API_KEY", value: "old-key", sensitive: true },
    ]);
    const fake = fakeAccounts({ values: { token: "saved-key" } });
    // The link as Accounts keeps it, with the copies the follower records.
    let followed: AccountKeyLink = link;
    const offer = (account: typeof saved | undefined) =>
      Queue.offer(changes, {
        agentAccess: true,
        accounts: account ? [account] : [],
        keyLinks: [followed],
      } as unknown as AccountsSnapshot);
    yield* Layer.build(
      AccountKeyLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AccountsService, {
              ...fake.service,
              changes: Stream.fromQueue(changes),
              setKeyLink: (_target, _accountId, copies) =>
                Effect.sync(() => {
                  followed = { ...link, ...(copies ? { copies } : {}) };
                }),
            }),
            Layer.succeed(ServerSettingsService, settings.service),
          ),
        ),
      ),
    );
    const valueAt = (count: number) =>
      settings
        .looked(count)
        .pipe(
          Effect.map(() => (settings.writes.at(-1)?.[0] as { value: string } | undefined)?.value),
        );
    yield* offer(saved);
    expect(yield* valueAt(1)).toBe("saved-key");
    // Removed (or Off): new agents don't get it. Undo brings the row back, and the key with it.
    yield* offer(undefined);
    expect(yield* valueAt(2)).toBe("");
    yield* offer(saved);
    expect(yield* valueAt(3)).toBe("saved-key");
    // Typed over the copy, the value is the person's: Off, On, a rotation and Undo all leave it.
    settings.type("typed-key");
    yield* offer({ ...saved, controls: { ...controls, access: "off" } });
    yield* settings.looked(4);
    yield* offer({ ...saved, updatedAt: "2026-11-10T00:00:00.000Z" });
    yield* settings.looked(5);
    yield* offer(undefined);
    yield* settings.looked(6);
    yield* offer(saved);
    yield* settings.looked(7);
    expect(settings.writes).toHaveLength(3);
    // Emptied by the person, it is nobody's again.
    settings.type("");
    yield* offer({ ...saved, updatedAt: "2026-11-11T00:00:00.000Z" });
    expect(yield* valueAt(8)).toBe("saved-key");
  }).pipe(Effect.scoped),
);

it.effect("takes back a removed key's copy after a restart, without reading any key", () =>
  Effect.gen(function* () {
    const settings = yield* providerSettings([
      { name: "OPENAI_API_KEY", value: "saved-key", sensitive: true },
    ]);
    // Removed just before the server stopped: the copy's digest is all that is left of it.
    const copies = [NodeCrypto.createHash("sha256").update("saved-key").digest("base64url")];
    const fake = fakeAccounts();
    yield* Layer.build(
      AccountKeyLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AccountsService, {
              ...fake.service,
              resolveSecrets: () => Effect.die("no key is read to take one back"),
              changes: Stream.make({
                agentAccess: true,
                accounts: [],
                keyLinks: [{ ...link, copies }],
              } as unknown as AccountsSnapshot),
            }),
            Layer.succeed(ServerSettingsService, settings.service),
          ),
        ),
      ),
    );
    yield* settings.looked(1);
    expect(settings.writes).toEqual([[{ name: "OPENAI_API_KEY", value: "", sensitive: true }]]);
  }).pipe(Effect.scoped),
);

it.effect(
  "takes a copy back the moment access is taken, and a key read begun before stays out",
  () =>
    Effect.gen(function* () {
      const settings = yield* providerSettings([
        { name: "OPENAI_API_KEY", value: "manual-key", sensitive: true },
      ]);
      const [reading, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      let takeBack:
        | ((links: ReadonlyArray<AccountKeyLink>) => Effect.Effect<void, AccountsError>)
        | undefined;
      const fake = fakeAccounts({ accounts: [saved as never], values: { token: "saved-key" } });
      const service = {
        ...fake.service,
        onAccessTaken: (hook: typeof takeBack) => Effect.sync(() => void (takeBack = hook)),
        // The store waits on a prompt while the key is turned Off.
        resolveSecrets: () =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(answer)),
            Effect.as({ token: Redacted.make("saved-key") }),
          ),
      } as typeof fake.service;
      const linkKey = yield* makeAccountKeyLinks(service).pipe(
        Effect.provideService(ServerSettingsService, settings.service),
      );
      const linking = yield* linkKey(link).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      yield* takeBack!([{ ...link, copies: [] }]);
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(linking);
      expect(settings.writes).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("clears a retired link's copy, and never a value a fresh link didn't write", () =>
  Effect.gen(function* () {
    const settings = yield* providerSettings([
      { name: "OPENAI_API_KEY", value: "saved-key", sensitive: true },
      { name: "OTHER_KEY", value: "typed-key", sensitive: true },
    ]);
    const copies = [NodeCrypto.createHash("sha256").update("saved-key").digest("base64url")];
    yield* Layer.build(
      AccountKeyLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AccountsService, {
              ...fakeAccounts().service,
              changes: Stream.make({
                agentAccess: true,
                accounts: [{ ...saved, controls: { ...controls, access: "off" } }],
                // Linked to an Off key by the person: owns nothing yet.
                keyLinks: [{ ...link, variable: "OTHER_KEY", copies: [] }],
                detachedKeyLinks: [{ ...link, copies }],
              } as unknown as AccountsSnapshot),
            }),
            Layer.succeed(ServerSettingsService, settings.service),
          ),
        ),
      ),
    );
    yield* settings.looked(2);
    expect(settings.writes).toEqual([
      [
        { name: "OPENAI_API_KEY", value: "", sensitive: true },
        { name: "OTHER_KEY", value: "typed-key", sensitive: true },
      ],
    ]);
    // Linking a variable to a key that doesn't reach records that the link owns nothing.
    const recorded: Array<unknown> = [];
    const off = fakeAccounts({
      accounts: [{ ...saved, controls: { ...controls, access: "off" } } as never],
    });
    const linkKey = yield* makeAccountKeyLinks({
      ...off.service,
      setKeyLink: (_target, _accountId, copies) => Effect.sync(() => void recorded.push(copies)),
    }).pipe(Effect.provideService(ServerSettingsService, settings.service));
    yield* linkKey({ ...link, variable: "OTHER_KEY" });
    expect(recorded).toEqual([[]]);
  }).pipe(Effect.scoped),
);

it.effect(
  "links on record before the key is read; a relink clears the old copy, never a typed value",
  () =>
    Effect.gen(function* () {
      const settings = yield* providerSettings([
        { name: "OPENAI_API_KEY", value: "key-a", sensitive: true },
      ]);
      const second = AccountId.make("acc_fixture2");
      const copyOfA = NodeCrypto.createHash("sha256").update("key-a").digest("base64url");
      // Accounts as the service keeps them: links change as they are set.
      let links: Array<AccountKeyLink> = [{ ...link, copies: [copyOfA] }];
      const [reading, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const fake = fakeAccounts({
        accounts: [saved as never, { ...saved, accountId: second } as never],
      });
      const service = {
        ...fake.service,
        snapshot: Effect.map(fake.service.snapshot, (snapshot) => ({
          ...snapshot,
          keyLinks: links,
        })),
        setKeyLink: (
          target: Pick<AccountKeyLink, "instanceId" | "variable">,
          id?: AccountId,
          copies?: ReadonlyArray<string>,
        ) =>
          Effect.sync(() => {
            links = id ? [{ ...target, accountId: id, ...(copies ? { copies } : {}) }] : [];
          }),
        resolveSecrets: () =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(answer)),
            Effect.as({ token: Redacted.make("key-b") }),
          ),
      } as typeof fake.service;
      const linkKey = yield* makeAccountKeyLinks(service).pipe(
        Effect.provideService(ServerSettingsService, settings.service),
      );
      const linking = yield* linkKey({ ...link, accountId: second }).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      // A's copy went before B was linked, and B is on record while its store is read.
      expect(settings.writes).toEqual([[{ name: "OPENAI_API_KEY", value: "", sensitive: true }]]);
      expect(links.map(({ accountId }) => accountId)).toEqual([second]);
      // The person types a value meanwhile: B's late key never lands over it.
      settings.type("typed-key");
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(linking);
      expect(settings.writes).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("an earlier link that finishes late never takes over a later one", () =>
  Effect.gen(function* () {
    const settings = yield* providerSettings([
      { name: "OPENAI_API_KEY", value: "manual-key", sensitive: true },
    ]);
    const [reading, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            resolve: () =>
              Deferred.succeed(reading, undefined).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.as(Redacted.make("key-a")),
              ),
          }),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    const key = (secret: Parameters<typeof service.save>[0]["secrets"]["token"]) =>
      service.save({
        name: "Synthetic key",
        details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
        secrets: { token: secret! },
      });
    const a = yield* key({ type: "1password", reference: "op://vault/item/key" });
    const b = yield* key({ type: "scient", value: "key-b" });
    const linkKey = yield* makeAccountKeyLinks(service).pipe(
      Effect.provideService(ServerSettingsService, settings.service),
    );
    // A's key waits on 1Password; meanwhile the variable is linked to B instead.
    const first = yield* linkKey({ ...link, accountId: a.accountId }).pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    yield* linkKey({ ...link, accountId: b.accountId });
    yield* Deferred.succeed(answer, undefined);
    yield* Fiber.join(first);
    const [followed] = (yield* service.snapshot).keyLinks ?? [];
    expect(followed?.accountId).toBe(b.accountId);
    expect(followed?.copies).toEqual([
      NodeCrypto.createHash("sha256").update("key-b").digest("base64url"),
    ]);
    expect(settings.writes.at(-1)).toEqual([
      { name: "OPENAI_API_KEY", value: "key-b", sensitive: true },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("takes a revoked copy back before the server starts taking sessions", () =>
  Effect.gen(function* () {
    const settings = yield* providerSettings([
      { name: "OPENAI_API_KEY", value: "saved-key", sensitive: true },
    ]);
    const copies = [NodeCrypto.createHash("sha256").update("saved-key").digest("base64url")];
    const fake = fakeAccounts({
      accounts: [{ ...saved, controls: { ...controls, access: "off" } } as never],
    });
    yield* makeAccountKeyLinks({
      ...fake.service,
      snapshot: Effect.map(fake.service.snapshot, (snapshot) => ({
        ...snapshot,
        keyLinks: [{ ...link, copies }],
      })),
      // No change arrives: only the start itself can take it back.
      changes: Stream.never,
    }).pipe(Effect.provideService(ServerSettingsService, settings.service));
    expect(settings.writes).toEqual([[{ name: "OPENAI_API_KEY", value: "", sensitive: true }]]);
  }).pipe(Effect.scoped),
);

const keep = Effect.fn("KeyLinksTest.keep")(function* (
  accounts: ReadonlyArray<unknown>,
  values: Readonly<Record<string, string>>,
) {
  const links: Array<unknown> = [];
  const settings = yield* providerSettings([
    { name: "OPENAI_API_KEY", value: "typed-key", sensitive: true },
  ]);
  const fake = fakeAccounts({ accounts: accounts as never, values });
  const service = {
    ...fake.service,
    setKeyLink: (target: unknown, id: unknown) => Effect.sync(() => void links.push([target, id])),
  } as typeof fake.service;
  return yield* Effect.scoped(
    makeAccountKeyLinks(service).pipe(
      Effect.flatMap((linkKey) => linkKey({ instanceId, variable: "OPENAI_API_KEY" })),
      Effect.as({ saves: fake.saves, links, writes: settings.writes }),
      Effect.provideService(ServerSettingsService, settings.service),
    ),
  );
});

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
    expect(links.slice(-1)).toEqual([
      [
        { instanceId, variable: "OPENAI_API_KEY", accountId: "acc_saved_0001", copies: [] },
        "acc_saved_0001",
      ],
    ]);
  }),
);

it.effect("links to an account already holding the same key instead of keeping it twice", () =>
  Effect.gen(function* () {
    // Saved under another variable name, or none: still the same key.
    const existing = {
      accountId,
      controls,
      details: { kind: "api-key", envName: "OPENAI_KEY" },
      secrets: { token: { source: { type: "scient" } } },
    };
    const { saves, links } = yield* keep([existing], { token: "typed-key" });
    expect(saves).toEqual([]);
    expect(links.slice(-1)).toEqual([
      [{ instanceId, variable: "OPENAI_API_KEY", accountId, copies: [] }, accountId],
    ]);
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
    expect(links.slice(-1)).toEqual([
      [
        { instanceId, variable: "OPENAI_API_KEY", accountId: "acc_saved_0001", copies: [] },
        "acc_saved_0001",
      ],
    ]);
  }),
);
