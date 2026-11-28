import { AccountId, AccountsError, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Redacted, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { AccountKeychain } from "./AccountVault.ts";
import { makeAccountsRpcHandlers } from "./AccountsRpcHandlers.ts";
import { ACCOUNTS_AWAIT_PERSON } from "./awaitPerson.ts";
import type { CustomModelAccountResolver } from "../../customModels.ts";
import {
  makeHarness,
  memoryStore,
  recordingKeychain,
  website,
  windowLeases,
} from "./Accounts.testkit.ts";

const backgroundRunning = { desktopBackgroundRunning: true };
const paperQueue = {
  root: "/synthetic/project",
  waiting: 1,
  saved: 0,
  failed: 0,
  requests: [],
  paused: [],
};
const origin = "http://127.0.0.1:8080";
const modelKey = {
  name: "Synthetic model key",
  details: {
    kind: "api-key" as const,
    sites: [origin],
    auth: { type: "bearer" as const },
    purpose: "custom-models" as const,
  },
  secrets: { token: { type: "scient" as const, value: "synthetic-model-key" } },
};

/** A model catalog that keeps every resolver Accounts installs; `reinstalled` on the second. */
const modelCatalogFixture = Effect.fn("AccountsUnattendedTest.modelCatalog")(function* () {
  const resolvers: Array<CustomModelAccountResolver> = [];
  const reinstalled = yield* Deferred.make<void>();
  const modelCatalog = {
    connections: Effect.succeed([]),
    readLegacy: () => Effect.undefined,
    removeLegacy: () => Effect.void,
    setBinding: () => Effect.succeed(true),
    installResolver: (resolve: CustomModelAccountResolver) =>
      Effect.sync(() => void resolvers.push(resolve)).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            resolvers.length > 1 ? Deferred.succeed(reinstalled, undefined) : Effect.void,
          ),
        ),
        Effect.asVoid,
      ),
  };
  return { resolvers, reinstalled, modelCatalog };
});

it.effect("work before the person's first use of Accounts shows no prompt and loses nothing", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain(backgroundRunning);
    const { leases, atWindow } = yield* windowLeases(true);
    const before = yield* makeHarness({ storage, keychain, leases });
    const { accountId } = yield* before.service.save(website());
    const records = new Map(storage.blobs);
    reads.length = 0;

    yield* atWindow(false);
    const { service } = yield* makeHarness({ storage, keychain, leases });
    // What runs before any foreground use: paper recovery, then unattended work that asks first.
    yield* service.setPaperQueue(paperQueue);
    expect(yield* service.openWithoutPrompt).toBe(false);
    expect(reads).toEqual([]);
    expect(new Map(storage.blobs)).toEqual(records);

    // The next use with someone at a window opens the store, with everything in it.
    yield* atWindow(true);
    const snapshot = yield* service.snapshot;
    expect(reads).toHaveLength(1);
    expect(snapshot.accounts.map((account) => account.accountId)).toEqual([accountId]);
    expect(snapshot.paperQueues?.map((queue) => queue.root)).toEqual(["/synthetic/project"]);
  }),
);

it.effect(
  "custom models linked to saved keys make no keychain call before the person uses Accounts",
  () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { keychain, reads } = yield* recordingKeychain(backgroundRunning);
      const { resolvers, reinstalled, modelCatalog } = yield* modelCatalogFixture();
      const { leases, atWindow } = yield* windowLeases(true);
      const before = yield* makeHarness({
        storage,
        keychain,
        sourceOverrides: { modelCatalog },
        leases,
      });
      const { accountId } = yield* before.service.save(modelKey);
      reads.length = 0;
      resolvers.length = 0;

      // Provider probes resolve the linked model's key with nobody at a window.
      yield* atWindow(false);
      const { service } = yield* makeHarness({
        storage,
        keychain,
        sourceOverrides: { modelCatalog },
        leases,
      });
      const probe = resolvers[0]!;
      const refused = yield* probe(accountId, origin, "openai-completions").pipe(Effect.flip);
      expect(refused.reason).toBe("unavailable");
      expect(reads).toEqual([]);

      // The person's first use opens the store; the key resolves again without a second prompt.
      yield* atWindow(true);
      yield* service.snapshot;
      expect(reads).toHaveLength(1);
      yield* Deferred.await(reinstalled);
      const { token } = yield* resolvers[1]!(accountId, origin, "openai-completions");
      expect(Redacted.value(token)).toBe("synthetic-model-key");
      expect(reads).toHaveLength(1);
    }),
);

it.effect.each([
  { host: "a desktop that quits with its last window", desktopBackgroundRunning: false },
  {
    host: "a backend its desktop did not launch, in a shell with the desktop's old flag",
    desktopBackgroundRunning: undefined,
    environment: { SCIENT_DESKTOP_BACKGROUND_RUNNING: "true" },
  },
] as const)("on $host, unattended work opens the store as before background running", (host) =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain(host);
    const { resolvers, modelCatalog } = yield* modelCatalogFixture();
    // A provider probe before Accounts was ever opened opens it, and finds no such key.
    const before = yield* makeHarness({ storage, keychain, sourceOverrides: { modelCatalog } });
    const missing = yield* resolvers[0]!(
      AccountId.make("acc_synthetic-missing"),
      origin,
      "openai-completions",
    ).pipe(Effect.flip);
    expect(missing.reason).toBe("not-found");
    const { accountId } = yield* before.service.save(modelKey);

    // At the next start paper recovery opens the store, and a probe resolves the linked key.
    reads.length = 0;
    resolvers.length = 0;
    const restarted = yield* makeHarness({ storage, keychain, sourceOverrides: { modelCatalog } });
    yield* restarted.service.setPaperQueue(paperQueue);
    expect(reads).toHaveLength(1);
    const { token } = yield* resolvers[0]!(accountId, origin, "openai-completions");
    expect(Redacted.value(token)).toBe("synthetic-model-key");
    expect(reads).toHaveLength(1);

    // Other unattended work, such as renewal, opens it too.
    reads.length = 0;
    const { service } = yield* makeHarness({ storage, keychain });
    expect(yield* service.openWithoutPrompt).toBe(true);
    expect(reads).toHaveLength(1);
  }),
);

it.effect("an app's own Accounts request opens the store only with someone at a window", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain(backgroundRunning);
    const { leases, atWindow } = yield* windowLeases(true);
    yield* (yield* makeHarness({ storage, keychain, leases })).service.save(website());
    reads.length = 0;
    yield* atWindow(false);
    const { service } = yield* makeHarness({ storage, keychain, leases });
    const unused = () => Effect.die("unused");
    const handlers = makeAccountsRpcHandlers({
      accounts: service,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStream: (_method, stream) => stream,
      check: unused,
      linkKey: unused,
      restoreKeptKeys: unused,
      paperForSource: unused,
      plainKeys: { find: unused, keep: unused },
      papers: {
        request: unused,
        continue: unused,
        list: unused,
        signInAsPerson: unused,
        universityBrowse: unused,
        universities: unused,
        universitySignOut: unused,
      },
    });
    // A web tab left open in the background asks for the snapshot after the backend restarts.
    const refused = yield* Effect.flip(
      handlers[WS_METHODS.accountsSnapshot]({ omitExternalIdentities: true }),
    );
    // regression: every Accounts request counted as the person's, and opened the store.
    expect(refused.message).toBe(ACCOUNTS_AWAIT_PERSON);
    expect(reads).toEqual([]);
    // The person at the window: the same request opens it.
    yield* atWindow(true);
    yield* handlers[WS_METHODS.accountsSnapshot]({ omitExternalIdentities: true });
    expect(reads).toHaveLength(1);
  }),
);

it.effect("a store refused for want of a person opens once someone comes to a window", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain(backgroundRunning);
    const { leases, atWindow } = yield* windowLeases(true);
    yield* (yield* makeHarness({ storage, keychain, leases })).service.save(website());
    reads.length = 0;
    yield* atWindow(false);
    let dismissed = true;
    // The keychain's dialog, which the person may dismiss.
    const asking: AccountKeychain = {
      ...keychain,
      read: (account) =>
        keychain.read(account).pipe(
          Effect.filterOrFail(
            () => !dismissed,
            () => new AccountsError({ reason: "unavailable", message: "Dismissed." }),
          ),
        ),
    };
    const { service } = yield* makeHarness({ storage, keychain: asking, leases });
    const published = yield* Ref.make(false);
    yield* service.changes.pipe(
      Stream.take(1),
      Stream.runDrain,
      Effect.andThen(Ref.set(published, true)),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    // Unattended work finds the store closed, with nobody at a window, now and again while away.
    for (let refusal = 0; refusal < 3; refusal++) {
      expect((yield* Effect.flip(service.snapshot)).message).toBe(ACCOUNTS_AWAIT_PERSON);
      yield* TestClock.adjust("1 minute");
    }
    expect(reads).toEqual([]);
    // The person comes to a window and dismisses the dialog: one try for all three, no other.
    // regression: refusals made while the first waited for the person tried again at once.
    yield* atWindow(true);
    yield* TestClock.adjust("1 second");
    expect(reads).toHaveLength(1);
    yield* TestClock.adjust("1 minute");
    expect(reads).toHaveLength(1);
    // Away again, another refusal; back, and the dialog answered: the store opens and says so.
    dismissed = false;
    yield* atWindow(false);
    yield* Effect.flip(service.snapshot);
    yield* atWindow(true);
    yield* TestClock.adjust("1 second");
    // regression: a refused open stayed closed until something else asked again.
    expect(reads).toHaveLength(2);
    expect(yield* service.openWithoutPrompt).toBe(true);
    yield* Effect.yieldNow;
    expect(yield* Ref.get(published)).toBe(true);
  }),
);
