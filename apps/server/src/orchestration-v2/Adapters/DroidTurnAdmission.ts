import * as Effect from "effect/Effect";
import { AcpRequestError } from "effect-acp/errors";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";

/** Revalidate the owning Scient attempt after Droid settings preparation. */
export const confirmDroidTurnAdmission = Effect.fnUntraced(function* (
  input: ProviderAdapterV2TurnInput,
) {
  if (input.shouldStartProviderTurn && !(yield* input.shouldStartProviderTurn())) {
    return yield* new AcpRequestError({
      code: -32602,
      errorMessage: "The owning Scient attempt no longer admits this Droid turn.",
    });
  }
});
