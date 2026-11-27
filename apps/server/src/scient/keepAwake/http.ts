import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { failEnvironmentInternal, requireEnvironmentScope } from "../../auth/http.ts";
import * as AnalysisService from "../analysis/AnalysisService.ts";
import * as ComputeSessionService from "../compute/ComputeSessionService.ts";
import * as KeepAwakeService from "./KeepAwakeService.ts";

export const scientKeepAwakeHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientKeepAwake",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* KeepAwakeService.KeepAwakeService;
    const compute = yield* ComputeSessionService.ComputeSessionService;
    const analysis = yield* AnalysisService.AnalysisService;
    return handlers
      .handle("work", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.andThen(service.work),
          Effect.catchTags({
            KeepAwakeWorkError: (cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
          }),
        ),
      )
      .handle("computeActiveWork", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.andThen(Effect.all([compute.activeWork, analysis.activeRunCount])),
          Effect.map(([sessions, files]) => ({ count: sessions + files })),
        ),
      );
  }),
).pipe(Layer.provide(KeepAwakeService.layer));
