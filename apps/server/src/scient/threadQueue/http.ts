import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ScientThreadQueueOperationError,
  OrchestrationDispatchCommandError,
  type EnvironmentInternalError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { makeLegacyQueueCompatibility } from "../../orchestration-v2/legacy/LegacyQueueCompatibility.ts";
import { QueueError } from "./Ledger.ts";
import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
} from "../../orchestration-v2/Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";

const isQueueOperationError = Schema.is(ScientThreadQueueOperationError);
const isQueueError = Schema.is(QueueError);
const isDispatchError = Schema.is(OrchestratorDispatchError);
const isRejectedError = Schema.is(OrchestratorCommandRejectedError);
const isLegacyDispatchError = Schema.is(OrchestrationDispatchCommandError);

export const scientThreadQueueHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientThreadQueue",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* makeLegacyQueueCompatibility;
    const handle = (name: string, request: Parameters<typeof service.execute>[0]) =>
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest(name);
        yield* requireEnvironmentScope(
          request.method === "list" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
        );
        return yield* service.execute(request).pipe(
          Effect.catch(
            (
              cause,
            ): Effect.Effect<never, ScientThreadQueueOperationError | EnvironmentInternalError> => {
              if (isQueueOperationError(cause)) return Effect.fail(cause);
              if (isQueueError(cause))
                return Effect.fail(new ScientThreadQueueOperationError({ message: cause.message }));
              if (isDispatchError(cause) && typeof cause.cause === "string")
                return Effect.fail(new ScientThreadQueueOperationError({ message: cause.cause }));
              if (isRejectedError(cause) && isLegacyDispatchError(cause.cause)) {
                const message = userFacingDispatchErrorMessage(cause.cause);
                if (message !== undefined)
                  return Effect.fail(new ScientThreadQueueOperationError({ message }));
              }
              return failEnvironmentInternal("scient_thread_queue_operation_failed", cause);
            },
          ),
        );
      });
    return handlers
      .handle("list", ({ endpoint, payload }) => handle(endpoint.name, { method: "list", payload }))
      .handle("enqueue", ({ endpoint, payload }) =>
        handle(endpoint.name, { method: "enqueue", payload }),
      )
      .handle("update", ({ endpoint, payload }) =>
        handle(endpoint.name, { method: "update", payload }),
      )
      .handle("remove", ({ endpoint, payload }) =>
        handle(endpoint.name, { method: "remove", payload }),
      )
      .handle("reorder", ({ endpoint, payload }) =>
        handle(endpoint.name, { method: "reorder", payload }),
      )
      .handle("control", ({ endpoint, payload }) =>
        handle(endpoint.name, { method: "control", payload }),
      );
  }),
);
