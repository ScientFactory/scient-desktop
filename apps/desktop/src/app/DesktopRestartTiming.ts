import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const MAX_ATTEMPT_AGE_MS = 15 * 60_000;
const Attempt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: Schema.String,
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  confirmedAt: Schema.Finite,
  phase: Schema.Literals(["confirmed", "shutdown", "handoff", "launched"]),
  shutdownAfterConfirmMs: Schema.optionalKey(Schema.Finite),
  handoffAfterConfirmMs: Schema.optionalKey(Schema.Finite),
  handoffAt: Schema.optionalKey(Schema.Finite),
});
type Attempt = typeof Attempt.Type;
const decodeAttempt = Schema.decodeUnknownOption(Schema.fromJsonString(Attempt));
const encodeAttempt = Schema.encodeEffect(Schema.fromJsonString(Attempt));

export interface RestartReadinessToken {
  readonly attemptId: string;
  readonly launchId: string;
}

export type RestartTimingEvent = {
  readonly event:
    | "confirmed"
    | "shutdown-started"
    | "native-handoff"
    | "launched"
    | "backend-ready"
    | "workspace-ready"
    | "abandoned";
  readonly attemptId: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly launchId?: string;
  readonly processId?: number;
  readonly reason?: string;
  readonly elapsedMs?: number;
  readonly confirmToLaunchMs?: number | undefined;
  readonly confirmToReadyMs?: number | undefined;
  readonly handoffToLaunchMs?: number | undefined;
  readonly launchToBackendMs?: number;
  readonly launchToReadyMs?: number;
  readonly projectRestored?: boolean;
};

export interface RestartTiming {
  readonly begin: (targetVersion: string) => Effect.Effect<void>;
  readonly shutdownStarted: Effect.Effect<void>;
  readonly nativeHandoff: Effect.Effect<void>;
  readonly cancel: (reason: "install-failed" | "install-cancelled") => Effect.Effect<void>;
  readonly launch: Effect.Effect<void>;
  readonly backendReady: Effect.Effect<void>;
  readonly readinessToken: Effect.Effect<RestartReadinessToken | null>;
  readonly workspaceReady: (
    input: RestartReadinessToken & { readonly projectRestored: boolean },
  ) => Effect.Effect<boolean>;
}

export class DesktopRestartTiming extends Context.Service<DesktopRestartTiming, RestartTiming>()(
  "@t3tools/desktop/app/DesktopRestartTiming",
) {}

// Cross-process wall-clock measurements are optional: a clock correction must never become zero latency.
const elapsedWall = (end: number, start: number) => {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= MAX_ATTEMPT_AGE_MS
    ? elapsed
    : undefined;
};

export const makeRestartTiming = Effect.fn("desktop.restartTiming.make")(function* (input: {
  readonly appVersion: string;
  readonly launchId: string;
  readonly processId: number;
  readonly processStartedAt: number;
  readonly now: Effect.Effect<{ readonly wall: number; readonly monotonic: number }>;
  readonly randomId: Effect.Effect<string>;
  readonly read: Effect.Effect<string | null>;
  readonly write: (text: string) => Effect.Effect<boolean>;
  readonly remove: Effect.Effect<void>;
  readonly emit: (event: RestartTimingEvent) => Effect.Effect<void>;
}) {
  const mutex = yield* Semaphore.make(1);
  let attempt: Attempt | null = null;
  let confirmedMonotonic: number | null = null;
  let launched = false;
  let backendAfterLaunch: number | undefined;
  const emit = Effect.fn("desktop.restartTiming.emit")(function* (
    event: RestartTimingEvent["event"],
    fields: Omit<RestartTimingEvent, "event" | "attemptId" | "fromVersion" | "targetVersion"> = {},
  ) {
    if (attempt === null) return;
    yield* input.emit({
      event,
      attemptId: attempt.attemptId,
      fromVersion: attempt.fromVersion,
      targetVersion: attempt.targetVersion,
      ...(launched ? { launchId: input.launchId, processId: input.processId } : {}),
      ...fields,
    });
  });
  const abandon = Effect.fn("desktop.restartTiming.abandon")(function* (reason: string) {
    yield* emit("abandoned", { reason });
    attempt = null;
    launched = false;
    confirmedMonotonic = null;
    yield* input.remove;
  });
  const persist = Effect.fn("desktop.restartTiming.persist")(function* () {
    if (attempt === null) return false;
    const text = yield* encodeAttempt(attempt).pipe(Effect.orDie);
    return yield* input.write(text);
  });
  const transition = (phase: "shutdown" | "handoff") =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (attempt === null || launched || confirmedMonotonic === null) return;
        if (phase === "shutdown" ? attempt.phase !== "confirmed" : attempt.phase !== "shutdown")
          return;
        const now = yield* input.now;
        const elapsedMs = Math.max(0, now.monotonic - confirmedMonotonic);
        attempt = {
          ...attempt,
          phase,
          ...(phase === "shutdown"
            ? { shutdownAfterConfirmMs: elapsedMs }
            : { handoffAfterConfirmMs: elapsedMs, handoffAt: now.wall }),
        };
        if (!(yield* persist())) return yield* abandon("persistence-failed");
        yield* emit(phase === "shutdown" ? "shutdown-started" : "native-handoff", { elapsedMs });
      }),
    );
  return DesktopRestartTiming.of({
    begin: Effect.fn("DesktopRestartTiming.begin")((targetVersion: string) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (attempt !== null) yield* abandon("superseded");
          const now = yield* input.now;
          attempt = {
            schemaVersion: 1,
            attemptId: yield* input.randomId,
            fromVersion: input.appVersion,
            targetVersion,
            confirmedAt: now.wall,
            phase: "confirmed",
          };
          confirmedMonotonic = now.monotonic;
          launched = false;
          backendAfterLaunch = undefined;
          if (!(yield* persist())) return yield* abandon("persistence-failed");
          yield* emit("confirmed");
        }),
      ),
    ),
    shutdownStarted: transition("shutdown"),
    nativeHandoff: transition("handoff"),
    cancel: Effect.fn("DesktopRestartTiming.cancel")(
      (reason: "install-failed" | "install-cancelled") => mutex.withPermits(1)(abandon(reason)),
    ),
    launch: mutex.withPermits(1)(
      Effect.gen(function* () {
        if (launched) return;
        const text = yield* input.read;
        if (text === null) return;
        const decoded = decodeAttempt(text);
        if (Option.isNone(decoded)) {
          yield* input.remove;
          return;
        }
        attempt = decoded.value;
        if (attempt.phase !== "handoff")
          return yield* abandon("not-handed-off-or-already-launched");
        const now = yield* input.now;
        if (
          attempt.handoffAt === undefined ||
          elapsedWall(input.processStartedAt, attempt.handoffAt) === undefined ||
          elapsedWall(input.processStartedAt, attempt.confirmedAt) === undefined ||
          elapsedWall(now.wall, attempt.confirmedAt) === undefined
        )
          return yield* abandon("expired-or-clock-changed");
        if (
          attempt.targetVersion !== input.appVersion ||
          attempt.fromVersion === attempt.targetVersion
        )
          return yield* abandon("version-mismatch");
        attempt = { ...attempt, phase: "launched" };
        launched = true;
        if (!(yield* persist())) return yield* abandon("persistence-failed");
        yield* emit("launched", {
          confirmToLaunchMs: elapsedWall(input.processStartedAt, attempt.confirmedAt),
          ...(attempt.handoffAt === undefined
            ? {}
            : { handoffToLaunchMs: elapsedWall(input.processStartedAt, attempt.handoffAt) }),
        });
      }),
    ),
    backendReady: mutex.withPermits(1)(
      Effect.gen(function* () {
        if (!launched || attempt === null || backendAfterLaunch !== undefined) return;
        backendAfterLaunch = Math.max(0, (yield* input.now).monotonic);
        yield* emit("backend-ready", { launchToBackendMs: backendAfterLaunch });
      }),
    ),
    readinessToken: mutex.withPermits(1)(
      Effect.sync(() =>
        launched && attempt !== null
          ? { attemptId: attempt.attemptId, launchId: input.launchId }
          : null,
      ),
    ),
    workspaceReady: Effect.fn("DesktopRestartTiming.workspaceReady")(
      (ack: RestartReadinessToken & { readonly projectRestored: boolean }) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            if (
              !launched ||
              attempt === null ||
              backendAfterLaunch === undefined ||
              ack.attemptId !== attempt.attemptId ||
              ack.launchId !== input.launchId
            )
              return false;
            const now = yield* input.now;
            if (elapsedWall(now.wall, attempt.confirmedAt) === undefined) {
              yield* abandon("expired-or-clock-changed");
              return false;
            }
            yield* emit("workspace-ready", {
              confirmToReadyMs: elapsedWall(now.wall, attempt.confirmedAt),
              launchToReadyMs: Math.max(0, now.monotonic),
              launchToBackendMs: backendAfterLaunch,
              projectRestored: ack.projectRestored,
            });
            attempt = null;
            launched = false;
            yield* input.remove;
            return true;
          }),
        ),
    ),
  });
});

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const directory = environment.path.join(environment.baseDir, "runtime");
  const path = environment.path.join(directory, "desktop-restart-attempt.json");
  const temporary = `${path}.tmp`;
  const { logInfo, logWarning } = makeComponentLogger("desktop-restart");
  return yield* makeRestartTiming({
    appVersion: environment.appVersion,
    launchId: yield* random.uuidV4(),
    processId: process.pid,
    processStartedAt: performance.timeOrigin,
    now: DateTime.now.pipe(
      Effect.map((now) => ({
        wall: DateTime.toEpochMillis(now),
        monotonic: performance.now(),
      })),
    ),
    randomId: random.uuidV4(),
    read: fs.readFileString(path).pipe(Effect.option, Effect.map(Option.getOrNull)),
    write: (text) =>
      fs.makeDirectory(directory, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(temporary, text)),
        Effect.andThen(fs.rename(temporary, path)),
        Effect.as(true),
        Effect.catch((error) =>
          logWarning("restart timing persistence failed", { errorTag: error._tag }).pipe(
            Effect.as(false),
          ),
        ),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      ),
    remove: fs.remove(path, { force: true }).pipe(Effect.ignore),
    emit: (event) => logInfo("restart timing", event),
  });
});

export const layer = Layer.effect(DesktopRestartTiming, make);
