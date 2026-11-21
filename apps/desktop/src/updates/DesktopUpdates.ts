import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopRestartTiming from "../app/DesktopRestartTiming.ts";
import * as DesktopUpdateSave from "../app/DesktopUpdateSave.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
// SCIENT-FORK:START — update outcomes and summaries for product analytics.
import * as DesktopUpdateFacts from "../scient/updateOutcomes/DesktopUpdateFacts.ts";
import * as DesktopUpdateOutcomes from "../scient/updateOutcomes/DesktopUpdateOutcomes.ts";
// SCIENT-FORK:END
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import {
  normalizeDesktopUpdateReleaseNotes,
  releaseNotesOfOfferedVersion,
} from "./releaseNotes.ts";
import { isEmptyBetaFeedError, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  scientDesktopRuntimeUpdateFeed,
  scientDesktopUpdateFeed,
} from "@t3tools/shared/scientRelease";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";

const CHANNEL_CHANGE_RETRY_DELAY = Duration.seconds(1);
const CHANNEL_CHANGE_RETRIES = 30;
const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
// SCIENT-FORK: a check is one small file from the update mirror; hourly finds releases sooner.
const AUTO_UPDATE_POLL_INTERVAL = "1 hour";
const UPDATE_CHECK_WAIT = Duration.seconds(90);
// SCIENT-FORK:START — offered updates download in the background; failures of one release retry
// on this schedule, and the last delay repeats.
const AUTO_DOWNLOAD_RETRY_DELAYS = [
  Duration.minutes(1),
  Duration.minutes(5),
  Duration.minutes(15),
  Duration.hours(1),
  Duration.hours(4),
] as const;

function autoDownloadRetryDelay(failures: number): Duration.Duration {
  const index = Math.min(Math.max(failures, 1), AUTO_DOWNLOAD_RETRY_DELAYS.length) - 1;
  return AUTO_DOWNLOAD_RETRY_DELAYS[index] ?? Duration.hours(4);
}
// SCIENT-FORK:END

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Malformed notes must not block update-state decoding; normalizeDesktopUpdateReleaseNotes validates separately.
  releaseNotes: Schema.optional(Schema.Unknown),
  releaseName: Schema.optional(Schema.NullOr(Schema.String)),
  // SCIENT-FORK:START — electron-updater reads feeds as YAML 1.1, so an unquoted date arrives as a
  // Date. Only release notes use it; a date that can't be read is dropped, never the offer.
  releaseDate: Schema.optional(Schema.Unknown),
  // SCIENT-FORK:END
});

// SCIENT-FORK:START
function releaseDateText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}
// SCIENT-FORK:END

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({
    fromVersion: Schema.String,
    targetVersion: Schema.String,
    // SCIENT-FORK:START — when the install began, so the next launch can report how long it
    // took; which attempt it was, and whether that launch's outcome was already recorded.
    startedAt: Schema.optionalKey(Schema.Number),
    attemptRef: Schema.optionalKey(Schema.String),
    outcomeReported: Schema.optionalKey(Schema.Boolean),
    // SCIENT-FORK:END
  }),
);
const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

// SCIENT-FORK:START — a check that finished without a result the app could read. Carries
// electron-updater's own code, so outcomes classify it as a feed failure.
export class DesktopUpdateUnreadableResultError extends Schema.TaggedError<DesktopUpdateUnreadableResultError>()(
  "DesktopUpdateUnreadableResultError",
  { code: Schema.Literal("ERR_UPDATER_INVALID_UPDATE_INFO") },
) {
  override get message(): string {
    return "The update check finished without update information Scient could read.";
  }
}
// SCIENT-FORK:END

export class DesktopUpdateChannelManagedError extends Schema.TaggedError<DesktopUpdateChannelManagedError>()(
  "DesktopUpdateChannelManagedError",
  {
    channel: DesktopUpdateChannelSchema,
    policyMessage: Schema.String,
  },
) {
  override get message(): string {
    return `${this.policyMessage} The ${this.channel} channel is not available.`;
  }
}

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdateChannelManagedError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    /** `minimumVersion` is a track switch's checked release; nothing older is offered after. */
    readonly setChannel: (
      channel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    /** `allowDowngrade` is for a guarded track switch, which checked that older release. */
    readonly check: (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function redactMessage(message: string): string {
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512);
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);

  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? ` [${error.code}]`
      : "";
  const message = typeof error.message === "string" ? `: ${redactMessage(error.message)}` : "";
  const nested =
    error.cause === undefined ? "" : `; caused by ${summarizeCause(error.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0).slice(0, 1024);
  } catch {
    return "UnknownError";
  }
}

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  disabledReason: Option.Option<string>,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  const enabled = Option.isNone(disabledReason);
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
    message: Option.getOrNull(disabledReason),
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function isOffered(state: DesktopUpdateState): boolean {
  return state.status === "available" || state.status === "downloaded";
}

function getAutoUpdateDisabledReason(args: {
  policy: DesktopUpdatePolicy.UpdatePolicy;
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
  safetyEnvelopeEnabled: boolean;
}): string | null {
  if (args.policy.mode === "off") {
    return args.policy.message ?? "Updates are turned off on this machine.";
  }
  if (args.safetyEnvelopeEnabled && !SCIENT_DESKTOP_IDENTITY.autoUpdateEnabled) {
    return "Automatic updates are disabled by the current Scient safety policy.";
  }
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const restartTiming = yield* DesktopRestartTiming.DesktopRestartTiming;
  const updateSave = yield* DesktopUpdateSave.DesktopUpdateSave;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
  // Any user can set the mock flag, so it never replaces an administrator's update source.
  const mockUpdates = config.mockUpdates && policy.message === null;

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const installRunningBackendsRef = yield* Ref.make<
    ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>
  >([]);
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const nativePreparingRef = yield* Ref.make(false);
  // The installer handoff reports its own synchronous failure; the event must not race it.
  const handingOffRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const notAppliedVersionRef = yield* Ref.make(Option.none<string>());
  // SCIENT-FORK:START — the background download loop runs in configure's scope, one at a time.
  const autoDownloadScopeRef = yield* Ref.make(Option.none<Scope.Scope>());
  const autoDownloadRunningRef = yield* Ref.make(false);
  const autoDownloadBackoffRef = yield* Ref.make(
    Option.none<{
      readonly version: string | null;
      readonly failures: number;
      readonly nextAttemptAt: number;
    }>(),
  );
  // SCIENT-FORK:END
  // The release a track switch's database check cleared. A build crosses to another track only
  // through such a switch, and never below that release: version order alone cannot tell whether
  // a Stable knows a Nightly's migrations.
  const releaseFloorRef = yield* Ref.make(Option.none<string>());
  // SCIENT-FORK:START — channels include Beta. Without a floor, a build newer than this app is
  // still offered across tracks, as before the floor: Stable → Beta offers the newer Beta right
  // away, and Beta → Stable waits for a Stable at least as new as the installed Beta.
  const runningChannel = resolveDefaultDesktopUpdateChannel(environment.appVersion);
  const offerable = (version: string, state: DesktopUpdateState) =>
    Ref.get(releaseFloorRef).pipe(
      Effect.map(
        (floor) =>
          resolveDefaultDesktopUpdateChannel(version) === state.channel &&
          (Option.isSome(floor)
            ? compareSemverVersions(version, floor.value) >= 0
            : runningChannel === state.channel ||
              compareSemverVersions(version, environment.appVersion) > 0),
      ),
    );
  // SCIENT-FORK:END
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Serialize writes and publishes against subscription so snapshots cannot overlap the first change.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // electron-updater uses this marker to install .deb updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  // SCIENT-FORK:START — update outcomes and summaries for product analytics.
  const updateSourceKindRef = yield* Ref.make<DesktopUpdateOutcomes.UpdateSourceKind | undefined>(
    policy.feedUrl === undefined ? undefined : "administrator",
  );
  const outcomes = yield* DesktopUpdateOutcomes.make({
    facts: yield* Effect.serviceOption(DesktopUpdateFacts.DesktopUpdateFacts),
    packageKind: DesktopUpdateOutcomes.updatePackageKind({
      platform: environment.platform,
      appImage: Option.isSome(config.appImagePath),
      debPackage: isDebPackage,
    }),
    sourceKind: Ref.get(updateSourceKindRef),
    policyOff: policy.mode === "off",
  });
  // SCIENT-FORK:END

  // SCIENT-FORK:START — Scient's mirror with GitHub, where every release is published, behind it.
  // The channel whose Scient feed is selected; none while an administrator's feed or mocks decide.
  const scientFeedChannelRef = yield* Ref.make(Option.none<DesktopUpdateChannel>());
  // After the mirror fails a download, the rest of this run updates from GitHub.
  const mirrorSkippedRef = yield* Ref.make(false);
  // electron-updater downloads from the feed its last answered check used, so after the mirror
  // fails a download, GitHub must answer a check before the next download leaves the mirror.
  const gitHubCheckOwedRef = yield* Ref.make(false);
  const useScientFeed = Effect.fn("desktop.updates.useScientFeed")(function* (
    channel: DesktopUpdateChannel,
    source: "mirror" | "github",
  ) {
    const feed =
      source === "mirror"
        ? scientDesktopRuntimeUpdateFeed(channel)
        : scientDesktopUpdateFeed(channel);
    yield* electronUpdater.setFeedURL(feed);
    // Outcomes read the feed actually selected, including after a track switch or a fallback.
    yield* Ref.set(
      updateSourceKindRef,
      DesktopUpdateOutcomes.updateSourceKind({
        administratorFeed: false,
        defaultProvider: feed.provider,
      }),
    );
  });
  const mirrorChannel = Effect.map(Ref.get(scientFeedChannelRef), (channel) =>
    Option.filter(channel, (value) => scientDesktopRuntimeUpdateFeed(value).provider === "generic"),
  );
  // One check: the mirror first, then GitHub when the mirror fails or was skipped.
  const checkWithGitHubFallback = Effect.gen(function* () {
    const channel = yield* mirrorChannel;
    if (Option.isNone(channel)) return yield* electronUpdater.checkForUpdates;
    if (!(yield* Ref.get(mirrorSkippedRef))) {
      yield* useScientFeed(channel.value, "mirror");
      const answered = yield* electronUpdater.checkForUpdates.pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: (error) =>
            logUpdaterWarning("update mirror check failed; checking GitHub", {
              cause: describeUpdateErrorCause(error.cause),
            }).pipe(Effect.as(false)),
        }),
      );
      if (answered) return;
    }
    yield* useScientFeed(channel.value, "github");
    const result = yield* electronUpdater.checkForUpdates;
    yield* Ref.set(gitHubCheckOwedRef, false);
    return result;
  });
  const gitHubCheckOwed = Effect.gen(function* () {
    if (Option.isNone(yield* mirrorChannel)) return false;
    return yield* Ref.get(gitHubCheckOwedRef);
  });
  // A download the mirror failed leaves the next checks and downloads to GitHub.
  const skipMirrorAfterDownloadFailure = Effect.gen(function* () {
    if (Option.isNone(yield* mirrorChannel)) return;
    if ((yield* Ref.get(updateSourceKindRef)) !== "scient_mirror") return;
    yield* Ref.set(mirrorSkippedRef, true);
    yield* Ref.set(gitHubCheckOwedRef, true);
    yield* logUpdaterWarning("update mirror download failed; using GitHub for this run");
  });
  // SCIENT-FORK:END

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map(
      (appUpdateYmlConfig) =>
        Option.isSome(appUpdateYmlConfig) || mockUpdates || policy.feedUrl !== undefined,
    ),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        policy,
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        isDebPackage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
        safetyEnvelopeEnabled: environment.safetyEnvelopeEnabled,
      }),
    );
  });

  // Without nightly, an install on that channel stays put until its user picks stable: moving it
  // silently would be a downgrade nobody asked for, and checking nightly would break the policy.
  const channelBlockedReason = (channel: DesktopUpdateChannel): Option.Option<string> =>
    channel === "nightly" && !policy.allowNightly
      ? Option.some(
          `${policy.message ?? "Nightly updates are turned off on this machine."} Switch to the stable channel to keep getting updates.`,
        )
      : Option.none();

  // SCIENT-FORK:START — no off-track notice. Without a floor, Scient still offers a newer build of
  // the saved track to a build from another one (see `offerable`), so no offer means up to date.
  const noOfferState = (state: DesktopUpdateState, checkedAt: string) =>
    Effect.succeed(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
  // SCIENT-FORK:END

  const resolveStateDisabledReason = (channel: DesktopUpdateChannel) =>
    resolveDisabledReason.pipe(Effect.map(Option.orElse(() => channelBlockedReason(channel))));

  const activeUpdateAction = Ref.get(activeUpdateActionRef);
  const installerReserved = activeUpdateAction.pipe(
    Effect.map(
      (action) =>
        Option.isSome(action) &&
        (action.value === "install" || action.value === "install-recovery"),
    ),
  );

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished
          ? PubSub.publish(finishedUpdateActions, action).pipe(
              // SCIENT-FORK: a finished action can leave an offer that nothing is downloading yet.
              Effect.andThen(Effect.suspend(() => startAutoDownload)),
            )
          : Effect.void,
      ),
    );

  // Re-runs admit after each finished action, so a caller waiting on a check decides on its result.
  const admitAfterCheck = Effect.fn("desktop.updates.admitAfterCheck")(function* (
    admit: Effect.Effect<"admitted" | "refused" | "wait-for-check">,
  ) {
    const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
    let admission = yield* stateMutex.withPermits(1)(admit);
    while (admission === "wait-for-check") {
      const finishedAction = yield* PubSub.take(actionCompletions).pipe(
        Effect.timeoutOption(UPDATE_CHECK_WAIT),
      );
      admission = Option.isNone(finishedAction)
        ? "refused"
        : yield* stateMutex.withPermits(1)(admit);
    }
    return admission;
  });

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "beta";
    // SCIENT-FORK: Stable/Beta use Scient's mirror; an administrator's feed wins on every channel.
    if (!config.mockUpdates && policy.feedUrl === undefined) {
      yield* Ref.set(scientFeedChannelRef, Option.some(channel));
      yield* useScientFeed(channel, (yield* Ref.get(mirrorSkippedRef)) ? "github" : "mirror");
    }
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    // An older build can lack migrations this one ran. Only a guarded track switch's own check
    // may offer one.
    yield* electronUpdater.setAllowDowngrade(false);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  // The flag is shared updater state, so callers flip it only while holding a reservation.
  const runUpdaterCheck = Effect.fn("desktop.updates.runUpdaterCheck")(function* (
    allowDowngrade: boolean,
  ) {
    const restoreDowngrade = yield* electronUpdater.allowDowngrade;
    if (allowDowngrade) yield* electronUpdater.setAllowDowngrade(true);
    // SCIENT-FORK: a mirror that cannot answer leaves the check to GitHub.
    return yield* checkWithGitHubFallback.pipe(
      Effect.ensuring(electronUpdater.setAllowDowngrade(restoreDowngrade).pipe(Effect.ignore)),
    );
  });

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
    allowDowngrade = false,
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    if ((yield* electronUpdater.authorizedNativeVersion) !== null) return false;

    const state = yield* Ref.get(updateStateRef);
    // A configured updater is disabled only by a channel the managed policy blocks.
    if (state.status === "disabled") return false;
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      // An offer stays on screen while re-checking, so finding it again changes nothing.
      if (!isOffered(state)) {
        yield* setState(reduceDesktopUpdateStateOnCheckStart(state, yield* currentIsoTimestamp));
      }
      yield* logUpdaterInfo("checking for updates", { reason });
      // SCIENT-FORK: one outcome per check.
      yield* outcomes.checkStarted(reason);

      return yield* runUpdaterCheck(allowDowngrade).pipe(
        Effect.as(true),
        // SCIENT-FORK: the updater's events applied the check's result before it resolved.
        Effect.tap(() => Ref.get(updateStateRef).pipe(Effect.flatMap(outcomes.checkFinished))),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            if (state.channel === "beta" && isEmptyBetaFeedError(error.cause)) {
              const checkedAt = yield* currentIsoTimestamp;
              yield* updateState((current) =>
                reduceDesktopUpdateStateOnNoUpdate(current, checkedAt),
              );
              yield* logUpdaterInfo("no beta releases published yet");
              // SCIENT-FORK: an empty Beta feed is a completed check.
              yield* outcomes.checkFinished(yield* Ref.get(updateStateRef));
              return true;
            }
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            // SCIENT-FORK: the rejected check, not the updater's matching error event, is its outcome.
            yield* outcomes.checkFailed(error.cause);
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(
          Effect.onInterrupt(() => setState(state)),
          Effect.ensuring(finishUpdateAction("check")),
        );
  });

  // Install refreshes before downloading, and a second check could pick a stale, older release.
  const downloadAvailableUpdate = Effect.fn("desktop.updates.downloadAvailableUpdate")(function* (
    refresh: boolean,
  ) {
    const admission = yield* Effect.scoped(
      admitAfterCheck(
        Effect.gen(function* () {
          const state = yield* Ref.get(updateStateRef);
          if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
            return "refused" as const;
          }
          const activeAction = yield* Ref.get(activeUpdateActionRef);
          if (Option.isSome(activeAction)) {
            return activeAction.value === "check"
              ? ("wait-for-check" as const)
              : ("refused" as const);
          }
          return (yield* tryStartUpdateAction("download"))
            ? ("admitted" as const)
            : ("refused" as const);
        }),
      ),
    );
    if (admission === "refused") {
      return { accepted: false, completed: false };
    }

    const offered = yield* Ref.get(updateStateRef);
    let state = offered;
    // SCIENT-FORK: electron-updater downloads from the feed its last answered check used, so a
    // retry after a failed mirror download first finds the update on GitHub, until GitHub answers.
    const refreshFromGitHub = !refresh && (yield* gitHubCheckOwed);
    return yield* Effect.gen(function* () {
      if (refresh || refreshFromGitHub) {
        // electron-updater downloads what its last check found, which can be hours old.
        yield* logUpdaterInfo("checking for updates", { reason: "download" });
        // SCIENT-FORK: Scient's channels (with Beta) come from its own version parser.
        yield* runUpdaterCheck(offered.channel !== runningChannel).pipe(
          // A failed check keeps electron-updater's earlier result, so the known offer still downloads.
          Effect.catchTags({
            ElectronUpdaterCheckForUpdatesError: (error) =>
              logUpdaterWarning(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
              }),
          }),
        );
      }
      state = yield* Ref.get(updateStateRef);
      if (state.status !== "available") {
        return { accepted: true, completed: false };
      }
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      // SCIENT-FORK: a download that never ends still counts as started.
      yield* outcomes.downloadStarted(state.availableVersion);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      // SCIENT-FORK: one outcome per download.
      yield* outcomes.downloadCompleted;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            const cause = describeUpdateErrorCause(error.cause);
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, `${error.message} ${cause}`),
            );
            // SCIENT-FORK: one outcome per download.
            yield* outcomes.downloadFailed(error.cause);
            // SCIENT-FORK: the next attempt downloads from GitHub.
            yield* skipMirrorAfterDownloadFailure;
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause,
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          // SCIENT-FORK: one outcome per download.
          yield* outcomes.downloadFailed(error);
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            cause: describeUpdateErrorCause(error.cause),
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  });

  // SCIENT-FORK:START — an offered update downloads in the background, so the user's only step is
  // the restart. The loop takes the same action reservation as a user's download, so checks,
  // installs, channel changes and remote requests stay exclusive with it.
  const autoDownloadWanted = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    return (yield* Ref.get(updateStateRef)).status === "available";
  });

  const autoDownloadLoop = Effect.scoped(
    Effect.gen(function* () {
      const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
      const stateUpdates = yield* PubSub.subscribe(stateChanges);
      while (yield* autoDownloadWanted) {
        const version = (yield* Ref.get(updateStateRef)).availableVersion;
        const backoff = yield* Ref.get(autoDownloadBackoffRef);
        const now = yield* Clock.currentTimeMillis;
        if (
          Option.isSome(backoff) &&
          backoff.value.version === version &&
          now < backoff.value.nextAttemptAt
        ) {
          // Wait out this release's retry delay, but a different offer starts at once.
          const offerChanged = Effect.gen(function* () {
            while (true) {
              const next = yield* PubSub.take(stateUpdates);
              if (next.status !== "available" || next.availableVersion !== version) return;
            }
          });
          yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(backoff.value.nextAttemptAt - now)),
            offerChanged,
          );
          continue;
        }
        // A retry refreshes the feed before trusting a cached archive again.
        const result = yield* downloadAvailableUpdate(Option.isSome(backoff)).pipe(
          Effect.provideService(DesktopUpdateOutcomes.CurrentUpdateTrigger, "background"),
        );
        if (result.completed) {
          yield* Ref.set(autoDownloadBackoffRef, Option.none());
          return;
        }
        if (!result.accepted) {
          // Another update action holds the updater; try again once one finishes.
          yield* PubSub.take(actionCompletions).pipe(Effect.timeoutOption(UPDATE_CHECK_WAIT));
          continue;
        }
        // Failures count per release, so a check or a restart of this loop never resets them.
        const failures =
          Option.isSome(backoff) && backoff.value.version === version
            ? backoff.value.failures + 1
            : 1;
        const delay = autoDownloadRetryDelay(failures);
        yield* Ref.set(
          autoDownloadBackoffRef,
          Option.some({
            version,
            failures,
            nextAttemptAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(delay),
          }),
        );
        yield* logUpdaterInfo("background update download failed; retrying later", {
          version,
          failures,
          retryInMs: Duration.toMillis(delay),
        });
      }
    }),
  ).pipe(Effect.withSpan("desktop.updates.autoDownload"));

  const startAutoDownload: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      const scope = yield* Ref.get(autoDownloadScopeRef);
      if (Option.isNone(scope) || !(yield* autoDownloadWanted)) return;
      const claimed = yield* Ref.modify(autoDownloadRunningRef, (running) => [!running, true]);
      if (!claimed) return;
      yield* autoDownloadLoop.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : logUpdaterError("Background update download stopped unexpectedly.", {
                cause: describeUpdateErrorCause(cause),
              }),
        ),
        // A trigger that arrived while this loop was exiting found it still running; look again.
        Effect.ensuring(
          Ref.set(autoDownloadRunningRef, false).pipe(
            Effect.andThen(Effect.suspend(() => startAutoDownload)),
          ),
        ),
        Effect.forkIn(scope.value),
      );
    }),
  ).pipe(Effect.ignore);
  // SCIENT-FORK:END

  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  const updateInProgressMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  );
  const encodeUpdateMarker = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ startedAt: Schema.Number, expiresAt: Schema.Number })),
  );
  const updateInProgressTempPath = `${updateInProgressMarkerPath}.tmp`;
  const writeUpdateInProgressMarker = Effect.gen(function* () {
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const contents = yield* encodeUpdateMarker({
      startedAt,
      expiresAt: startedAt + DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
    });
    yield* fileSystem.writeFileString(updateInProgressTempPath, contents);
    yield* fileSystem.rename(updateInProgressTempPath, updateInProgressMarkerPath);
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(updateInProgressTempPath, { force: true }).pipe(Effect.ignore),
    ),
    Effect.catch((error) =>
      logUpdaterWarning("Could not write the update-in-progress marker.", { errorTag: error._tag }),
    ),
  );
  const removeUpdateInProgressMarker = fileSystem
    .remove(updateInProgressMarkerPath, { force: true })
    .pipe(Effect.ignore);

  // Failed or interrupted installs leave no replacement backend; later quits must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  const installRecordPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  );
  // SCIENT-FORK:START — the record also names the install attempt.
  const saveInstallRecord = (record: typeof DesktopUpdateInstallRecord.Type) =>
    encodeInstallRecord(record).pipe(
      Effect.flatMap((text) => fileSystem.writeFileString(installRecordPath, text)),
      Effect.catch((error) =>
        logUpdaterWarning("Could not record the update install.", { errorTag: error._tag }),
      ),
    );
  const writeInstallRecord = (targetVersion: string, attemptRef: string | undefined) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        saveInstallRecord({
          fromVersion: environment.appVersion,
          targetVersion,
          startedAt,
          ...(attemptRef === undefined ? {} : { attemptRef }),
        }),
      ),
    );
  // SCIENT-FORK:END
  const removeInstallRecord = fileSystem
    .remove(installRecordPath, { force: true })
    .pipe(Effect.ignore);

  // SCIENT-FORK:START — an install that reached its target reports how long it took, from the
  // install's start to this launch (time the app stayed closed included).
  const logAppliedInstall = (record: typeof DesktopUpdateInstallRecord.Type) =>
    record.targetVersion === environment.appVersion && record.fromVersion !== record.targetVersion
      ? Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            logUpdaterInfo("update applied", {
              fromVersion: record.fromVersion,
              targetVersion: record.targetVersion,
              platform: environment.platform,
              appArch: environment.runtimeInfo.appArch,
              ...(record.startedAt === undefined
                ? {}
                : { installToLaunchMs: Math.max(0, now - record.startedAt) }),
            }),
          ),
        )
      : Effect.void;
  // A record that did not apply stays for the next launch's notice, so it is reported once.
  const reportInstall = (record: typeof DesktopUpdateInstallRecord.Type) =>
    logAppliedInstall(record).pipe(
      Effect.andThen(
        record.outcomeReported === true
          ? Effect.void
          : outcomes
              .applied(record, environment.appVersion)
              .pipe(
                Effect.andThen(
                  DesktopUpdateOutcomes.applyOutcome(record, environment.appVersion) ===
                    "not-applied"
                    ? saveInstallRecord({ ...record, outcomeReported: true })
                    : Effect.void,
                ),
              ),
      ),
    );
  // SCIENT-FORK:END

  const readNotAppliedInstallVersion = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.option,
    // SCIENT-FORK: the outcome of the install a previous run handed over.
    Effect.tap((record) => (Option.isSome(record) ? reportInstall(record.value) : Effect.void)),
    Effect.map((record) =>
      Option.flatMap(record, (value) =>
        Option.fromNullishOr(resolveNotAppliedInstallVersion(value, environment.appVersion)),
      ),
    ),
    Effect.tap((notAppliedVersion) =>
      Option.isNone(notAppliedVersion) ? removeInstallRecord : Effect.void,
    ),
  );

  const baseUpdateState = (channel: DesktopUpdateChannel, disabledReason: Option.Option<string>) =>
    Ref.get(notAppliedVersionRef).pipe(
      Effect.map((notAppliedVersion) => ({
        ...createBaseUpdateState(channel, disabledReason, environment),
        // Callers fall back to the channel's reason only when nothing else turns updates off.
        ...(Option.isSome(disabledReason) &&
        disabledReason.value === Option.getOrUndefined(channelBlockedReason(channel))
          ? { channelBlockedByPolicy: true as const }
          : {}),
        ...Option.match(notAppliedVersion, {
          onNone: () => ({}),
          onSome: (version) => ({ notAppliedVersion: version }),
        }),
      })),
    );

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      Ref.set(nativePreparingRef, false),
      updateSave.release,
      Ref.set(installRunningBackendsRef, []),
      removeUpdateRestartMarker,
      removeUpdateInProgressMarker,
      removeInstallRecord,
      restartTiming.cancel("install-cancelled"),
      updateState((state) =>
        state.status === "preparing"
          ? reduceDesktopUpdateStateOnInstallFailure(
              state,
              "Update preparation was interrupted. Retry the update.",
            )
          : state,
      ),
    ],
    { discard: true },
  );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
    retryDownload = false,
  ) {
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    yield* restartTiming.cancel("install-failed");
    yield* Ref.set(nativePreparingRef, false);
    yield* Ref.set(desktopState.quitting, false);
    yield* updateSave.release;
    yield* removeUpdateRestartMarker;
    yield* removeUpdateInProgressMarker;
    yield* removeInstallRecord;
    if (retryDownload) {
      yield* Ref.set(
        autoDownloadBackoffRef,
        Option.some({
          version: (yield* Ref.get(updateStateRef)).availableVersion,
          failures: 1,
          nextAttemptAt:
            (yield* Clock.currentTimeMillis) + Duration.toMillis(autoDownloadRetryDelay(1)),
        }),
      );
    }
    yield* Effect.gen(function* () {
      const runningInstances = yield* Ref.getAndSet(installRunningBackendsRef, []);
      const instances = (yield* pool.list).filter((instance) =>
        runningInstances.includes(instance),
      );
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      yield* updateState((current) =>
        retryDownload
          ? reduceDesktopUpdateStateOnDownloadFailure(
              { ...current, downloadedVersion: null },
              message,
            )
          : reduceDesktopUpdateStateOnInstallFailure(current, message),
      );
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  const installDownloadedUpdate = (expectedVersion?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const admission = yield* admitAfterCheck(
          Effect.gen(function* () {
            const state = yield* Ref.get(updateStateRef);
            const activeAction = yield* Ref.get(activeUpdateActionRef);
            const hasExpectedDownload =
              state.downloadedVersion !== null &&
              (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
            if (
              (yield* Ref.get(desktopState.quitting)) ||
              !(yield* Ref.get(updaterConfiguredRef)) ||
              !hasExpectedDownload
            ) {
              return "refused" as const;
            }
            if (Option.isSome(activeAction)) {
              return activeAction.value === "check"
                ? ("wait-for-check" as const)
                : ("refused" as const);
            }
            const hasInstallableDownload =
              state.status === "downloaded" ||
              (state.status === "error" &&
                (state.errorContext === null || state.errorContext === "install"));
            if (!hasInstallableDownload) return "refused" as const;
            return (yield* tryStartUpdateAction("install"))
              ? ("admitted" as const)
              : ("refused" as const);
          }),
        );
        if (admission === "refused") {
          return { accepted: false, completed: false, failed: false };
        }

        yield* Ref.set(installRunningBackendsRef, []);

        return yield* Effect.gen(function* () {
          const targetVersion = (yield* Ref.get(updateStateRef)).downloadedVersion;
          if (targetVersion === null) {
            return yield* Effect.die(new Error("The admitted update is no longer downloaded."));
          }
          yield* restartTiming.begin(targetVersion);
          // SCIENT-FORK: the attempt starts at consent, so a failed native preparation counts.
          const installAttemptRef = yield* outcomes.installStarted(targetVersion);
          yield* updateState((state) => ({
            ...state,
            status: "preparing",
            message: "Preparing update… You can keep working.",
            errorContext: null,
            canRetry: false,
          }));
          yield* Ref.set(nativePreparingRef, true);
          if (!(yield* updateSave.prepare)) {
            yield* Ref.set(nativePreparingRef, false);
            yield* recoverFailedInstall(
              "Scient could not save every open workspace. Save your changes and retry the update.",
            );
            return { accepted: true, completed: false, failed: true };
          }
          yield* electronUpdater.prepareUpdate(targetVersion).pipe(
            Effect.timeoutOrElse({
              duration: "5 minutes",
              orElse: () =>
                Effect.fail(
                  new ElectronUpdater.ElectronUpdaterPrepareUpdateError({
                    channel: null,
                    cause: new Error(
                      "Native preparation timed out. Retry to await the same authorized update.",
                    ),
                  }),
                ),
            }),
          );
          yield* logUpdaterInfo("update preparation ready", {
            version: targetVersion,
            nativePreparation: environment.platform === "darwin",
          });
          yield* updateState((state) => ({
            ...state,
            message: "Saving your work before restarting…",
          }));
          yield* Ref.set(desktopState.quitting, true);
          if (!(yield* updateSave.prepareForRestart)) {
            yield* Ref.set(nativePreparingRef, false);
            yield* recoverFailedInstall(
              "The update is prepared, but a workspace could not be saved. Save your changes and retry the update." +
                (environment.platform === "darwin"
                  ? " This update is already authorized; quitting Scient can install it."
                  : ""),
            );
            return { accepted: true, completed: false, failed: true };
          }
          yield* Ref.set(nativePreparingRef, false);
          yield* writeUpdateRestartMarker;
          yield* writeUpdateInProgressMarker;
          const { downloadedVersion } = yield* Ref.get(updateStateRef);
          // SCIENT-FORK: the install attempt starts with its record.
          if (downloadedVersion !== null) {
            yield* writeInstallRecord(downloadedVersion, installAttemptRef);
          }
          // Stop pooled backends and SSH tunnels before quitAndInstall can outrun their scope finalizers.
          const instances = yield* pool.list;
          // stop clears desiredRunning, so retain the recovery set beforehand.
          const runningInstances = yield* Effect.filter(instances, (instance) =>
            instance.snapshot.pipe(Effect.map((snapshot) => snapshot.desiredRunning)),
          );
          yield* Ref.set(installRunningBackendsRef, runningInstances);
          yield* restartTiming.shutdownStarted;
          yield* Effect.all(
            [
              Effect.forEach(
                instances,
                (instance) =>
                  instance.stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT }),
                { concurrency: "unbounded" },
              ),
              sshEnvironment.closeAllTunnels,
            ],
            { concurrency: "unbounded" },
          );
          yield* restartTiming.nativeHandoff;
          // SCIENT-FORK: the installer may end this process before anything else is recorded.
          yield* outcomes.installHandoff;
          yield* Ref.set(handingOffRef, true);
          yield* electronUpdater
            .quitAndInstall({
              expectedVersion: targetVersion,
              isSilent: true,
              isForceRunAfter: true,
            })
            .pipe(Effect.ensuring(Ref.set(handingOffRef, false)));
          return { accepted: true, completed: false, failed: false };
        }).pipe(
          Effect.catchTags({
            ElectronUpdaterPrepareUpdateError: Effect.fn(
              "desktop.updates.handlePreparationFailure",
            )(function* (error) {
              // SCIENT-FORK: one outcome per install; a paused save is not an update failure.
              yield* outcomes.installFailed(error.cause);
              yield* recoverFailedInstall(error.message, error.retryDownload ?? false);
              yield* logUpdaterWarning(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
              });
              return { accepted: true, completed: false, failed: true };
            }),
            ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
              function* (error) {
                // SCIENT-FORK: one outcome per install, however many paths report its failure.
                yield* outcomes.installFailed(error.cause);
                yield* recoverFailedInstall(error.message);
                yield* logUpdaterError(error.message, {
                  errorTag: error._tag,
                  cause: describeUpdateErrorCause(error.cause),
                  channel: error.channel,
                  isSilent: error.isSilent,
                  isForceRunAfter: error.isForceRunAfter,
                });
                return { accepted: true, completed: false, failed: true };
              },
            ),
          }),
          Effect.onInterrupt(() => resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
              // SCIENT-FORK: one outcome per install, however many paths report its failure.
              yield* outcomes.installFailed(error);
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    // A download can be hours old: a release published since replaces it before restarting.
    const retained = yield* Ref.get(updateStateRef);
    if (
      expectedVersion === undefined &&
      retained.downloadedVersion !== null &&
      (yield* checkForUpdates(
        "install",
        "acquire",
        // SCIENT-FORK: Scient's channels (with Beta) come from its own version parser.
        retained.channel !== runningChannel,
      )) &&
      (yield* Ref.get(updateStateRef)).status === "available"
    ) {
      const refreshed = yield* Ref.get(updateStateRef);
      // electron-updater compares a stale feed with the running build, not the retained download.
      if (
        refreshed.availableVersion === null ||
        compareSemverVersions(refreshed.availableVersion, retained.downloadedVersion) <= 0
      ) {
        yield* setState(retained);
      } else {
        const download = yield* downloadAvailableUpdate(false);
        if (!download.completed) {
          return {
            accepted: download.accepted,
            completed: false,
            failed: download.accepted,
            state: yield* Ref.get(updateStateRef),
          };
        }
      }
    }
    const result = yield* installDownloadedUpdate(expectedVersion);
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      state: yield* Ref.get(updateStateRef),
    };
  });

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      // SCIENT-FORK:START — an unexpected failure ends one poll, not polling.
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forever,
      // SCIENT-FORK:END
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          if (yield* installerReserved) return;
          const authorizedVersion = yield* electronUpdater.authorizedNativeVersion;
          if (authorizedVersion !== null && authorizedVersion !== info.version) return;
          const state = yield* Ref.get(updateStateRef);
          if (!(yield* offerable(info.version, state))) {
            yield* logUpdaterInfo("ignoring update outside the selected channel or its floor", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(yield* noOfferState(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }
          if (isOffered(state) && state.availableVersion === info.version) return;

          const checkedAt = yield* currentIsoTimestamp;
          const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
            releaseNotesOfOfferedVersion(info),
            info.version,
            state.channel,
            releaseDateText(info.releaseDate),
          );
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(
              state,
              info.version,
              checkedAt,
              releaseNotes,
              omittedReleaseCount,
            ),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
            omittedReleaseCount,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        }).pipe(
          // SCIENT-FORK:START — an offer the app cannot read ends the check that found it, so the
          // control never stays at "Checking for updates…"; the check records it as a feed failure.
          Effect.andThen(
            Effect.gen(function* () {
              // The check that found it failed, even when a re-check keeps an earlier offer shown.
              yield* outcomes.checkFailed(
                new DesktopUpdateUnreadableResultError({ code: "ERR_UPDATER_INVALID_UPDATE_INFO" }),
              );
              if ((yield* Ref.get(updateStateRef)).status !== "checking") return;
              const failedAt = yield* currentIsoTimestamp;
              yield* updateState((current) =>
                current.status === "checking"
                  ? reduceDesktopUpdateStateOnCheckFailure(
                      current,
                      "Scient could not read the update information. Try again later.",
                      failedAt,
                    )
                  : current,
              );
            }),
          ),
          // SCIENT-FORK:END
        );
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    if (yield* installerReserved) return;
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(yield* noOfferState(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const state = yield* Ref.get(updateStateRef);
    if (state.channel === "beta" && isEmptyBetaFeedError(cause)) {
      return;
    }
    const error = new DesktopUpdaterReportedError({
      operation: Option.match(activeAction, {
        onNone: () => "background" as const,
        onSome: (action) => (action === "install-recovery" ? "install" : action),
      }),
      cause,
    });
    // The awaited preparation owns its error and recovery; a duplicate native event cannot release its lease.
    if ((yield* Ref.get(nativePreparingRef)) || (yield* Ref.get(handingOffRef))) return;
    if (Option.isSome(activeAction) && activeAction.value === "install") {
      // SCIENT-FORK: installers report failure here; one outcome per install.
      yield* outcomes.installFailed(cause);
      yield* recoverFailedInstall(error.message);
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState(({ trackMismatch: _trackMismatch, ...current }) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      cause: describeUpdateErrorCause(error.cause),
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          if (yield* installerReserved) return;
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          // SCIENT-FORK: publish every real progress event; only logs use 10% milestones.
          yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          if (yield* installerReserved) return;
          const state = yield* Ref.get(updateStateRef);
          if (state.availableVersion !== null && state.availableVersion !== info.version) {
            yield* logUpdaterInfo("ignoring superseded update download", {
              version: info.version,
              availableVersion: state.availableVersion,
            });
            // A newer offer's download joined this finished one; offer it again rather than wait.
            if (state.status === "downloading") {
              yield* setState({ ...state, status: "available", downloadPercent: null });
            }
            return;
          }
          // A download can finish after its track switch moved on; never offer that build.
          if (!(yield* offerable(info.version, state))) {
            yield* logUpdaterInfo("ignoring download outside the selected channel or its floor", {
              version: info.version,
              channel: state.channel,
            });
            // Its progress events left the updater "downloading", which would block every check.
            if (state.status === "downloading") {
              yield* setState(
                reduceDesktopUpdateStateOnNoUpdate(state, yield* currentIsoTimestamp),
              );
            }
            return;
          }
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => resolveStateDisabledReason(state.channel)),
    ),
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      // Runs synchronously up to the first await, so a check's outcome is applied before the
      // check's promise resolves and wakes the actions waiting on it.
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);
      // SCIENT-FORK: before runtime selection, the packaged feed is the active default.
      const packagedProvider = Option.isSome(appUpdateYmlConfig)
        ? appUpdateYmlConfig.value.provider
        : undefined;
      if (!mockUpdates && policy.feedUrl === undefined && packagedProvider !== undefined) {
        yield* Ref.set(
          updateSourceKindRef,
          DesktopUpdateOutcomes.updateSourceKind({
            administratorFeed: false,
            defaultProvider: packagedProvider,
          }),
        );
      }

      const notAppliedVersion = yield* readNotAppliedInstallVersion;
      yield* Ref.set(notAppliedVersionRef, notAppliedVersion);
      if (Option.isSome(notAppliedVersion)) {
        yield* logUpdaterWarning("the last update install did not apply", {
          version: environment.appVersion,
          targetVersion: notAppliedVersion.value,
        });
      }

      if (
        mockUpdates &&
        !(environment.safetyEnvelopeEnabled && !SCIENT_DESKTOP_IDENTITY.autoUpdateEnabled)
      ) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      } else if (policy.feedUrl !== undefined) {
        // The administrator's mirror replaces the GitHub feed baked into app-update.yml.
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: policy.feedUrl,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const settings = yield* desktopSettings.get;
      const disabledReason = yield* resolveDisabledReason;
      // A blocked nightly channel still lets the user switch back to stable, so it stays updatable.
      yield* Ref.set(desktopState.canInstallUpdates, Option.isNone(disabledReason));
      yield* setState(
        yield* baseUpdateState(
          settings.updateChannel,
          Option.orElse(disabledReason, () => channelBlockedReason(settings.updateChannel)),
        ),
      );
      // SCIENT-FORK:START — summaries for the app's lifetime, also when updates are off.
      const summaryChanges = yield* PubSub.subscribe(stateChanges);
      yield* outcomes
        .summaries(yield* Ref.get(updateStateRef), Stream.fromSubscription(summaryChanges))
        .pipe(Effect.forkScoped);
      // SCIENT-FORK:END
      if (Option.isSome(disabledReason)) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);
      // SCIENT-FORK: background downloads live as long as the configured updater.
      yield* Ref.set(autoDownloadScopeRef, Option.some(yield* Scope.Scope));

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      if ((yield* electronUpdater.authorizedNativeVersion) !== null) {
        return yield* new DesktopUpdateActionInProgressError({
          action: "install",
          requestedChannel: nextChannel,
        });
      }
      if (Option.isSome(channelBlockedReason(nextChannel))) {
        return yield* new DesktopUpdateChannelManagedError({
          channel: nextChannel,
          policyMessage: policy.message ?? "Your administrator manages Scient updates.",
        });
      }
      // A background check holds the updater only briefly, so wait it out instead of refusing.
      const activeAction = yield* tryStartChannelChange.pipe(
        Effect.repeat({
          while: (active) => Option.isSome(active) && active.value === "check",
          schedule: Schedule.spaced(CHANNEL_CHANGE_RETRY_DELAY),
          times: CHANNEL_CHANGE_RETRIES,
        }),
      );
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const previousFloor = yield* Ref.getAndSet(
          releaseFloorRef,
          Option.fromNullishOr(options?.minimumVersion),
        );
        const state = yield* Ref.get(updateStateRef);
        const retained = state.downloadedVersion ?? state.availableVersion;
        // A build from another track re-checks, so retrying a track switch finds an older release.
        // So does a retained offer below the new floor, which must not install.
        if (
          nextChannel === state.channel &&
          // SCIENT-FORK: the running build's channel knows Beta.
          nextChannel === runningChannel &&
          (retained === null || (yield* offerable(retained, state)))
        ) {
          return state;
        }

        const settingsChange = yield* desktopSettings.setUpdateChannel(nextChannel).pipe(
          Effect.onError(() => Ref.set(releaseFloorRef, previousFloor)),
          Effect.mapError(
            (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
          ),
        );
        // SCIENT-FORK:START — settings may keep the current track instead of the requested one.
        const effectiveChannel = settingsChange.settings.updateChannel;
        yield* Effect.annotateCurrentSpan({ effectiveChannel });
        if (effectiveChannel !== nextChannel && effectiveChannel === state.channel) {
          // The kept track keeps its own floor, as after a failed save.
          yield* Ref.set(releaseFloorRef, previousFloor);
          return state;
        }
        // SCIENT-FORK:END

        const disabledReason = yield* resolveDisabledReason;
        yield* setState(yield* baseUpdateState(effectiveChannel, disabledReason));

        if (Option.isSome(disabledReason) || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(effectiveChannel);
        // Only leaving the running build's track can need an older release.
        yield* checkForUpdates("channel-change", "held", effectiveChannel !== runningChannel);
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason, "acquire", options?.allowDowngrade === true);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate(true);
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: Effect.fn("DesktopUpdates.installPrepared")(function (expectedVersion) {
      return installWithExpectedVersion(expectedVersion);
    }),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
