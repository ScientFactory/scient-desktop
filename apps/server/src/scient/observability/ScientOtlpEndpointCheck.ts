import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as OtlpEndpointCheck from "../../observability/OtlpEndpointCheck.ts";

/** Keep inherited endpoint diagnostics behind Scient's outbound observability hold. */
export function guardOtlpEndpointCheck(
  service: OtlpEndpointCheck.OtlpEndpointCheck["Service"],
): OtlpEndpointCheck.OtlpEndpointCheck["Service"] {
  return {
    check: (input) =>
      SCIENT_DESKTOP_IDENTITY.safetyEnvelopeEnabled
        ? Effect.succeed({ _tag: "Rejected" as const, status: 403 })
        : service.check(input),
  };
}

export const layer = Layer.effect(
  OtlpEndpointCheck.OtlpEndpointCheck,
  OtlpEndpointCheck.OtlpEndpointCheck.pipe(Effect.map(guardOtlpEndpointCheck)),
).pipe(Layer.provide(OtlpEndpointCheck.layer));
