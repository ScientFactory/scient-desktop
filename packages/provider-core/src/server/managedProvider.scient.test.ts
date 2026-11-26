import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./maintenanceResolver.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

const hostLayer = Layer.succeed(
  ProviderHost.ProviderHost,
  ProviderHost.ProviderHost.of({
    compatibility: () => Effect.undefined,
    paths: {
      cwd: process.cwd(),
      baseDir: "/t3",
      stateDir: "/t3/userdata",
      providerStatusCacheDir: "/t3/caches",
      attachmentsDir: "/t3/userdata/attachments",
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(true),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("unused"),
  }),
);

const limits = {
  checkedAt: "2026-04-10T00:00:01.000Z",
  windows: [{ id: "gemini-5h", kind: "session" as const, label: "Gemini", usedPercent: 40 }],
};

const signedIn: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: limits,
};

const { usageLimits: _limits, ...withoutLimits } = signedIn;

const makeProvider = Effect.fn("makeProvider")(function* () {
  const publisher = yield* Deferred.make<(snapshot: ServerProvider) => Effect.Effect<void>>();
  const provider = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: ProviderDriverKind.make("antigravity"),
          packageName: null,
        }),
      ),
    getSettings: Effect.succeed({ enabled: true }),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => Effect.succeed(signedIn),
    checkProvider: Effect.succeed(signedIn),
    enrichSnapshot: ({ publishSnapshot }) =>
      Deferred.succeed(publisher, publishSnapshot).pipe(Effect.andThen(Effect.never)),
    refreshInterval: "1 hour",
  });
  yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
  return { provider, publish: yield* Deferred.await(publisher) };
});

describe("managed provider enrichment after sign-out", () => {
  it.effect("a signed-out snapshot drops the previous account's limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, publish } = yield* makeProvider();
        assert.deepStrictEqual((yield* provider.getSnapshot).usageLimits, limits);
        const update = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* publish({
          ...withoutLimits,
          status: "warning",
          auth: { status: "unauthenticated" },
        });

        const [published] = Array.from(yield* Fiber.join(update));
        assert.strictEqual(published?.auth.status, "unauthenticated");
        assert.strictEqual(published?.usageLimits, undefined);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits, undefined);
      }),
    ).pipe(Effect.provide(hostLayer)),
  );

  it.effect("a signed-in enrichment without limits keeps the published ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, publish } = yield* makeProvider();
        yield* publish({ ...withoutLimits, checkedAt: "2026-04-10T00:00:02.000Z" });
        assert.deepStrictEqual((yield* provider.getSnapshot).usageLimits, limits);
      }),
    ).pipe(Effect.provide(hostLayer)),
  );
});
