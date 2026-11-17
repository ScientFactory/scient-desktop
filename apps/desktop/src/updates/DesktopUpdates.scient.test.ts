import * as NodeModule from "node:module";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdateFacts from "../scient/updateOutcomes/DesktopUpdateFacts.ts";
import * as DesktopUpdateOutcomes from "../scient/updateOutcomes/DesktopUpdateOutcomes.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness, type UpdatesHarnessOptions } from "./updatesTestHarness.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const requireFromUpdater = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
);
const { newError } = requireFromUpdater("builder-util-runtime") as {
  newError: (message: string, code: string) => Error;
};

type Recorded = { readonly name: string; readonly properties: Record<string, unknown> };

/** The updater with a journal that keeps what it was given. */
function recordingHarness(options: UpdatesHarnessOptions = {}) {
  const recorded: Recorded[] = [];
  const harness = makeHarness(options);
  const facts = Layer.succeed(
    DesktopUpdateFacts.DesktopUpdateFacts,
    DesktopUpdateFacts.DesktopUpdateFacts.of({
      record: (name, properties) => Effect.sync(() => void recorded.push({ name, properties })),
      deliveries: () => Stream.empty,
      sourceReady: () => Effect.void,
      sourceRemoved: () => Effect.void,
      acknowledge: () => Effect.void,
    }),
  );
  const outcomes = (step: string) =>
    recorded
      .filter((fact) => fact.name === "app.update.outcome" && fact.properties.step === step)
      .map((fact) => fact.properties);
  return {
    harness,
    outcomes,
    facts,
    recorded,
    layer: Layer.merge(TestClock.layer(), harness.layer.pipe(Layer.provide(facts))),
  };
}

describe("DesktopUpdates outcomes", () => {
  it.effect.each([
    { name: "Stable", channel: "latest", administrator: false },
    { name: "Beta", channel: "beta", administrator: false },
    { name: "Nightly", channel: "nightly", administrator: false },
    {
      name: "an administrator's feed with the mock flag set",
      channel: "latest",
      administrator: true,
    },
  ] as const)(
    "attributes checks to the selected feed starting on $name",
    ({ channel, administrator }) => {
      const { outcomes, layer } = recordingHarness({
        env: { T3CODE_DESKTOP_MOCK_UPDATES: administrator ? "true" : "false" },
        appUpdateYml: "provider: github\nowner: ScientFactory\nrepo: scient-desktop\n",
        savedChannel: channel,
        ...(administrator
          ? {
              policy: {
                ...DesktopUpdatePolicy.unmanagedUpdatePolicy,
                feedUrl: "https://updates.example.com/scient/",
                message: "Example Corp manages Scient updates.",
              },
            }
          : {}),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("menu");
          const expectedSource = (track: string) =>
            administrator ? "administrator" : track === "nightly" ? "github" : "scient_mirror";
          assert.deepEqual(
            outcomes("check").map((check) => check.sourceKind),
            [expectedSource(channel), expectedSource(channel)],
          );
          for (const nextChannel of ["nightly", "beta", "latest"] as const) {
            const before = outcomes("check").length;
            yield* updates.setChannel(nextChannel);
            yield* updates.check("menu");
            const checks = outcomes("check").slice(before);
            assert.isAtLeast(checks.length, 2);
            assert.deepEqual(
              checks.map((check) => check.sourceKind),
              checks.map(() => expectedSource(nextChannel)),
            );
          }
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  describe("GitHub behind Scient's mirror", () => {
    const github = { provider: "github", owner: "ScientFactory", repo: "scient-desktop" } as const;
    const isMirror = (feed: unknown) =>
      typeof feed === "object" &&
      feed !== null &&
      "provider" in feed &&
      feed.provider === "generic";
    const missingFeed = newError(
      'Cannot find channel "latest.yml" update info: HttpError: 404',
      "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    );
    const failCheck = (cause: Error) =>
      Effect.fail(
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel: "latest", cause }),
      );
    const realFeeds = {
      env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
      appUpdateYml: "provider: github\nowner: ScientFactory\nrepo: scient-desktop\n",
    } as const;

    it.effect("checks GitHub in the same check when the mirror cannot answer", () => {
      const { harness, outcomes, layer } = recordingHarness({
        ...realFeeds,
        checkForUpdates: Effect.suspend(() =>
          isMirror(harness.feedUrls().at(-1)) ? failCheck(missingFeed) : Effect.void,
        ),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const before = harness.checkCount();
          yield* updates.check("menu");
          yield* flushCallbacks;
          assert.equal(harness.checkCount() - before, 2);
          assert.deepEqual(harness.feedUrls().at(-1), github);
          const checks = outcomes("check");
          assert.deepEqual(
            checks.map((check) => check.outcome),
            ["started", "completed"],
          );
          assert.equal(checks[1]?.sourceKind, "github");
          assert.notEqual((yield* updates.getState).status, "error");
          // The next check tries the mirror again.
          yield* updates.check("menu");
          assert.isTrue(harness.feedUrls().some(isMirror));
          assert.equal(harness.checkCount() - before, 4);
        }),
      ).pipe(Effect.provide(layer));
    });

    it.effect("reports GitHub's failure once when neither source answers", () => {
      const offline = newError(
        "net::ERR_INTERNET_DISCONNECTED",
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      );
      const { outcomes, layer } = recordingHarness({
        ...realFeeds,
        checkForUpdates: Effect.suspend(() => failCheck(offline)),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("menu");
          yield* flushCallbacks;
          const checks = outcomes("check");
          assert.deepEqual(
            checks.map((check) => check.outcome),
            ["started", "failed"],
          );
          assert.include(checks[1], { sourceKind: "github", failureClass: "network" });
          assert.equal((yield* updates.getState).status, "error");
        }),
      ).pipe(Effect.provide(layer));
    });

    it.effect("updates from GitHub for the rest of the run after a mirror download fails", () => {
      const { harness, layer } = recordingHarness({
        ...realFeeds,
        downloadUpdate: Effect.fail(
          new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
            channel: "latest",
            cause: new Error("net::ERR_CONTENT_LENGTH_MISMATCH"),
          }),
        ),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          assert.isFalse((yield* updates.download).completed);
          assert.isTrue(isMirror(harness.feedUrls().at(-1)));
          const before = harness.checkCount();
          yield* updates.check("menu");
          assert.equal(harness.checkCount() - before, 1);
          assert.deepEqual(harness.feedUrls().at(-1), github);
          // A track switch keeps the run on GitHub.
          yield* updates.setChannel("beta");
          assert.deepEqual(harness.feedUrls().at(-1), { ...github, repo: "scient-desktop-beta" });
        }),
      ).pipe(Effect.provide(layer));
    });

    it.effect("retries a failed mirror download in the background from GitHub", () => {
      // electron-updater downloads from the feed its last successful check used.
      let checkedFeed: unknown;
      const { harness, layer } = recordingHarness({
        ...realFeeds,
        checkForUpdates: Effect.sync(() => {
          checkedFeed = harness.feedUrls().at(-1);
          harness.emit("update-available", { version: "1.2.4" });
        }),
        downloadUpdate: Effect.suspend(() =>
          isMirror(checkedFeed)
            ? Effect.fail(
                new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
                  channel: "latest",
                  cause: new Error("net::ERR_CONTENT_LENGTH_MISMATCH"),
                }),
              )
            : Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
        ),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          // The startup check finds the update on the mirror; its download fails.
          yield* TestClock.adjust(Duration.seconds(15));
          yield* flushCallbacks;
          assert.equal(harness.checkCount(), 1);
          assert.equal(harness.downloadCount(), 1);
          assert.isNull((yield* updates.getState).downloadedVersion);
          // The first retry comes a minute later, with no scheduled check before it.
          yield* TestClock.adjust(Duration.minutes(1));
          yield* flushCallbacks;
          assert.equal(harness.checkCount(), 2);
          assert.deepEqual(checkedFeed, github);
          assert.equal(harness.downloadCount(), 2);
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
        }),
      ).pipe(Effect.provide(layer));
    });

    it.effect("keeps re-checking GitHub before retries until GitHub answers", () => {
      // electron-updater keeps the feed of its last answered check when a check fails.
      let checkedFeed: unknown;
      let gitHubChecks = 0;
      const { harness, layer } = recordingHarness({
        ...realFeeds,
        checkForUpdates: Effect.suspend(() => {
          const feed = harness.feedUrls().at(-1);
          if (!isMirror(feed) && ++gitHubChecks === 1) return failCheck(missingFeed);
          checkedFeed = feed;
          harness.emit("update-available", { version: "1.2.4" });
          return Effect.void;
        }),
        downloadUpdate: Effect.suspend(() =>
          isMirror(checkedFeed)
            ? Effect.fail(
                new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
                  channel: "latest",
                  cause: new Error("net::ERR_CONTENT_LENGTH_MISMATCH"),
                }),
              )
            : Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
        ),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          // The startup check finds the update on the mirror; its download fails.
          yield* TestClock.adjust(Duration.seconds(15));
          yield* flushCallbacks;
          assert.equal(harness.downloadCount(), 1);
          // The first retry's GitHub check fails, so it still downloads from the mirror.
          yield* TestClock.adjust(Duration.minutes(1));
          yield* flushCallbacks;
          assert.equal(gitHubChecks, 1);
          assert.equal(harness.downloadCount(), 2);
          assert.isNull((yield* updates.getState).downloadedVersion);
          // The second retry asks GitHub again, which answers, and downloads from GitHub.
          yield* TestClock.adjust(Duration.minutes(5));
          yield* flushCallbacks;
          assert.equal(gitHubChecks, 2);
          assert.deepEqual(checkedFeed, github);
          assert.equal(harness.downloadCount(), 3);
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
        }),
      ).pipe(Effect.provide(layer));
    });
  });

  it.effect("records one outcome for a check the updater reports twice", () => {
    const offline = newError(
      "Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED",
      "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    );
    // electron-updater emits `error` and also rejects the check's promise.
    const { harness, outcomes, layer } = recordingHarness({
      checkForUpdates: Effect.suspend(() => {
        harness.emit("error", offline);
        return Effect.fail(
          new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
            channel: "latest",
            cause: offline,
          }),
        );
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("menu");
        yield* flushCallbacks;
        const checks = outcomes("check");
        assert.deepEqual(
          checks.map((check) => check.outcome),
          ["started", "failed"],
        );
        assert.include(checks[1], {
          failureClass: "network",
          trigger: "user",
          attemptRef: checks[0]?.attemptRef,
        });
        assert.isFalse(checks.some((check) => "sourceKind" in check));
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("does not label an approved downgrade or an unreachable feed as behind", () => {
    const { facts, recorded, layer } = recordingHarness();
    return Effect.gen(function* () {
      const outcomes = yield* DesktopUpdateOutcomes.make({
        facts: Option.some(yield* DesktopUpdateFacts.DesktopUpdateFacts),
        packageKind: "zip",
        sourceKind: Effect.succeed("github"),
        policyOff: false,
      });
      const state = {
        ...createInitialDesktopUpdateState(
          "1.2.4-nightly.20261027.1",
          { appArch: "x64", hostArch: "x64", runningUnderArm64Translation: false },
          "latest",
        ),
        status: "available" as const,
        availableVersion: "1.2.3",
      };
      yield* outcomes.checkStarted("menu");
      yield* outcomes.checkFinished(state);
      yield* outcomes.summaries(state, Stream.empty);
      assert.equal(recorded.at(-1)?.properties.behind, "no");
      yield* outcomes.checkStarted("menu");
      yield* outcomes.checkFailed(Object.assign(new Error("offline"), { code: "ENETUNREACH" }));
      yield* outcomes.summaries(
        { ...state, status: "error", availableVersion: "1.2.5" },
        Stream.empty,
      );
      assert.equal(recorded.at(-1)?.properties.behind, "unknown");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layer, facts, NodeCrypto.layer)));
  });

  it.effect("records one failed install after the handoff, however many paths report it", () => {
    const refused = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    const { harness, outcomes, layer } = recordingHarness({
      env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
      appUpdateYml: "provider: github\nowner: ScientFactory\nrepo: scient-desktop\n",
      quitAndInstall: Effect.suspend(() => {
        harness.emit("error", refused);
        return Effect.fail(
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: "latest",
            isSilent: true,
            isForceRunAfter: true,
            cause: refused,
          }),
        );
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* updates.install;
        yield* flushCallbacks;
        const installs = outcomes("install");
        assert.deepEqual(
          installs.map((install) => install.outcome),
          ["handoff-attempted", "failed"],
        );
        assert.include(installs[1], {
          failureClass: "permission",
          sourceKind: "scient_mirror",
          targetVersion: "1.2.4",
          attemptRef: installs[0]?.attemptRef,
        });
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("reports an install that did not apply once, not at every launch", () =>
    Effect.gen(function* () {
      const record = JSON.stringify({
        fromVersion: "1.2.3",
        targetVersion: "1.2.4",
        startedAt: 0,
        attemptRef: "0123456789abcdef",
      });
      const first = recordingHarness({
        installRecord: record,
        env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
        appUpdateYml: "provider: github\nowner: ScientFactory\nrepo: scient-desktop\n",
      });
      yield* Effect.scoped(
        DesktopUpdates.DesktopUpdates.pipe(Effect.flatMap((updates) => updates.configure)),
      ).pipe(Effect.provide(first.layer));
      assert.deepEqual(first.outcomes("apply"), [
        {
          step: "apply",
          outcome: "not-applied",
          targetVersion: "1.2.4",
          packageKind: "zip",
          attemptRef: "0123456789abcdef",
          durationMs: 0,
        },
      ]);
      const kept = [...first.harness.installRecords.values()][0];
      assert.isDefined(kept);

      const second = recordingHarness({
        installRecord: kept,
        env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
        appUpdateYml: "provider: generic\nurl: https://downloads.scientfactory.com/updates/\n",
      });
      yield* Effect.scoped(
        DesktopUpdates.DesktopUpdates.pipe(Effect.flatMap((updates) => updates.configure)),
      ).pipe(Effect.provide(second.layer));
      assert.include(kept, '"outcomeReported":true');
      assert.lengthOf(second.outcomes("apply"), 0);
    }),
  );

  it.effect("keeps polling after a poll fails unexpectedly", () => {
    let checks = 0;
    const { harness, layer } = recordingHarness({
      checkForUpdates: Effect.suspend(() =>
        ++checks === 2 ? Effect.die(new Error("unexpected poll failure")) : Effect.void,
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust("15 seconds");
        yield* TestClock.adjust("4 hours");
        assert.equal(harness.checkCount(), 2);
        yield* TestClock.adjust("4 hours");
        assert.equal(harness.checkCount(), 3);
      }),
    ).pipe(Effect.provide(layer));
  });
});

it.effect("a late download cannot replace the currently offered release", () => {
  const harness = makeHarness();
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-available", { version: "1.2.5" });
      const { changes } = yield* updates.subscribe;
      harness.emit("update-downloaded", { version: "1.2.4" });
      harness.emit("update-downloaded", { version: "1.2.5" });
      yield* Stream.runHead(Stream.filter(changes, (state) => state.downloadedVersion === "1.2.5"));
      assert.notInclude(
        harness.sentStates.map((state) => state.downloadedVersion),
        "1.2.4",
      );
      assert.equal((yield* updates.getState).downloadedVersion, "1.2.5");
      assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
      assert.equal(harness.quitAndInstalls(), 0);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("late update events cannot change the release reserved for installation", () =>
  Effect.gen(function* () {
    const stopping = yield* Deferred.make<void>();
    const releaseStop = yield* Deferred.make<void>();
    const harness = makeHarness({
      stopBackend: Deferred.succeed(stopping, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStop)),
      ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
        yield* Deferred.await(stopping);
        harness.emit("update-available", { version: "1.2.5" });
        harness.emit("update-downloaded", { version: "1.2.5" });
        harness.emit("download-progress", { percent: 25 });
        harness.emit("update-not-available");
        yield* Deferred.succeed(releaseStop, undefined);
        const result = yield* Fiber.join(install);
        assert.isTrue(result.accepted);
        assert.equal(result.state.downloadedVersion, "1.2.4");
        assert.equal(result.state.status, "preparing");
        assert.equal(harness.quitAndInstalls(), 1);
        assert.deepEqual(
          [...harness.installRecords.values()].map((record) => JSON.parse(record).targetVersion),
          ["1.2.4"],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  }),
);

it.effect(
  "prepares only after consent and keeps backends usable until native readiness and both saves",
  () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      const nativeReady = yield* Deferred.make<void>();
      let stopped = false;
      let saves = 0;
      const preparedVersions: string[] = [];
      const harness = makeHarness({
        saveBeforeInstall: Effect.sync(() => {
          saves += 1;
          return true;
        }),
        prepareUpdate: (version) =>
          Effect.sync(() => {
            preparedVersions.push(version);
          }).pipe(
            Effect.andThen(Deferred.succeed(preparing, undefined)),
            Effect.andThen(Deferred.await(nativeReady)),
          ),
        stopBackend: Effect.sync(() => {
          stopped = true;
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const desktop = yield* DesktopState.DesktopState;
          yield* updates.configure;
          const { changes } = yield* updates.subscribe;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* Stream.runHead(changes);
          assert.deepEqual(preparedVersions, []);
          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
          yield* Deferred.await(preparing);
          assert.equal((yield* updates.getState).status, "preparing");
          assert.isFalse(yield* Ref.get(desktop.quitting));
          assert.isFalse(stopped);
          assert.equal(saves, 1);
          assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
          harness.emit("error", new Error("duplicate native error event"));
          assert.isTrue(yield* updates.isInstallActive);
          yield* Deferred.succeed(nativeReady, undefined);
          assert.isTrue((yield* Fiber.join(install)).accepted);
          assert.equal(saves, 2);
          assert.isTrue(stopped);
          assert.deepEqual(preparedVersions, ["1.2.4"]);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
);

it.effect(
  "native preparation timeout leaves the app running and allows retry of the authorized version",
  () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      let attempts = 0;
      let stops = 0;
      const harness = makeHarness({
        prepareUpdate: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void;
          }),
        stopBackend: Effect.sync(() => {
          stops += 1;
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const desktop = yield* DesktopState.DesktopState;
          yield* updates.configure;
          const { changes } = yield* updates.subscribe;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* Stream.runHead(changes);
          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
          yield* Deferred.await(preparing);
          yield* TestClock.adjust("5 minutes");
          const failed = yield* Fiber.join(install);
          assert.isTrue(failed.failed);
          assert.equal(failed.state.errorContext, "install");
          assert.equal(stops, 0);
          assert.isFalse(yield* Ref.get(desktop.quitting));
          assert.isFalse(yield* updates.isActionActive);
          assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
          assert.equal(attempts, 2);
          assert.equal(stops, 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
);

it.effect.each([1, 2])(
  "a failed workspace save at barrier %s prevents native handoff and backend shutdown",
  (failedSave) => {
    let saves = 0;
    let preparations = 0;
    let stops = 0;
    const harness = makeHarness({
      saveBeforeInstall: Effect.sync(() => {
        saves += 1;
        return saves !== failedSave;
      }),
      prepareUpdate: () =>
        Effect.sync(() => {
          preparations += 1;
        }),
      stopBackend: Effect.sync(() => {
        stops += 1;
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktop = yield* DesktopState.DesktopState;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const failed = yield* updates.installPrepared("1.2.4");
        assert.isTrue(failed.failed);
        assert.equal(preparations, failedSave - 1);
        assert.equal(stops, 0);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isFalse(yield* Ref.get(desktop.quitting));
        assert.isFalse(yield* updates.isActionActive);
        assert.equal(failed.state.errorContext, "install");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  },
);

it.effect(
  "a terminal native error requires a fresh download and new consent without touching running backends",
  () => {
    let attempts = 0;
    let stops = 0;
    let lastRejectedCheck = 0;
    let downloadedAfterFreshCheck = false;
    const harness = makeHarness({
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
      downloadUpdate: Effect.sync(() => {
        downloadedAfterFreshCheck = harness.checkCount() > lastRejectedCheck;
        harness.emit("update-downloaded", { version: "1.2.4" });
      }),
      prepareUpdate: () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1 || !downloadedAfterFreshCheck
            ? Effect.fail(
                new ElectronUpdater.ElectronUpdaterPrepareUpdateError({
                  channel: "latest",
                  cause: new Error("signature refused"),
                  retryDownload: true,
                }),
              )
            : Effect.void;
        }),
      stopBackend: Effect.sync(() => {
        stops += 1;
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const failed = yield* updates.installPrepared("1.2.4");
        assert.isTrue(failed.failed);
        assert.isNull(failed.state.downloadedVersion);
        assert.equal(failed.state.errorContext, "download");
        assert.equal(stops, 0);
        assert.equal(harness.quitAndInstalls(), 0);
        lastRejectedCheck = harness.checkCount();
        yield* TestClock.adjust("1 minute");
        yield* Stream.runHead(
          changes.pipe(Stream.filter((state) => state.status === "downloaded")),
        );
        assert.equal(attempts, 1);
        assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
        assert.equal(stops, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  },
);

it.effect("releases the final workspace lock when an install is interrupted before shutdown", () =>
  Effect.gen(function* () {
    const locking = yield* Deferred.make<void>();
    let released = false;
    let stopped = false;
    const harness = makeHarness({
      lockBeforeInstall: Deferred.succeed(locking, undefined).pipe(Effect.andThen(Effect.never)),
      releaseAfterInstallFailure: Effect.sync(() => {
        released = true;
      }),
      stopBackend: Effect.sync(() => {
        stopped = true;
      }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktop = yield* DesktopState.DesktopState;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
        yield* Deferred.await(locking);
        assert.isTrue(yield* Ref.get(desktop.quitting));
        yield* Fiber.interrupt(install);
        assert.isTrue(released);
        assert.isFalse(stopped);
        assert.isFalse(yield* Ref.get(desktop.quitting));
        assert.isFalse(yield* updates.isActionActive);
        assert.equal((yield* updates.getState).status, "downloaded");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  }),
);
