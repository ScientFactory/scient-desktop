import { initializeScientProject, inspectScientProject } from "@scientfactory/project-init";
import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";

class ScientProjectFilesystemError extends Data.TaggedError("ScientProjectFilesystemError")<{
  readonly cause: unknown;
}> {}

export const scientProjectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientProject",
  Effect.fnUntraced(function* (handlers) {
    yield* Effect.void;
    return handlers
      .handle(
        "inspect",
        Effect.fn("environment.scientProject.inspect")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* Effect.tryPromise({
            try: () => inspectScientProject(args.payload.root),
            catch: (cause) => new ScientProjectFilesystemError({ cause }),
          }).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("scient_project_inspection_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "initialize",
        Effect.fn("environment.scientProject.initialize")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const title = args.payload.title;
          return yield* Effect.tryPromise({
            try: () =>
              initializeScientProject({
                root: args.payload.root,
                ...(title === undefined ? {} : { title }),
              }),
            catch: (cause) => new ScientProjectFilesystemError({ cause }),
          }).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("scient_project_initialization_failed", cause),
            ),
          );
        }),
      );
  }),
);
