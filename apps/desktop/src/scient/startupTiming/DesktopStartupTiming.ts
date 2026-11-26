/**
 * DesktopStartupTiming - time from this process's start to a usable workspace, recorded once as an
 * `app.startup.timing` fact in the update-facts journal (same analytics gate and delivery); the
 * analytics contract turns the times into coarse buckets before anything leaves the computer.
 * @module DesktopStartupTiming
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopStartupRecovery from "../../app/DesktopStartupRecovery.ts";
import * as DesktopUpdateFacts from "../updateOutcomes/DesktopUpdateFacts.ts";

export type LaunchKind = "first-after-install" | "first-after-update" | "later";

/**
 * A launch is the first of its version when the last launch that started its backend ran another
 * version. With no such record, state an earlier launch left (its local environment id or desktop
 * settings) means a build older than the record ran here, so this launch follows an update.
 */
export function classifyLaunch(input: {
  readonly lastStartedVersion: string | null;
  readonly appVersion: string;
  readonly ranBefore: boolean;
}): LaunchKind {
  if (input.lastStartedVersion === null) {
    return input.ranBefore ? "first-after-update" : "first-after-install";
  }
  return input.lastStartedVersion === input.appVersion ? "later" : "first-after-update";
}

function analyticsPlatform(platform: NodeJS.Platform): "macos" | "windows" | "linux" | "other" {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "other";
}

export class DesktopStartupTiming extends Context.Service<
  DesktopStartupTiming,
  {
    /** The primary backend answered for the first time in this process. */
    readonly backendReady: Effect.Effect<void>;
    /** The first main window was shown. */
    readonly windowShown: Effect.Effect<void>;
    /** The renderer reports a connected, hydrated local workspace; only the first report counts. */
    readonly workspaceReady: (input: { readonly projectRestored: boolean }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/scient/startupTiming/DesktopStartupTiming") {}

export const makeStartupTiming = (input: {
  readonly launchKind: LaunchKind;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  /** Milliseconds since the desktop process started. */
  readonly sinceProcessStart: Effect.Effect<number>;
  readonly record: (
    properties: DesktopUpdateFacts.DesktopUpdateFactProperties,
  ) => Effect.Effect<void>;
}): DesktopStartupTiming["Service"] => {
  let backendReadyMs: number | undefined;
  let windowShownMs: number | undefined;
  let recorded = false;
  return DesktopStartupTiming.of({
    backendReady: Effect.map(input.sinceProcessStart, (elapsed) => {
      backendReadyMs ??= elapsed;
    }),
    windowShown: Effect.map(input.sinceProcessStart, (elapsed) => {
      windowShownMs ??= elapsed;
    }),
    workspaceReady: Effect.fn("DesktopStartupTiming.workspaceReady")(function* ({
      projectRestored,
    }) {
      if (recorded) return;
      recorded = true;
      const uiReadyMs = yield* input.sinceProcessStart;
      yield* input.record({
        launchKind: input.launchKind,
        platform: analyticsPlatform(input.platform),
        architecture:
          input.architecture === "arm64" || input.architecture === "x64"
            ? input.architecture
            : "other",
        uiReadyMs,
        ...(backendReadyMs === undefined ? {} : { backendReadyMs }),
        ...(windowShownMs === undefined ? {} : { windowShownMs }),
        projectRestored,
      });
    }),
  });
};

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const facts = yield* DesktopUpdateFacts.DesktopUpdateFacts;

  // Read before this launch's backend is ready: startup recovery then records this version.
  const lastStartedVersion = yield* fileSystem
    .readFileString(
      environment.path.join(environment.stateDir, DesktopStartupRecovery.LAST_STARTED_VERSION_FILE),
    )
    .pipe(
      Effect.map((text) => text.trim() || null),
      Effect.orElseSucceed(() => null),
    );
  const ranBefore =
    lastStartedVersion === null &&
    (yield* Effect.forEach(
      [
        environment.path.join(environment.stateDir, "environment-id"),
        environment.desktopSettingsPath,
      ],
      (path) => fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)),
    )).some(Boolean);
  const launchKind = classifyLaunch({
    lastStartedVersion,
    appVersion: environment.appVersion,
    ranBefore,
  });

  return makeStartupTiming({
    launchKind,
    platform: environment.platform,
    architecture: environment.processArch,
    // Node's performance clock starts with the process, so this is time since process start.
    sinceProcessStart: Effect.sync(() => performance.now()),
    record: (properties) => facts.record("app.startup.timing", properties),
  });
});

export const layer = Layer.effect(DesktopStartupTiming, make);
