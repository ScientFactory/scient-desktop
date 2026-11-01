import {
  KEEP_AWAKE_WORK_PATH,
  KeepAwakeChoice,
  KeepAwakeState,
  KeepAwakeWork,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { powerSaveBlocker } from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import { KEEP_AWAKE_CHANNEL } from "../../ipc/channels.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { keepsAwake, NO_HOLD, observeWork } from "./keepAwakeHold.ts";

const WINDOWS_NOTICE =
  "On Windows laptops with Modern Standby, battery power can end this a few minutes after the normal sleep time.";

class KeepAwakePowerError extends Schema.TaggedError<KeepAwakePowerError>()("KeepAwakePowerError", {
  cause: Schema.Defect(),
}) {}

export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    readonly handle: (choice: KeepAwakeChoice | undefined) => Effect.Effect<KeepAwakeState>;
  }
>()("@t3tools/desktop/scient/keepAwake/DesktopKeepAwake") {}

export const layer = Layer.effect(
  DesktopKeepAwake,
  Effect.gen(function* () {
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const lock = yield* Semaphore.make(1);
    let hold = NO_HOLD;
    let appSetting = false;
    let blocker: number | null = null;

    const readWork = Effect.gen(function* () {
      const config = yield* (yield* pool.primary).currentConfig;
      if (Option.isNone(config)) return null;
      const response = yield* http.execute(
        HttpClientRequest.get(new URL(KEEP_AWAKE_WORK_PATH, config.value.httpBaseUrl)).pipe(
          HttpClientRequest.bearerToken(yield* auth.getBearerToken),
        ),
      );
      return yield* HttpClientResponse.schemaBodyJson(KeepAwakeWork)(response);
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchCause(() => Effect.succeed(null)),
    );

    const setBlocked = (blocked: boolean) =>
      Effect.try({
        try: () => {
          if (blocked && blocker === null) {
            blocker = powerSaveBlocker.start("prevent-app-suspension");
          } else if (!blocked && blocker !== null) {
            powerSaveBlocker.stop(blocker);
            blocker = null;
          }
        },
        catch: (cause) => new KeepAwakePowerError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Keep-awake could not change its sleep request.", error),
        ),
      );

    const refresh = Effect.gen(function* () {
      appSetting = yield* settings.get.pipe(
        Effect.map(Option.exists((saved) => saved.keepComputerAwake)),
        Effect.orElseSucceed(() => false),
      );
      const work = appSetting || hold.chosen.size > 0 ? yield* readWork : null;
      const now = yield* Clock.currentTimeMillis;
      hold = observeWork(hold, work, appSetting, now);
      yield* setBlocked(keepsAwake(hold, now));
    });

    yield* lock
      .withPermits(1)(refresh)
      .pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped);
    yield* Effect.addFinalizer(() => setBlocked(false));

    return DesktopKeepAwake.of({
      handle: Effect.fn("DesktopKeepAwake.handle")(function* (choice) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (choice !== undefined) {
              const chosen = new Map(hold.chosen);
              if (choice.enabled) chosen.set(choice.threadId, null);
              else chosen.delete(choice.threadId);
              hold = { ...hold, chosen };
              yield* refresh;
            }
            return {
              appSetting,
              active: blocker !== null,
              threads: [...hold.chosen.keys()],
              notice: environment.platform === "win32" ? WINDOWS_NOTICE : null,
            };
          }),
        );
      }),
    });
  }),
);

export const keepAwake = makeIpcMethod({
  channel: KEEP_AWAKE_CHANNEL,
  payload: Schema.UndefinedOr(KeepAwakeChoice),
  result: KeepAwakeState,
  handler: Effect.fn("desktop.keepAwake")(function* (choice) {
    const service = yield* DesktopKeepAwake;
    return yield* service.handle(choice);
  }),
});
