import { initializeScientProject, inspectScientProject } from "@scientfactory/project-init";
import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Option from "effect/Option";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";

class ScientProjectFilesystemError extends Data.TaggedError("ScientProjectFilesystemError")<{
  readonly cause: unknown;
}> {}

function projectFailureClass(cause: unknown): "filesystem" | "permission" | "validation" {
  if (cause instanceof Error && "code" in cause) {
    const code = String(cause.code);
    if (code === "EACCES" || code === "EPERM") return "permission";
    if (["EIO", "ENOENT", "ENOSPC", "EROFS"].includes(code)) return "filesystem";
  }
  return "validation";
}

export const scientProjectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientProject",
  Effect.fnUntraced(function* (handlers) {
    const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
    const recordAnalytics = (event: string, properties: Readonly<Record<string, unknown>>) =>
      Option.match(analytics, {
        onNone: () => Effect.void,
        onSome: (service) => service.record(event, properties),
      });
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
            Effect.tap((result) =>
              recordAnalytics("project.initialization.completed", {
                outcome: result.created.length === 0 ? "already-ready" : "created",
                filesCreated: result.created.length,
              }),
            ),
            Effect.tapError((error) =>
              recordAnalytics("project.initialization.failed", {
                failureClass: projectFailureClass(error.cause),
              }),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("scient_project_initialization_failed", cause),
            ),
          );
        }),
      );
  }),
);
