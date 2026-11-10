import { EnvironmentHttpApi, ScientCloudError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

const unavailable = () =>
  Effect.fail(
    new ScientCloudError({
      reason: "cloud-unavailable",
      message: "Cloud copies are not available in this build yet.",
    }),
  );

/** Placeholder until the cloud services land; every endpoint answers `cloud-unavailable`. */
export const scientCloudHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientCloud",
  (handlers) =>
    Effect.succeed(
      handlers
        .handle("status", unavailable)
        .handle("enrollmentProof", unavailable)
        .handle("enrollmentComplete", unavailable)
        .handle("setEnabled", unavailable)
        .handle("stop", unavailable)
        .handle("shareBuild", unavailable)
        .handle("takeOver", unavailable),
    ),
);
