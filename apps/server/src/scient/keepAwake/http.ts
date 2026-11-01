import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { failEnvironmentInternal, requireEnvironmentScope } from "../../auth/http.ts";
import * as KeepAwakeService from "./KeepAwakeService.ts";

export const scientKeepAwakeHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientKeepAwake",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* KeepAwakeService.KeepAwakeService;
    return handlers.handle("work", () =>
      requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
        Effect.andThen(service.work),
        Effect.catchTags({
          KeepAwakeWorkError: (cause) =>
            failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
        }),
      ),
    );
  }),
).pipe(Layer.provide(KeepAwakeService.layer));
