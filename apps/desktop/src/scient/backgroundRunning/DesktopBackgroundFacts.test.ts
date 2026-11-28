// @effect-diagnostics nodeBuiltinImport:off -- a real temporary journal directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as DesktopUpdateFacts from "../updateOutcomes/DesktopUpdateFacts.ts";
import * as DesktopBackgroundFacts from "./DesktopBackgroundFacts.ts";

interface RecordedFact {
  readonly name: string;
  readonly properties: DesktopUpdateFacts.DesktopUpdateFactProperties;
}

const recording = Effect.fn("test.recording")(function* (platform: NodeJS.Platform = "win32") {
  const recorded: Array<RecordedFact> = [];
  const facts = yield* DesktopBackgroundFacts.make({
    platform,
    record: (name, properties) => Effect.sync(() => void recorded.push({ name, properties })),
  });
  return { facts, recorded };
});

describe("windowlessBucket", () => {
  it.each([
    [0, "under-1m"],
    [59_999, "under-1m"],
    [60_000, "1-10m"],
    [3_599_999, "10-60m"],
    [3_600_000, "1-6h"],
    [21_600_000, "6-24h"],
    [86_400_000, "1-3d"],
    [3 * 86_400_000, "3-7d"],
    [7 * 86_400_000, "over-7d"],
    [-1, "unknown"],
    [Number.NaN, "unknown"],
  ])("puts %s ms with no window in %s", (ms, bucket) => {
    assert.equal(DesktopBackgroundFacts.windowlessBucket(ms), bucket);
  });
});

describe("DesktopBackgroundFacts", () => {
  it.effect(
    "a period ends only when a window shows; failed attempts and timeouts keep it open",
    () =>
      Effect.gen(function* () {
        const { facts, recorded } = yield* recording();
        // With a window open there is no period, so nothing is reported.
        yield* facts.windowRequested;
        yield* facts.windowShown;
        yield* facts.quitDecided(yield* facts.quitStarted, "none");

        yield* facts.windowlessStarted;
        yield* TestClock.adjust("25 minutes");
        yield* facts.windowRequested.pipe(
          Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, "tray"),
        );
        yield* facts.windowShown;
        yield* facts.windowlessStarted;
        yield* TestClock.adjust("2 hours");
        yield* facts.windowRequested.pipe(
          Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, "second-launch"),
        );
        yield* facts.windowNotShown;
        // A request that never brings a window back counts once it times out.
        yield* facts.windowRequested.pipe(
          Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, "dock"),
        );
        yield* TestClock.adjust(DesktopBackgroundFacts.RETURN_TIMEOUT);
        // A retry that shows a window ends the period begun 2 hours and 2 minutes ago.
        yield* facts.windowRequested.pipe(
          Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, "second-launch"),
        );
        yield* TestClock.adjust("30 seconds");
        yield* facts.windowShown;
        yield* TestClock.adjust(DesktopBackgroundFacts.RETURN_TIMEOUT);

        assert.deepEqual(
          recorded.map((fact) => fact.properties),
          [
            {
              kind: "window-returned",
              platform: "windows",
              via: "tray",
              windowlessBucket: "10-60m",
            },
            {
              kind: "window-not-shown",
              platform: "windows",
              via: "second-launch",
              windowlessBucket: "1-6h",
            },
            {
              kind: "window-not-shown",
              platform: "windows",
              via: "dock",
              windowlessBucket: "1-6h",
            },
            {
              kind: "window-returned",
              platform: "windows",
              via: "second-launch",
              windowlessBucket: "1-6h",
            },
          ],
        );
        assert.isTrue(recorded.every((fact) => fact.name === "app.background.event"));
      }).pipe(Effect.scoped),
  );

  it.effect("a cancelled Quit leaves Scient windowless; tray Quit says so once", () =>
    Effect.gen(function* () {
      const { facts, recorded } = yield* recording("linux");
      yield* facts.windowlessStarted;
      yield* TestClock.adjust("8 hours");
      yield* facts.trayQuitChosen;
      yield* facts.quitDecided(yield* facts.quitStarted, "cancelled");
      yield* TestClock.adjust("1 hour");
      yield* facts.quitDecided(yield* facts.quitStarted, "confirmed");
      assert.deepEqual(
        recorded.filter((fact) => fact.name === "app.background.event").map((f) => f.properties),
        [
          {
            kind: "quit",
            platform: "linux",
            via: "tray",
            quitPrompt: "cancelled",
            windowlessBucket: "6-24h",
          },
          {
            kind: "quit",
            platform: "linux",
            via: "other",
            quitPrompt: "confirmed",
            windowlessBucket: "6-24h",
          },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a window shown while Quit asks does not hide the windowless Quit", () =>
    Effect.gen(function* () {
      const { facts, recorded } = yield* recording("win32");
      yield* facts.windowlessStarted;
      yield* TestClock.adjust("3 hours");
      yield* facts.trayQuitChosen;
      const snapshot = yield* facts.quitStarted;
      yield* facts.windowRequested.pipe(
        Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, "tray"),
      );
      yield* facts.windowShown;
      yield* facts.quitDecided(snapshot, "confirmed");
      assert.deepEqual(
        recorded.filter((fact) => fact.name === "app.background.event").map((f) => f.properties),
        [
          { kind: "window-returned", platform: "windows", via: "tray", windowlessBucket: "1-6h" },
          {
            kind: "quit",
            platform: "windows",
            via: "tray",
            quitPrompt: "confirmed",
            windowlessBucket: "1-6h",
          },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a Quit that goes on sends the windowless time since the last summary", () =>
    Effect.gen(function* () {
      const { facts, recorded } = yield* recording("linux");
      yield* facts.summaries(Effect.succeed(true));
      yield* facts.windowlessStarted;
      yield* TestClock.adjust("40 minutes");
      yield* facts.windowShown;
      yield* facts.windowlessStarted;
      yield* TestClock.adjust("30 minutes");
      yield* facts.quitDecided(yield* facts.quitStarted, "cancelled");
      yield* facts.quitDecided(yield* facts.quitStarted, "none");
      // A later Quit with nothing windowless since sends no summary.
      yield* facts.quitDecided(yield* facts.quitStarted, "none");
      assert.deepEqual(
        recorded.filter((fact) => fact.name === "app.background.summary").map((f) => f.properties),
        [
          { reason: "launch", platform: "linux", enabled: true, setBy: "person" },
          {
            reason: "quit",
            platform: "linux",
            enabled: true,
            setBy: "person",
            windowlessCount: 2,
            windowlessTimeBucket: "1-6h",
          },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports failures and setting changes with closed values", () =>
    Effect.gen(function* () {
      const { facts, recorded } = yield* recording("darwin");
      yield* facts.trayFailed("error");
      yield* facts.splashFallback;
      yield* facts.backendRestarted;
      yield* facts.settingChanged({ enabled: false, previous: null });
      yield* facts.settingChanged({ enabled: true, previous: false });
      assert.deepEqual(
        recorded.map((fact) => fact.properties),
        [
          { kind: "tray-failed", platform: "macos", reason: "error" },
          { kind: "splash-fallback", platform: "macos" },
          { kind: "backend-restarted", platform: "macos" },
          { kind: "setting-changed", platform: "macos", enabled: false, previousSetBy: "default" },
          { kind: "setting-changed", platform: "macos", enabled: true, previousSetBy: "person" },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("summarizes at launch and daily: the setting, who set it, and windowless time", () =>
    Effect.gen(function* () {
      const { facts, recorded } = yield* recording("win32");
      let choice: boolean | null = null;
      yield* facts.summaries(Effect.sync(() => choice));
      // Two periods begin this day: one ends after 3 hours, one is still under way after 2 more.
      yield* TestClock.adjust("1 hour");
      yield* facts.windowlessStarted;
      yield* TestClock.adjust("3 hours");
      yield* facts.windowShown;
      choice = true;
      yield* TestClock.adjust("18 hours");
      yield* facts.windowlessStarted;
      yield* TestClock.adjust("2 hours");
      // The next day counts the period under way again only for its time within that day.
      yield* TestClock.adjust("1 day");

      assert.deepEqual(
        recorded
          .filter((fact) => fact.name === "app.background.summary")
          .map((fact) => [fact.name, fact.properties]),
        [
          [
            "app.background.summary",
            { reason: "launch", platform: "windows", enabled: false, setBy: "default" },
          ],
          [
            "app.background.summary",
            {
              reason: "daily",
              platform: "windows",
              enabled: true,
              setBy: "person",
              windowlessCount: 2,
              windowlessTimeBucket: "1-6h",
            },
          ],
          [
            "app.background.summary",
            {
              reason: "daily",
              platform: "windows",
              enabled: true,
              setBy: "person",
              windowlessCount: 0,
              windowlessTimeBucket: "1-3d",
            },
          ],
        ],
      );
    }).pipe(Effect.scoped),
  );
});

function launchLayer(home: string) {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: home,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ SCIENT_NEXT_HOME: home })),
    ),
  );
  return DesktopBackgroundFacts.layer.pipe(
    Layer.provideMerge(DesktopUpdateFacts.layer),
    Layer.provideMerge(environment),
    Layer.provide(
      Layer.succeed(DesktopManagedPolicy.DesktopManagedPolicy, { read: Effect.undefined }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

/** One desktop process in which the last window closes and the tray brings one back. */
function launch(home: string, analytics: "true" | "false") {
  return Effect.gen(function* () {
    const background = yield* DesktopBackgroundFacts.DesktopBackgroundFacts;
    yield* background.summaries(Effect.succeed(true));
    yield* background.windowlessStarted;
    yield* background.windowRequested.pipe(
      Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, "tray"),
    );
    yield* background.windowShown;
    return yield* (yield* DesktopUpdateFacts.DesktopUpdateFacts).pending;
  }).pipe(
    Effect.scoped,
    Effect.provide(launchLayer(home)),
    Effect.provideService(HostProcess.Environment, { SCIENT_ANALYTICS_ENABLED: analytics }),
  );
}

describe("DesktopBackgroundFacts layer", () => {
  it.effect("journals background facts only while analytics is on for the launch", () =>
    Effect.gen(function* () {
      const on = yield* launch(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-background-on-")),
        "true",
      );
      assert.deepEqual(
        on.map((fact) => [fact.name, fact.appVersion, fact.properties]),
        [
          [
            "app.background.summary",
            "1.2.3",
            { reason: "launch", platform: "linux", enabled: true, setBy: "person" },
          ],
          [
            "app.background.event",
            "1.2.3",
            {
              kind: "window-returned",
              platform: "linux",
              via: "tray",
              windowlessBucket: "under-1m",
            },
          ],
        ],
      );

      const offHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-background-off-"));
      assert.deepEqual(yield* launch(offHome, "false"), []);
      assert.isFalse(
        NodeFS.existsSync(
          NodePath.join(offHome, "runtime", DesktopUpdateFacts.DESKTOP_UPDATE_FACTS_FILE),
        ),
      );
    }),
  );
});
