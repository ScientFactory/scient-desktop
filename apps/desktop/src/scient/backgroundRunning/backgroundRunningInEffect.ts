// SCIENT-OWNED: whether this desktop process runs in the background with no window.
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";

/**
 * The effective setting as this process first read it, after settings load. Window closing, the
 * tray, Quit and every backend's keychain deferral use it, so they always agree; a change of the
 * switch takes effect at the next start.
 */
export const backgroundRunningInEffect = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  const fixed = yield* Ref.get(state.backgroundRunningInEffect);
  if (fixed !== undefined) return fixed;
  const { platform } = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
  const value = DesktopAppSettings.keepsRunningInBackground(settings, platform);
  return yield* Ref.modify(state.backgroundRunningInEffect, (current) =>
    current === undefined ? [value, value] : [current, current],
  );
}).pipe(Effect.withSpan("scient.backgroundRunning.inEffect"));
