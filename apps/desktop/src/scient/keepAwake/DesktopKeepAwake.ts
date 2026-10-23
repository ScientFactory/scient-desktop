import {
  KEEP_AWAKE_CHANNEL,
  KeepAwakeRequest,
  KeepAwakeState,
  keepAwakeThreadKey,
  type KeepAwakeRequest as Request,
  type KeepAwakeState as State,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { ElectronApp } from "../../electron/ElectronApp.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import * as Controller from "./controller.ts";
import * as Storage from "./storage.ts";
import * as Power from "./power.ts";
import * as Source from "./source.ts";

export class KeepAwakeError extends Schema.TaggedError<KeepAwakeError>()("KeepAwakeError", {
  cause: Schema.Defect(),
}) {}
export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    readonly handle: (request: Request) => Effect.Effect<State, KeepAwakeError>;
  }
>()("@t3tools/desktop/scient/keepAwake/DesktopKeepAwake") {}

export const layer = Layer.effect(
  DesktopKeepAwake,
  Effect.gen(function* () {
    const controller = yield* Controller.make;
    const source = yield* Source.KeepAwakeSource;
    const app = yield* ElectronApp;
    const refresh = Effect.gen(function* () {
      const document = yield* controller.document;
      if (
        document.settings.mode === "system" &&
        !document.threads.some((thread) => thread.once || thread.startedAt !== null)
      )
        return;
      yield* source.observe(document).pipe(
        Effect.flatMap(controller.accept),
        Effect.catch(() => controller.failed),
      );
    });
    yield* refresh.pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped);
    yield* controller.tick.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
    const runStop = Effect.runForkWith(yield* Effect.context<never>());
    yield* app.on("before-quit", () => {
      runStop(controller.stop);
    });
    yield* Effect.addFinalizer(() => controller.stop);
    return DesktopKeepAwake.of({
      handle: Effect.fn("DesktopKeepAwake.handle")(
        function* (request: Request) {
          if (request.type === "choose" && request.choice === "once") {
            const document = yield* controller.document;
            const proposed = {
              ...document,
              threads: [
                ...document.threads.filter((entry) => entry.key !== request.key),
                { key: request.key, title: request.title, once: true, startedAt: null },
              ],
            };
            const results = yield* source.observe(proposed);
            const group = results
              .flatMap((entry) =>
                entry.batch.groups.map((group) => ({
                  environmentId: entry.batch.environmentId,
                  group,
                })),
              )
              .find(
                (entry) =>
                  keepAwakeThreadKey(entry.environmentId, entry.group.threadId) === request.key,
              )?.group;
            const root = group?.members.find((member) => member.threadId === group.threadId);
            if (!root || root.removed)
              return yield* new KeepAwakeError({
                cause: "The thread's execution environment is unavailable.",
              });
            yield* controller.handle(request, {
              latestRunId: root.latestRunId,
              unfinished: group!.members.some((member) => member.unfinished),
            });
            yield* controller.accept(results);
            return yield* controller.handle({ type: "get" });
          }
          const state = yield* controller.handle(request);
          if (
            request.type === "configure" &&
            request.settings.mode === "running" &&
            state.error === null
          ) {
            yield* refresh;
            return yield* controller.handle({ type: "get" });
          }
          return state;
        },
        Effect.mapError((cause) => new KeepAwakeError({ cause })),
      ),
    });
  }),
).pipe(
  Layer.provideMerge(Storage.layer),
  Layer.provideMerge(Power.layer),
  Layer.provideMerge(Source.layer),
);

export const keepAwake = makeIpcMethod({
  channel: KEEP_AWAKE_CHANNEL,
  payload: KeepAwakeRequest,
  result: KeepAwakeState,
  handler: Effect.fn("desktop.keepAwake.request")(function* (request, event) {
    const main = yield* (yield* ElectronWindow).main;
    if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id)
      return yield* new KeepAwakeError({
        cause: "Only the main window can change keep-awake preferences.",
      });
    return yield* (yield* DesktopKeepAwake).handle(request);
  }),
});
