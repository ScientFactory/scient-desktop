// @effect-diagnostics nodeBuiltinImport:off -- a real temporary state directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as DesktopStartupRecovery from "../../app/DesktopStartupRecovery.ts";
import * as DesktopUpdateFacts from "../updateOutcomes/DesktopUpdateFacts.ts";
import * as DesktopStartupTiming from "./DesktopStartupTiming.ts";

describe("classifyLaunch", () => {
  it.each([
    [null, false, "first-after-install"],
    [null, true, "first-after-update"],
    ["1.2.2", true, "first-after-update"],
    ["1.2.2", false, "first-after-update"],
    ["1.2.3", true, "later"],
  ] as const)("last started %s, ran before %s: %s", (lastStartedVersion, ranBefore, kind) => {
    assert.equal(
      DesktopStartupTiming.classifyLaunch({ lastStartedVersion, appVersion: "1.2.3", ranBefore }),
      kind,
    );
  });
});

describe("makeStartupTiming", () => {
  it.effect("records one fact at the first workspace report, with the first sub-phases", () =>
    Effect.gen(function* () {
      let now = 0;
      const recorded: Array<DesktopUpdateFacts.DesktopUpdateFactProperties> = [];
      const timing = DesktopStartupTiming.makeStartupTiming({
        launchKind: "first-after-update",
        platform: "win32",
        architecture: "ia32",
        sinceProcessStart: Effect.sync(() => now),
        record: (properties) => Effect.sync(() => recorded.push(properties)),
      });
      now = 9_100;
      yield* timing.backendReady;
      now = 12_400;
      yield* timing.windowShown;
      // A restarted backend and a second window are not this launch's startup.
      now = 30_000;
      yield* timing.backendReady;
      yield* timing.windowShown;
      now = 16_200;
      yield* timing.workspaceReady({ projectRestored: true });
      now = 45_000;
      yield* timing.workspaceReady({ projectRestored: false });

      assert.deepEqual(recorded, [
        {
          launchKind: "first-after-update",
          platform: "windows",
          architecture: "other",
          uiReadyMs: 16_200,
          backendReadyMs: 9_100,
          windowShownMs: 12_400,
          projectRestored: true,
        },
      ]);
    }),
  );

  it.effect("leaves out a sub-phase this launch never reached", () =>
    Effect.gen(function* () {
      const recorded: Array<DesktopUpdateFacts.DesktopUpdateFactProperties> = [];
      const timing = DesktopStartupTiming.makeStartupTiming({
        launchKind: "later",
        platform: "darwin",
        architecture: "arm64",
        sinceProcessStart: Effect.succeed(1_500),
        record: (properties) => Effect.sync(() => recorded.push(properties)),
      });
      yield* timing.workspaceReady({ projectRestored: false });
      assert.deepEqual(recorded, [
        {
          launchKind: "later",
          platform: "macos",
          architecture: "arm64",
          uiReadyMs: 1_500,
          projectRestored: false,
        },
      ]);
    }),
  );
});

function environmentLayer(home: string, appVersion: string) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: home,
    platform: "win32",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ SCIENT_NEXT_HOME: home })),
    ),
  );
}

function launchLayer(home: string, appVersion: string) {
  return DesktopStartupTiming.layer.pipe(
    Layer.provideMerge(DesktopUpdateFacts.layer),
    Layer.provideMerge(environmentLayer(home, appVersion)),
    Layer.provide(
      Layer.succeed(DesktopManagedPolicy.DesktopManagedPolicy, { read: Effect.undefined }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

/** One desktop process that reaches a ready workspace; returns the facts it journaled. */
function launch(home: string, appVersion: string, analytics: "true" | "false") {
  return Effect.gen(function* () {
    const timing = yield* DesktopStartupTiming.DesktopStartupTiming;
    yield* timing.backendReady;
    // What startup recovery does once the primary backend is ready, whatever analytics says.
    const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, DesktopStartupRecovery.LAST_STARTED_VERSION_FILE),
      appVersion,
    );
    yield* timing.windowShown;
    yield* timing.workspaceReady({ projectRestored: false });
    yield* timing.workspaceReady({ projectRestored: false });
    const facts = yield* (yield* DesktopUpdateFacts.DesktopUpdateFacts).pending;
    // The next launch starts from what this one leaves; delivery is the journal's own concern.
    yield* (yield* DesktopUpdateFacts.DesktopUpdateFacts).acknowledge(facts.map((f) => f.id));
    return facts;
  }).pipe(
    Effect.scoped,
    Effect.provide(launchLayer(home, appVersion)),
    Effect.provideService(HostProcess.Environment, { SCIENT_ANALYTICS_ENABLED: analytics }),
  );
}

function temporaryHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-startup-timing-"));
}

describe("DesktopStartupTiming layer", () => {
  it.effect(
    "journals one fact per launch, first after install, then later, then after update",
    () =>
      Effect.gen(function* () {
        const home = temporaryHome();
        const kinds = [];
        for (const version of ["1.2.3", "1.2.3", "1.3.0", "1.3.0"]) {
          const facts = yield* launch(home, version, "true");
          assert.lengthOf(facts, 1);
          assert.equal(facts[0]?.name, "app.startup.timing");
          assert.equal(facts[0]?.appVersion, version);
          kinds.push(facts[0]?.properties.launchKind);
          assert.equal(facts[0]?.properties.platform, "windows");
          assert.isAtLeast(facts[0]?.properties.uiReadyMs as number, 0);
        }
        assert.deepEqual(kinds, ["first-after-install", "later", "first-after-update", "later"]);
      }),
  );

  it.effect("treats an existing install without a launch record as updated", () =>
    Effect.gen(function* () {
      const home = temporaryHome();
      const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(environmentLayer(home, "1.2.3")),
      );
      NodeFS.mkdirSync(stateDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(stateDir, "environment-id"), "local\n");
      const facts = yield* launch(home, "1.2.3", "true");
      assert.equal(facts[0]?.properties.launchKind, "first-after-update");
    }),
  );

  it.effect("records nothing while analytics is off; the next launch still counts as later", () =>
    Effect.gen(function* () {
      const home = temporaryHome();
      assert.deepEqual(yield* launch(home, "1.2.3", "false"), []);
      const facts = yield* launch(home, "1.2.3", "true");
      assert.equal(facts[0]?.properties.launchKind, "later");
    }),
  );
});
