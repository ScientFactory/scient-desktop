/** Bound provider acknowledgement without turning uncertainty into "not sent". */
import * as Effect from "effect/Effect";
import { markTurnDispatchAttempted } from "../../provider/turnDispatchPhase.ts";

export const withForkSendDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("60 seconds"),
    Effect.catchTag("TimeoutError", (error) => {
      markTurnDispatchAttempted(error);
      return Effect.fail(error);
    }),
  );
