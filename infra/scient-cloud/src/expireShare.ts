import * as Effect from "effect/Effect";

import { Objects } from "./Objects.ts";
import { Users } from "./Services.ts";
import type { ShareApi } from "./ShareStore.ts";

/** The share alarm: an expired link loses its objects and stops counting against its owner. */
export const expireShare = Effect.fn("ShareExpiry.expireShare")(function* (
  share: ShareApi,
  now: number,
) {
  const expired = yield* share.expire(now);
  if (expired === null) return;
  yield* (yield* Objects).delete(expired.keys);
  yield* (yield* Users).get(expired.owner).removeShare(expired.shareId);
});
