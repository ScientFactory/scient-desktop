import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentInternalErrorReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { LatexBuildService } from "./LatexBuildService.ts";
import { LatexManagedToolchain } from "./LatexManagedToolchain.ts";
import { LatexToolchain } from "./LatexToolchain.ts";

function handle<A, E>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  reason: EnvironmentInternalErrorReason,
  run: Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    yield* annotateEnvironmentRequest(endpointName);
    yield* requireEnvironmentScope(scope);
    return yield* run.pipe(Effect.catch((cause) => failEnvironmentInternal(reason, cause)));
  });
}

export const scientLatexHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientLatex",
  Effect.fnUntraced(function* (handlers) {
    const builds = yield* LatexBuildService;
    const toolchain = yield* LatexToolchain;
    const managed = yield* LatexManagedToolchain;

    /** The probe result plus what this server can do about a missing engine. */
    const toolchainReport = (refresh: boolean) =>
      Effect.gen(function* () {
        // Read the install state first. A finished install drops the probe
        // cache before it reports itself ready, so probing afterwards means a
        // report that says `ready` has already seen the engine it installed —
        // which is what lets the client rebuild the moment it reads that.
        const managedInstall = yield* managed.status;
        const status = yield* toolchain.probe(refresh);
        return {
          ...status,
          canInstallManaged: managed.canInstall,
          // An install nobody has started yet is not news for the client.
          ...(managedInstall.state === "idle" ? {} : { managedInstall }),
        };
      });

    return handlers
      .handle("build", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          "scient_latex_build_failed",
          builds.requestBuild(args.payload),
        ),
      )
      .handle("status", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationReadScope,
          "scient_latex_build_failed",
          builds.status(args.payload),
        ),
      )
      .handle("cancel", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          "scient_latex_build_failed",
          builds.cancel(args.payload),
        ),
      )
      .handle("toolchain", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationReadScope,
          "scient_latex_toolchain_failed",
          toolchainReport(args.payload.refresh),
        ),
      )
      .handle("installToolchain", (args) =>
        handle(
          args.endpoint.name,
          AuthOrchestrationOperateScope,
          "scient_latex_install_failed",
          managed.install,
        ),
      );
  }),
);
