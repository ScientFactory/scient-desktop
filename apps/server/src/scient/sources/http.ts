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
import {
  advanceZoteroImport,
  beginZoteroImport,
  cancelZoteroImport,
  getScientSourcesOverview,
  inspectZoteroConnection,
  listZoteroLibrary,
  preflightZoteroImport,
} from "./ScientSourcesCoordinator.ts";

function handle<A>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  run: () => Promise<A>,
) {
  return Effect.gen(function* () {
    yield* annotateEnvironmentRequest(endpointName);
    yield* requireEnvironmentScope(scope);
    return yield* Effect.tryPromise(run).pipe(
      Effect.catch((cause) => failEnvironmentInternal("scient_sources_operation_failed", cause)),
    );
  });
}

export const scientSourcesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientSources",
  Effect.fnUntraced(function* (handlers) {
    return yield* Effect.succeed(
      handlers
        .handle("overview", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            getScientSourcesOverview(args.payload.root),
          ),
        )
        .handle("zoteroStatus", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () => inspectZoteroConnection()),
        )
        .handle("zoteroLibrary", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listZoteroLibrary(args.payload),
          ),
        )
        .handle("preflight", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            preflightZoteroImport(args.payload),
          ),
        )
        .handle("beginImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            beginZoteroImport(args.payload),
          ),
        )
        .handle("advanceImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            advanceZoteroImport(args.payload),
          ),
        )
        .handle("cancelImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            cancelZoteroImport(args.payload),
          ),
        ),
    );
  }),
);
