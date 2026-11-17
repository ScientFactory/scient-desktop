/**
 * DesktopUpdateOutcomes - what the desktop updater records about itself: one outcome per step
 * attempt (`app.update.outcome`) and summaries of where an update stands (`app.update.summary`).
 * Every fact goes through the persisted DesktopUpdateFacts journal.
 *
 * @module DesktopUpdateOutcomes
 */
import type { DesktopUpdateState } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DesktopUpdateFacts from "./DesktopUpdateFacts.ts";
import { classifyUpdateFailure, type UpdateFailureClass } from "./updateFailureClass.ts";

export type UpdateTrigger = "user" | "background";
export type UpdatePackageKind = "zip" | "nsis" | "appimage" | "deb";
export type UpdateSourceKind = "github" | "scient_mirror" | "administrator";

/** Who asked for the update work running in this fiber; background loops provide their own. */
export const CurrentUpdateTrigger = Context.Reference<UpdateTrigger>(
  "@t3tools/desktop/scient/updateOutcomes/CurrentUpdateTrigger",
  { defaultValue: () => "user" },
);

const BACKGROUND_CHECK_REASONS = new Set(["startup", "poll", "startup-recovery"]);
const SUMMARY_INTERVAL = "24 hours";

function checkTrigger(reason: string): UpdateTrigger {
  return BACKGROUND_CHECK_REASONS.has(reason) ? "background" : "user";
}

export function updatePackageKind(input: {
  readonly platform: NodeJS.Platform;
  readonly appImage: boolean;
  readonly debPackage: boolean;
}): UpdatePackageKind | undefined {
  if (input.platform === "darwin") return "zip";
  if (input.platform === "win32") return "nsis";
  if (input.platform !== "linux") return undefined;
  return input.appImage ? "appimage" : input.debPackage ? "deb" : undefined;
}

/** The updater's feed: an administrator's, else Scient's own (GitHub releases or the mirror). */
export function updateSourceKind(input: {
  readonly administratorFeed: boolean;
  readonly defaultProvider: string;
}): UpdateSourceKind {
  if (input.administratorFeed) return "administrator";
  return input.defaultProvider === "github" ? "github" : "scient_mirror";
}

export interface UpdateInstallRecord {
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly startedAt?: number | undefined;
  readonly attemptRef?: string | undefined;
}

/** What a launch observes about the install a previous run handed to the installer. */
export function applyOutcome(
  record: UpdateInstallRecord,
  runningVersion: string,
): "completed" | "not-applied" | "superseded" | undefined {
  if (record.fromVersion === record.targetVersion) return undefined;
  if (runningVersion === record.targetVersion) return "completed";
  if (runningVersion === record.fromVersion) return "not-applied";
  return "superseded";
}

function disabledClass(state: DesktopUpdateState, policyOff: boolean): string {
  if (state.channelBlockedByPolicy) return "channel-policy";
  if (policyOff) return "policy";
  const message = state.message ?? "";
  if (/safety policy/u.test(message)) return "safety";
  if (/no update feed/u.test(message)) return "no-feed";
  if (/packaged production builds/u.test(message)) return "development";
  if (/T3CODE_DISABLE_AUTO_UPDATE/u.test(message)) return "environment";
  if (/on Linux require/u.test(message)) return "linux-package";
  return "other";
}

/** Status that a summary reports a change of; a check or a restart's preparation in progress is
 * not a change. */
function summaryKey(state: DesktopUpdateState): string | undefined {
  if (state.status === "checking" || state.status === "preparing") return undefined;
  return state.status === "error" ? `error:${state.errorContext ?? ""}` : state.status;
}

interface Attempt {
  readonly ref: string;
  readonly startedAt: number;
  readonly trigger: UpdateTrigger;
  readonly targetVersion: string | null;
  readonly finished: boolean;
}

type AttemptStep = "check" | "download" | "install";

export const make = Effect.fn("DesktopUpdateOutcomes.make")(function* (options: {
  readonly facts: Option.Option<DesktopUpdateFacts.DesktopUpdateFacts["Service"]>;
  readonly packageKind: UpdatePackageKind | undefined;
  readonly sourceKind: Effect.Effect<UpdateSourceKind | undefined>;
  readonly policyOff: boolean;
}) {
  const random = yield* SecureRandom.SecureRandom;
  const attempts = yield* Ref.make<Partial<Record<AttemptStep, Attempt>>>({});
  const lastCheckRef = yield* Ref.make(
    Option.none<{ readonly ok: boolean; readonly at: number }>(),
  );
  const lastSuccessfulCheckAtRef = yield* Ref.make(Option.none<number>());
  const context = options.sourceKind.pipe(
    Effect.map((sourceKind) => ({
      ...(options.packageKind === undefined ? {} : { packageKind: options.packageKind }),
      ...(sourceKind === undefined ? {} : { sourceKind }),
    })),
  );

  const record = (
    name: "app.update.outcome" | "app.update.summary",
    properties: DesktopUpdateFacts.DesktopUpdateFactProperties,
  ) =>
    Option.match(options.facts, {
      onNone: () => Effect.void,
      onSome: (facts) => facts.record(name, properties),
    });

  const newRef = random.uuidV4().pipe(Effect.map((uuid) => uuid.replaceAll("-", "").slice(0, 16)));

  const begin = Effect.fn("DesktopUpdateOutcomes.begin")(function* (
    step: AttemptStep,
    targetVersion: string | null,
  ) {
    const attempt: Attempt = {
      ref: yield* newRef,
      startedAt: yield* Clock.currentTimeMillis,
      trigger: yield* CurrentUpdateTrigger,
      targetVersion,
      finished: false,
    };
    yield* Ref.update(attempts, (current) => ({ ...current, [step]: attempt }));
    return attempt;
  });

  const outcome = Effect.fn("DesktopUpdateOutcomes.outcome")(function* (
    step: AttemptStep,
    attempt: Attempt,
    result: string,
    details: {
      readonly targetVersion?: string | null;
      readonly failureClass?: UpdateFailureClass;
      readonly durationMs?: number;
    } = {},
  ) {
    const targetVersion = details.targetVersion ?? attempt.targetVersion;
    yield* record("app.update.outcome", {
      step,
      outcome: result,
      trigger: attempt.trigger,
      attemptRef: attempt.ref,
      ...(yield* context),
      ...(targetVersion === null ? {} : { targetVersion }),
      ...(details.failureClass === undefined ? {} : { failureClass: details.failureClass }),
      ...(details.durationMs === undefined ? {} : { durationMs: details.durationMs }),
    });
  });

  /** Records the attempt's terminal outcome once, however many paths report its end. */
  const finish = Effect.fn("DesktopUpdateOutcomes.finish")(function* (
    step: AttemptStep,
    result: string,
    details: { readonly targetVersion?: string | null; readonly cause?: unknown } = {},
  ) {
    const attempt = yield* Ref.modify(attempts, (current) => {
      const active = current[step];
      return active === undefined || active.finished
        ? [undefined, current]
        : [active, { ...current, [step]: { ...active, finished: true } }];
    });
    if (attempt === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    if (step === "check") {
      yield* Ref.set(lastCheckRef, Option.some({ ok: result !== "failed", at: now }));
      if (result !== "failed") yield* Ref.set(lastSuccessfulCheckAtRef, Option.some(now));
    }
    yield* outcome(step, attempt, result, {
      ...(details.targetVersion === undefined ? {} : { targetVersion: details.targetVersion }),
      ...(result === "failed" ? { failureClass: classifyFailure(details.cause) } : {}),
      ...(step === "install" ? {} : { durationMs: Math.max(0, now - attempt.startedAt) }),
    });
  });

  const summary = Effect.fn("DesktopUpdateOutcomes.summary")(function* (
    reason: "launch" | "change" | "daily",
    state: DesktopUpdateState,
    times: SummaryTimes,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const lastCheck = yield* Ref.get(lastCheckRef);
    const lastSuccessfulCheckAt = yield* Ref.get(lastSuccessfulCheckAtRef);
    const targetVersion = state.downloadedVersion ?? state.availableVersion;
    yield* record("app.update.summary", {
      reason,
      status: state.status,
      channel: state.channel,
      behind:
        Option.isSome(lastCheck) && !lastCheck.value.ok
          ? "unknown"
          : targetVersion !== null
            ? compareSemverVersions(targetVersion, state.currentVersion) > 0
              ? "yes"
              : "no"
            : Option.isSome(lastCheck)
              ? "no"
              : "unknown",
      stageAgeMs: Math.max(0, now - times.statusSince),
      ...Option.match(lastSuccessfulCheckAt, {
        onNone: () => ({}),
        onSome: (at) => ({ lastCheckAgeMs: Math.max(0, now - at) }),
      }),
      ...(state.status === "error" && state.errorContext !== null
        ? { errorContext: state.errorContext }
        : {}),
      ...(state.status === "downloading"
        ? {
            downloadPercent: state.downloadPercent ?? 0,
            sinceProgressMs: Math.max(0, now - times.progressAt),
          }
        : {}),
      ...(state.status === "downloaded"
        ? { readyAgeMs: Math.max(0, now - times.downloadedAt) }
        : {}),
      ...(state.status === "disabled"
        ? { disabledClass: disabledClass(state, options.policyOff) }
        : {}),
    });
  });

  return {
    checkStarted: (reason: string) =>
      begin("check", null).pipe(
        Effect.provideService(CurrentUpdateTrigger, checkTrigger(reason)),
        Effect.flatMap((attempt) => outcome("check", attempt, "started")),
      ),
    checkFinished: (state: DesktopUpdateState) =>
      finish("check", "completed", {
        targetVersion: state.availableVersion,
      }),
    checkFailed: (cause: unknown) => finish("check", "failed", { cause }),
    downloadStarted: (targetVersion: string | null) =>
      begin("download", targetVersion).pipe(
        Effect.flatMap((attempt) => outcome("download", attempt, "started")),
      ),
    downloadCompleted: finish("download", "completed"),
    downloadFailed: (cause: unknown) => finish("download", "failed", { cause }),
    /** Starts an install attempt; its reference goes in the install record for the next launch. */
    installStarted: (targetVersion: string) =>
      Option.isNone(options.facts)
        ? Effect.undefined
        : begin("install", targetVersion).pipe(Effect.map((attempt) => attempt.ref)),
    /** Before the installer takes over: the app may exit before anything else is recorded. */
    installHandoff: Ref.get(attempts).pipe(
      Effect.flatMap((current) =>
        current.install === undefined
          ? Effect.void
          : outcome("install", current.install, "handoff-attempted"),
      ),
    ),
    installFailed: (cause: unknown) => finish("install", "failed", { cause }),
    applied: Effect.fn("DesktopUpdateOutcomes.applied")(function* (
      install: UpdateInstallRecord,
      runningVersion: string,
    ) {
      const result = applyOutcome(install, runningVersion);
      if (result === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      yield* record("app.update.outcome", {
        step: "apply",
        outcome: result,
        targetVersion: install.targetVersion,
        // The prior process's download source is not stored in the install record.
        ...(options.packageKind === undefined ? {} : { packageKind: options.packageKind }),
        ...(install.attemptRef === undefined ? {} : { attemptRef: install.attemptRef }),
        ...(install.startedAt === undefined
          ? {}
          : { durationMs: Math.max(0, now - install.startedAt) }),
      });
    }),
    /** Summaries at launch, when the status settles somewhere new, and once a day. */
    summaries: Effect.fn("DesktopUpdateOutcomes.summaries")(function* (
      latest: DesktopUpdateState,
      changes: Stream.Stream<DesktopUpdateState>,
    ) {
      if (Option.isNone(options.facts)) return;
      const startedAt = yield* Clock.currentTimeMillis;
      const stateRef = yield* Ref.make(latest);
      const timesRef = yield* Ref.make<SummaryTimes>({
        key: summaryKey(latest),
        statusSince: startedAt,
        progressAt: startedAt,
        downloadedAt: startedAt,
      });
      yield* summary("launch", latest, yield* Ref.get(timesRef));
      yield* Effect.sleep(SUMMARY_INTERVAL).pipe(
        Effect.andThen(
          Effect.all([Ref.get(stateRef), Ref.get(timesRef)]).pipe(
            Effect.flatMap(([state, times]) => summary("daily", state, times)),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      return yield* Stream.runForEach(changes, (state) =>
        Effect.gen(function* () {
          const previous = yield* Ref.getAndSet(stateRef, state);
          const now = yield* Clock.currentTimeMillis;
          const key = summaryKey(state);
          const [changed, times] = yield* Ref.modify(timesRef, (current) => {
            const changed = key !== undefined && key !== current.key;
            const next: SummaryTimes = {
              key: changed ? key : current.key,
              statusSince: changed ? now : current.statusSince,
              progressAt:
                state.status === "downloading" &&
                (previous.status !== "downloading" ||
                  previous.downloadPercent !== state.downloadPercent)
                  ? now
                  : current.progressAt,
              downloadedAt:
                state.downloadedVersion !== null &&
                previous.downloadedVersion !== state.downloadedVersion
                  ? now
                  : current.downloadedAt,
            };
            return [[changed, next] as const, next];
          });
          if (changed) yield* summary("change", state, times);
        }),
      );
    }),
  };
});

interface SummaryTimes {
  readonly key: string | undefined;
  readonly statusSince: number;
  readonly progressAt: number;
  readonly downloadedAt: number;
}

export type DesktopUpdateOutcomes = Effect.Success<ReturnType<typeof make>>;

/** A defect in the update code itself is internal, not an updater or transport failure. */
function classifyFailure(cause: unknown): UpdateFailureClass {
  return typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "DesktopUpdateUnexpectedActionError"
    ? "internal"
    : classifyUpdateFailure(cause);
}
