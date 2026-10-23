import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { failEnvironmentInternal, requireEnvironmentScope } from "../../auth/http.ts";
import { KeepAwakeService } from "./KeepAwakeService.ts";

export const httpLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientKeepAwake",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* KeepAwakeService;
    return handlers.handle("observe", ({ payload }) =>
      requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
        Effect.andThen(service.observe(payload)),
        Effect.catchTags({
          KeepAwakeObservationError: (cause) =>
            failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
        }),
      ),
    );
  }),
);
