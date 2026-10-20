import {
  DEFAULT_KEEP_AWAKE_SETTINGS,
  KEEP_AWAKE_LEASE_MS,
  KeepAwakeDocument,
  KeepAwakeRequest,
  KeepAwakeState,
  type KeepAwakeObservation,
  type KeepAwakeThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import Store from "electron-store";
import { app, powerSaveBlocker } from "electron";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import {
  observeKeepAwakeSession,
  selectKeepAwakeSession,
  type KeepAwakeCompletion,
} from "./keepAwakeSession.ts";

export const KEEP_AWAKE_CHANNEL = "scient:keep-awake";
const decodeDocument = Schema.decodeUnknownEffect(KeepAwakeDocument);

export class KeepAwakeError extends Schema.TaggedError<KeepAwakeError>()("KeepAwakeError", {
  cause: Schema.Defect(),
}) {}

export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    readonly handle: (request: KeepAwakeRequest) => Effect.Effect<KeepAwakeState, KeepAwakeError>;
  }
>()("@t3tools/desktop/scient/keepAwake/DesktopKeepAwake") {}

export const layer = Layer.effect(
  DesktopKeepAwake,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const path = yield* Path.Path;
    const clock = yield* Clock.Clock;
    const store = yield* Effect.try({
      try: () =>
        new Store<KeepAwakeDocument>({
          name: "keep-awake",
          cwd: path.dirname(environment.clientSettingsPath),
          defaults: { settings: DEFAULT_KEEP_AWAKE_SETTINGS, threads: [] },
        }),
      catch: (cause) => new KeepAwakeError({ cause }),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    let storageError: string | null = null;
    let document = yield* decodeDocument(store?.store).pipe(
      Effect.catch(() => {
        storageError =
          "Could not load keep-awake preferences. Keep-awake is disabled until preferences can be saved.";
        return Effect.succeed({
          settings: DEFAULT_KEEP_AWAKE_SETTINGS,
          threads: [],
        } as KeepAwakeDocument);
      }),
    );
    const observations = new Map<string, KeepAwakeObservation>();
    const finishing = new Map<string, KeepAwakeCompletion>();
    let blocker: number | null = null;
    let lastError: string | null = null;
    let quitting = false;
    const wantsAwake = (thread: KeepAwakeThread) =>
      thread.once || document.settings.mode === "running";
    const fresh = (observation: KeepAwakeObservation | undefined, now: number) =>
      observation !== undefined &&
      observation.observedAt <= now + 1000 &&
      observation.observedAt + KEEP_AWAKE_LEASE_MS > now;
    const persist = (next: KeepAwakeDocument) => {
      if (store === null) throw new Error("Keep-awake storage is unavailable.");
      store.store = next;
      document = next;
      storageError = null;
    };
    const release = () => {
      if (blocker !== null) {
        powerSaveBlocker.stop(blocker);
        blocker = null;
      }
    };
    const reconcile = () => {
      const now = clock.currentTimeMillisUnsafe();
      const wanted =
        !quitting &&
        document.threads.some((thread) => {
          const observation = observations.get(thread.key);
          return (
            wantsAwake(thread) &&
            fresh(observation, now) &&
            (observation?.needsAwake === true || finishing.has(thread.key))
          );
        });
      try {
        if (wanted && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
        else if (!wanted) release();
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Could not request keep-awake.";
        release();
      }
    };
    const state = (): KeepAwakeState => {
      const now = clock.currentTimeMillisUnsafe();
      return {
        settings: document.settings,
        blocking: blocker !== null,
        error: lastError ?? storageError,
        threads: document.threads.map((thread) => {
          const observation = observations.get(thread.key);
          const status = !wantsAwake(thread)
            ? "off"
            : !fresh(observation, now)
              ? thread.startedAt === null
                ? "idle"
                : "unknown"
              : !observation?.unfinished && !finishing.has(thread.key)
                ? "idle"
                : observation?.needsAwake || finishing.has(thread.key)
                  ? "awake"
                  : "paused";
          return {
            ...thread,
            status,
            reason:
              status === "unknown"
                ? "Waiting for a fresh execution update"
                : (observation?.reason ?? "No current work"),
          };
        }),
      };
    };
    const handle = (request: KeepAwakeRequest) =>
      Effect.try({
        try: () => {
          const now = clock.currentTimeMillisUnsafe();
          if (request.type === "configure") {
            persist({
              ...document,
              settings: { mode: request.settings.mode ?? document.settings.mode },
            });
          } else if (request.type === "choose") {
            const previous = document.threads.find((thread) => thread.key === request.key);
            const thread: KeepAwakeThread = previous ?? {
              key: request.key,
              title: request.title,
              once: false,
              startedAt: null,
            };
            const observation = observations.get(request.key);
            const selected = selectKeepAwakeSession(
              thread,
              request.choice,
              request.work ?? (fresh(observation, now) ? observation : undefined),
              now,
            );
            persist({
              ...document,
              threads: [
                ...document.threads.filter((entry) => entry.key !== request.key),
                {
                  ...selected,
                  title: request.title,
                },
              ],
            });
            if (selected !== thread) finishing.delete(request.key);
          } else if (request.type === "report") {
            let changed = false;
            const threads = new Map(document.threads.map((thread) => [thread.key, thread]));
            for (const observation of request.observations) {
              if (!fresh(observation, now)) continue;
              const last = observations.get(observation.key);
              // Re-rendering a cached result is not proof that the backend is alive.
              if (last !== undefined && observation.observedAt <= last.observedAt) continue;
              observations.set(observation.key, observation);
              let thread = threads.get(observation.key);
              if (!thread) {
                if (!observation.unfinished || document.settings.mode !== "running") continue;
                thread = {
                  key: observation.key,
                  title: observation.title,
                  once: false,
                  startedAt: null,
                };
              }
              if (thread.title !== observation.title) {
                thread = { ...thread, title: observation.title };
                changed = true;
              }
              const session = observeKeepAwakeSession(
                thread,
                observation,
                finishing.get(thread.key),
                wantsAwake(thread),
              );
              if (session.thread !== thread) changed = true;
              thread = session.thread;
              if (session.completion === undefined) finishing.delete(thread.key);
              else finishing.set(thread.key, session.completion);
              if (!threads.has(thread.key)) changed = true;
              threads.set(thread.key, thread);
            }
            if (changed)
              persist({
                ...document,
                threads: Array.from(threads.values()).filter(
                  (thread) => thread.once || thread.startedAt !== null,
                ),
              });
          }
          reconcile();
          return state();
        },
        catch: (cause) => {
          // Persistence failure must not leave an unbounded native request behind.
          release();
          lastError = "Could not save keep-awake preferences.";
          return new KeepAwakeError({ cause });
        },
      });
    const beforeQuit = () => {
      quitting = true;
      release();
    };
    yield* Effect.sync(reconcile).pipe(
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
    app.on("before-quit", beforeQuit);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        app.removeListener("before-quit", beforeQuit);
        release();
      }),
    );
    return DesktopKeepAwake.of({ handle });
  }),
);

export const keepAwake = makeIpcMethod({
  channel: KEEP_AWAKE_CHANNEL,
  payload: KeepAwakeRequest,
  result: KeepAwakeState,
  handler: Effect.fn("desktop.keepAwake.request")(function* (request, event) {
    const windows = yield* ElectronWindow;
    const main = yield* windows.main;
    if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id) {
      return yield* new KeepAwakeError({
        cause: "Only the main application window can control keep-awake.",
      });
    }
    const service = yield* DesktopKeepAwake;
    return yield* service.handle(request);
  }),
});
