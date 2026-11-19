import { GuestShareCreateError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ConnectReachability from "../../cloud/ConnectReachability.ts";

/**
 * Refuses a new guest link while other devices cannot reach this server through Scient Connect,
 * by the same answer Sharing & access shows. A tunnel hostname alone does not prove that, and
 * creating a link ends the current one. Servers built without the check service skip it.
 */
export const requireReachableGuestHost = Effect.fn("ScientGuestLinks.requireReachableHost")(
  function* () {
    const reachability = yield* Effect.serviceOption(ConnectReachability.ConnectReachability);
    if (Option.isNone(reachability)) return;
    const latest = yield* reachability.value.latest;
    if (Option.isSome(latest) && latest.value.status === "reachable") return;
    // The last answer may be stale, so look again before refusing.
    const checked = yield* reachability.value.check;
    if (checked.status === "unreachable") {
      return yield* new GuestShareCreateError({ reason: "connect_unavailable" });
    }
  },
);
