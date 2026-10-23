import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { powerSaveBlocker } from "electron";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";

export class KeepAwakePowerError extends Schema.TaggedError<KeepAwakePowerError>()(
  "KeepAwakePowerError",
  { cause: Schema.Defect() },
) {}
export class KeepAwakePower extends Context.Service<
  KeepAwakePower,
  {
    readonly start: Effect.Effect<number, KeepAwakePowerError>;
    readonly stop: (id: number) => Effect.Effect<void>;
    readonly notice: string | undefined;
  }
>()("@t3tools/desktop/scient/keepAwake/power/KeepAwakePower") {}
export const layer = Layer.effect(
  KeepAwakePower,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    return KeepAwakePower.of({
      start: Effect.try({
        try: () => powerSaveBlocker.start("prevent-app-suspension"),
        catch: (cause) => new KeepAwakePowerError({ cause }),
      }).pipe(Effect.tap((id) => Effect.logInfo("scient.keep-awake.request-started", { id }))),
      stop: (id) =>
        Effect.sync(() => {
          powerSaveBlocker.stop(id);
        }).pipe(Effect.andThen(Effect.logInfo("scient.keep-awake.request-stopped", { id }))),
      notice:
        environment.platform === "win32"
          ? "On Windows Modern Standby laptops, battery power can limit protection after the sleep timeout. Closing the lid or choosing Sleep can still pause work."
          : undefined,
    });
  }),
);
