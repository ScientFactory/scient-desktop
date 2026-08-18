import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import * as ServerConfig from "../../config.ts";
import {
  enqueueScientThreadQueueItem,
  listScientThreadQueue,
  removeScientThreadQueueItem,
  reorderScientThreadQueue,
} from "./Store.ts";

/**
 * HTTP surface for the Scient thread queue. Thin auth + error-mapping shell
 * over the store; the queue never touches orchestration. Scient-owned; see
 * `docs/internals/scient-thread-queue.md`.
 */

function handle<A>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  run: (stateDir: string) => Promise<A>,
) {
  return Effect.gen(function* () {
    yield* annotateEnvironmentRequest(endpointName);
    yield* requireEnvironmentScope(scope);
    const config = yield* ServerConfig.ServerConfig;
    return yield* Effect.tryPromise(() => run(config.stateDir)).pipe(
      Effect.catch((cause) =>
        failEnvironmentInternal("scient_thread_queue_operation_failed", cause),
      ),
    );
  });
}

export const scientThreadQueueHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientThreadQueue",
  Effect.fnUntraced(function* (handlers) {
    return yield* Effect.succeed(
      handlers
        .handle("list", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, (stateDir) =>
            listScientThreadQueue({ stateDir, threadId: args.payload.threadId }),
          ),
        )
        .handle("enqueue", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, (stateDir) =>
            enqueueScientThreadQueueItem({ stateDir, ...args.payload }),
          ),
        )
        .handle("remove", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, (stateDir) =>
            removeScientThreadQueueItem({ stateDir, ...args.payload }),
          ),
        )
        .handle("reorder", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, (stateDir) =>
            reorderScientThreadQueue({ stateDir, ...args.payload }),
          ),
        ),
    );
  }),
);
