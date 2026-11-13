import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Whether this build uses Scient Cloud: on once the service is live, or when `SCIENT_CLOUD_URL`
 * names a cloud to test against. When off, nothing here talks to the cloud or refuses turns.
 */
export const scientCloudLive: Effect.Effect<boolean> = Effect.gen(function* () {
  if (SCIENT_DESKTOP_IDENTITY.scientCloudLive) return true;
  const configured = yield* Config.String("SCIENT_CLOUD_URL").pipe(Config.option);
  return Option.match(configured, { onNone: () => false, onSome: (url) => url.trim() !== "" });
}).pipe(Effect.orElseSucceed(() => false));
