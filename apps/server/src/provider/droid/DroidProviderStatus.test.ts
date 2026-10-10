import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ServerProviderShape } from "../ServerProvider.ts";
import { makeDroidProviderStatus } from "./DroidProviderStatus.ts";

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("droid"),
    driver: ProviderDriverKind.make("droid"),
    enabled: true,
    installed: true,
    version: "0.228.0",
    status: "ready",
    auth: { status: "authenticated", type: "apiKey", label: "Factory API Key" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

/** A managed snapshot whose `refresh` is a counted full (session-creating) probe. */
const fixture = (initial: ServerProvider, versions: Array<Option.Option<string | null>>) => {
  let current = initial;
  let fullProbes = 0;
  let versionChecks = 0;
  let lastVersion: Option.Option<string | null> = Option.none();
  const provider: ServerProviderShape = {
    resolveMaintenance: () => Effect.die("unused"),
    applyUsageLimits: () => Effect.void,
    getSnapshot: Effect.sync(() => current),
    // A probe reports the binary it found.
    refresh: Effect.sync(() => {
      fullProbes++;
      if (Option.isSome(lastVersion)) current = { ...current, version: lastVersion.value };
      return current;
    }),
    streamChanges: Stream.empty,
  };
  return {
    provider,
    set: (next: ServerProvider) => {
      current = next;
    },
    probeVersion: Effect.sync(() => {
      lastVersion = versions[Math.min(versionChecks++, versions.length - 1)]!;
      return lastVersion;
    }),
    counts: () => ({ fullProbes, versionChecks }),
  };
};

const run = (
  initial: ServerProvider,
  versions: Array<Option.Option<string | null>>,
  demand = true,
) =>
  Effect.gen(function* () {
    const droid = fixture(initial, versions);
    const status = yield* makeDroidProviderStatus({
      provider: droid.provider,
      probeVersion: droid.probeVersion,
      refreshInterval: Effect.succeed("5 minutes"),
      hasDemand: Effect.succeed(demand),
    });
    return { droid, status };
  });

describe("Droid periodic status", () => {
  it.effect("checks only the binary while Droid stays healthy", () =>
    Effect.gen(function* () {
      const { droid } = yield* run(snapshot(), [Option.some("0.228.0")]);
      yield* TestClock.adjust("16 minutes");
      expect(droid.counts()).toEqual({ fullProbes: 0, versionChecks: 3 });
    }),
  );

  it.effect("probes fully once the binary changes or stops answering", () =>
    Effect.gen(function* () {
      const { droid } = yield* run(snapshot(), [
        Option.some("0.228.0"),
        Option.some("0.230.0"),
        Option.none(),
      ]);
      yield* TestClock.adjust("16 minutes");
      expect(droid.counts()).toEqual({ fullProbes: 2, versionChecks: 3 });
    }),
  );

  it.effect("recovers a failed probe", () =>
    Effect.gen(function* () {
      const failed = yield* run(snapshot({ status: "error" }), [Option.some("0.228.0")]);
      yield* TestClock.adjust("6 minutes");
      expect(failed.droid.counts().fullProbes).toBe(1);
    }),
  );

  it.effect("checks a signed-out Droid's binary without ever probing it", () =>
    Effect.gen(function* () {
      // A probe of a signed-out Droid starts a session and mints a pairing code.
      const signedOut = snapshot({
        status: "warning",
        auth: { status: "unauthenticated", required: true },
        message: "Droid is installed. Sign in with your existing Factory subscription.",
      });
      const { droid, status } = yield* run(signedOut, [
        Option.some("0.228.0"),
        Option.some("0.231.0"),
        Option.none(),
        Option.some("0.228.0"),
      ]);
      const published: Array<string | null | undefined> = [];
      yield* status.provider.streamChanges.pipe(
        Stream.runForEach((shown) => Effect.sync(() => void published.push(shown.version))),
        Effect.forkScoped,
      );
      const shown = Effect.map(status.provider.getSnapshot, (current) => ({
        status: current.status,
        version: current.version,
        auth: current.auth.status,
        message: current.message,
      }));
      const asProbed = {
        status: "warning",
        version: "0.228.0",
        auth: "unauthenticated",
        message: signedOut.message,
      };

      yield* TestClock.adjust("6 minutes");
      expect(yield* shown).toEqual(asProbed);
      // Replaced by another release: still signed out, with the version that is there now.
      yield* TestClock.adjust("5 minutes");
      expect(yield* shown).toEqual({ ...asProbed, version: "0.231.0" });
      // Removed or broken: there is nothing to sign in to.
      yield* TestClock.adjust("5 minutes");
      expect(yield* shown).toEqual({
        status: "error",
        version: null,
        auth: "unknown",
        message:
          "Droid CLI no longer runs (`droid --version` failed). Reinstall it or correct its path, then check again.",
      });
      // Back as it was probed.
      yield* TestClock.adjust("5 minutes");
      expect(yield* shown).toEqual(asProbed);
      expect(droid.counts()).toEqual({ fullProbes: 0, versionChecks: 4 });
      expect(published).toEqual(["0.231.0", null, "0.228.0"]);
    }),
  );

  it.effect("backs off recovery probes that keep failing, but still notices a new binary", () =>
    Effect.gen(function* () {
      const { droid } = yield* run(snapshot({ status: "error" }), [Option.some("0.228.0")]);
      yield* TestClock.adjust("36 minutes");
      // Full probes at 5, 15 and 35 minutes instead of every 5 minutes.
      expect(droid.counts()).toEqual({ fullProbes: 3, versionChecks: 4 });
      const replaced = yield* run(snapshot({ status: "error" }), [Option.some("0.229.0")]);
      yield* TestClock.adjust("14 minutes");
      // 5: recovery probe; 10: backing off, but the binary was replaced.
      expect(replaced.droid.counts()).toEqual({ fullProbes: 2, versionChecks: 1 });
    }),
  );

  it.effect("leaves a pending probe alone", () =>
    Effect.gen(function* () {
      const { droid } = yield* run(snapshot({ probePending: true, version: null }), [
        Option.some("0.228.0"),
      ]);
      yield* TestClock.adjust("16 minutes");
      expect(droid.counts()).toEqual({ fullProbes: 0, versionChecks: 0 });
    }),
  );

  it.effect("does nothing without status demand", () =>
    Effect.gen(function* () {
      const { droid } = yield* run(snapshot({ status: "error" }), [Option.none()], false);
      yield* TestClock.adjust("16 minutes");
      expect(droid.counts()).toEqual({ fullProbes: 0, versionChecks: 0 });
    }),
  );
});

describe("Droid account rejection", () => {
  it.effect("points at the environment's key, not a sign-in, when Droid uses FACTORY_API_KEY", () =>
    Effect.gen(function* () {
      const { status } = yield* run(snapshot(), [Option.some("0.228.0")]);
      yield* status.reportAccountRejected("401 Invalid API key");
      const shown = yield* status.provider.getSnapshot;
      // The key is the environment's: Scient offers no sign-in that would replace it.
      expect(shown.auth).toEqual({ status: "unauthenticated", required: true, type: "apiKey" });
      expect(shown.message).toBe(
        "Factory rejected FACTORY_API_KEY: 401 Invalid API key. Correct the key in Droid's environment, then check again.",
      );
    }),
  );

  it.effect("asks a Factory account to sign in again", () =>
    Effect.gen(function* () {
      const { status } = yield* run(
        snapshot({
          auth: { status: "authenticated", type: "subscription", label: "Factory account" },
        }),
        [Option.some("0.228.0")],
      );
      yield* status.reportAccountRejected("401 Session expired");
      const shown = yield* status.provider.getSnapshot;
      expect(shown.auth).toEqual({ status: "unauthenticated", required: true });
      expect(shown.message).toBe(
        "Factory rejected Droid's sign-in: 401 Session expired. Sign in again.",
      );
    }),
  );

  it.effect("shows a rejected account as signed out until a probe succeeds", () =>
    Effect.gen(function* () {
      const { droid, status } = yield* run(snapshot(), [Option.some("0.228.0")]);
      const changes = yield* status.provider.streamChanges.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
      yield* status.reportAccountRejected("401 Invalid API key");
      const [published] = Array.from(yield* Fiber.join(changes));
      for (const shown of [published, yield* status.provider.getSnapshot]) {
        expect(shown?.auth.status).toBe("unauthenticated");
        expect(shown?.status).toBe("warning");
        expect(shown?.message).toContain("401 Invalid API key");
      }
      // A failed probe does not clear it; a successful one does.
      yield* status.observeProbe(snapshot({ status: "error" }));
      expect((yield* status.provider.getSnapshot).auth.status).toBe("unauthenticated");
      droid.set(snapshot());
      yield* status.observeProbe(snapshot());
      expect((yield* status.provider.getSnapshot).auth.status).toBe("authenticated");
    }),
  );
});
