import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { PREPARE_UPDATE_SAVE_CHANNEL, RELEASE_UPDATE_SAVE_CHANNEL } from "../ipc/channels.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

interface PendingWindow {
  readonly frame: unknown;
  readonly response: Deferred.Deferred<boolean>;
  completed: boolean;
}

export class DesktopUpdateSave extends Context.Service<
  DesktopUpdateSave,
  {
    readonly prepare: Effect.Effect<boolean>;
    readonly prepareForRestart: Effect.Effect<boolean>;
    readonly release: Effect.Effect<void>;
    readonly acknowledge: (input: {
      readonly requestId: string;
      readonly senderId: number;
      readonly senderFrame: unknown;
      readonly saved: boolean;
    }) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopUpdateSave") {}

export const make = Effect.gen(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const random = yield* SecureRandom.SecureRandom;
  const mutex = yield* Semaphore.make(1);
  const { logWarning } = makeComponentLogger("desktop-update-save");
  let pending: { requestId: string; windows: Map<number, PendingWindow> } | null = null;
  let unlockWindows: Array<() => void> = [];
  const release = Effect.sync(() => {
    const unlock = unlockWindows;
    unlockWindows = [];
    for (const sendRelease of unlock) {
      try {
        sendRelease();
      } catch {}
    }
  });
  const prepare = Effect.fn("desktop.updateSave.prepare")(function* (lockForRestart: boolean) {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* desktopWindow.flushMainWindowBounds;
        const snapshot = yield* windows.appWindows;
        if (snapshot.some((window) => window.isDestroyed())) return false;
        const requestId = yield* random.uuidV4();
        const responses = new Map<number, PendingWindow>();
        for (const window of snapshot) {
          responses.set(window.webContents.id, {
            frame: window.webContents.mainFrame,
            response: yield* Deferred.make<boolean>(),
            completed: false,
          });
        }
        pending = { requestId, windows: responses };
        const waitForSaves = Effect.gen(function* () {
          for (const window of snapshot) {
            const sent = yield* Effect.sync(() => {
              try {
                if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
                if (lockForRestart)
                  unlockWindows.push(() => {
                    if (!window.isDestroyed() && !window.webContents.isDestroyed())
                      window.webContents.send(RELEASE_UPDATE_SAVE_CHANNEL, requestId);
                  });
                window.webContents.send(PREPARE_UPDATE_SAVE_CHANNEL, { requestId, lockForRestart });
                return true;
              } catch {
                return false;
              }
            });
            if (!sent) return false;
          }
          const results = yield* Effect.forEach(
            responses.values(),
            (entry) => Deferred.await(entry.response),
            { concurrency: "unbounded" },
          );
          if (
            !results.every(Boolean) ||
            snapshot.some((window) => window.isDestroyed() || window.webContents.isDestroyed())
          )
            return false;
          const current = yield* windows.appWindows;
          return (
            current.length === snapshot.length &&
            current.every((window) => {
              const entry = responses.get(window.webContents.id);
              return entry !== undefined && entry.frame === window.webContents.mainFrame;
            })
          );
        });
        const outcome = yield* waitForSaves.pipe(
          Effect.timeoutOption(Duration.seconds(20)),
          Effect.ensuring(
            Effect.sync(() => {
              pending = null;
            }),
          ),
        );
        const saved = Option.isSome(outcome) && outcome.value;
        if (!saved) {
          yield* release;
          yield* logWarning("update paused because app windows did not confirm saved state");
        }
        return saved;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending = null;
          }),
        ),
        Effect.catchCause(() =>
          release.pipe(
            Effect.andThen(logWarning("update save barrier could not complete")),
            Effect.as(false),
          ),
        ),
        Effect.onInterrupt(() => release),
      ),
    );
  });
  return DesktopUpdateSave.of({
    prepare: prepare(false),
    prepareForRestart: prepare(true),
    release,
    acknowledge: Effect.fn("desktop.updateSave.acknowledge")(function* (ack) {
      if (pending === null || ack.requestId !== pending.requestId) return false;
      const window = pending.windows.get(ack.senderId);
      if (window === undefined || window.completed || window.frame !== ack.senderFrame)
        return false;
      window.completed = true;
      yield* Deferred.succeed(window.response, ack.saved);
      return true;
    }),
  });
});

export const layer = Layer.effect(DesktopUpdateSave, make);
