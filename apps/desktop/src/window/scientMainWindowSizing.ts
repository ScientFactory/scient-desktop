// SCIENT-OWNED: Scient's main window sizing. Fresh profiles open near full size
// on the primary display; older profiles get their saved size raised once.
// DesktopWindow.ts calls these from short marked lines and re-exports the
// resolvers for its tests.
import * as Effect from "effect/Effect";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
// DesktopWindow.ts imports this module too; windowFitsWithinDisplay is a hoisted
// function that is only called after both modules have loaded.
import { type DisplayBounds, windowFitsWithinDisplay } from "./DesktopWindow.ts";

type DisplayArea = { readonly bounds: DisplayBounds; readonly workArea: DisplayBounds };
const MAIN_WINDOW_WORK_AREA_INSET = 8;

// The same component name as DesktopWindow.ts, so these warnings read as window warnings.
const { logWarning } = makeComponentLogger("desktop-window");

export function nearFullMainWindowSize(workArea: DisplayBounds): { width: number; height: number } {
  return {
    width: Math.max(
      DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.width,
      workArea.width - 2 * MAIN_WINDOW_WORK_AREA_INSET,
    ),
    height: Math.max(
      DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.height,
      workArea.height - 2 * MAIN_WINDOW_WORK_AREA_INSET,
    ),
  };
}

export function resolveOneTimeNearFullMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  isMaximized: boolean,
  displays: readonly DisplayArea[],
): DesktopAppSettings.DesktopWindowBounds | null {
  if (persistedBounds === null || isMaximized) return persistedBounds;
  const display = displays.find((area) => windowFitsWithinDisplay(persistedBounds, area.bounds));
  if (display === undefined) return persistedBounds;

  const { workArea } = display;
  const isOldDefault =
    (persistedBounds.width === 1100 && persistedBounds.height === 780) ||
    (persistedBounds.width === 1280 && persistedBounds.height === 840);
  // Include windows already sized almost to the work area, such as a saved
  // 1698x977 window on a 1728x1005 work area, without changing smaller choices.
  const isNearFull =
    persistedBounds.width >= workArea.width * 0.95 &&
    persistedBounds.height >= workArea.height * 0.95;
  if (!isOldDefault && !isNearFull) return persistedBounds;

  const target = nearFullMainWindowSize(workArea);
  const width = Math.max(persistedBounds.width, target.width);
  const height = Math.max(persistedBounds.height, target.height);
  if (width === persistedBounds.width && height === persistedBounds.height) return persistedBounds;
  const horizontalArea = width <= workArea.width ? workArea : display.bounds;
  const verticalArea = height <= workArea.height ? workArea : display.bounds;
  return {
    x: horizontalArea.x + Math.floor((horizontalArea.width - width) / 2),
    y: verticalArea.y + Math.floor((verticalArea.height - height) / 2),
    width,
    height,
  };
}

export function resolveOneTimeMainWindowSizeIncrease(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayArea[],
  primaryDisplay: DisplayArea,
): DesktopAppSettings.DesktopWindowBounds | null {
  if (persistedBounds === null) return null;

  const currentDisplay = displays.find((display) =>
    windowFitsWithinDisplay(persistedBounds, display.bounds),
  );
  const display = currentDisplay ?? primaryDisplay;
  const { workArea } = display;
  const initialBounds = currentDisplay === undefined ? null : persistedBounds;
  const width = Math.max(
    initialBounds?.width ?? DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.width,
    Math.min(DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE.width, workArea.width),
  );
  const height = Math.max(
    initialBounds?.height ?? DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.height,
    Math.min(DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE.height, workArea.height),
  );
  if (initialBounds !== null && width === initialBounds.width && height === initialBounds.height) {
    return initialBounds;
  }
  // Preserve a larger saved dimension; use the full display only when that
  // dimension already exceeds its usable work area.
  const horizontalArea = width <= workArea.width ? workArea : display.bounds;
  const verticalArea = height <= workArea.height ? workArea : display.bounds;
  return {
    x: Math.min(
      Math.max(
        initialBounds?.x ?? workArea.x + Math.floor((workArea.width - width) / 2),
        horizontalArea.x,
      ),
      horizontalArea.x + horizontalArea.width - width,
    ),
    y: Math.min(
      Math.max(
        initialBounds?.y ?? workArea.y + Math.floor((workArea.height - height) / 2),
        verticalArea.y,
      ),
      verticalArea.y + verticalArea.height - height,
    ),
    width,
    height,
  };
}

/**
 * Applies the one-time size updates an older profile has not received yet and
 * returns the settings the window should open with. A failed write keeps the
 * settings it started from.
 */
export function applyOneTimeMainWindowSizing(
  desktopSettings: DesktopAppSettings.DesktopAppSettings["Service"],
  initialSettings: DesktopAppSettings.DesktopSettings,
  displays: readonly DisplayArea[],
  primaryDisplay: DisplayArea,
): Effect.Effect<DesktopAppSettings.DesktopSettings> {
  return Effect.gen(function* () {
    let persistedSettings = initialSettings;
    if (!persistedSettings.mainWindowSizeIncreaseApplied) {
      const increasedBounds = resolveOneTimeMainWindowSizeIncrease(
        persistedSettings.mainWindowBounds,
        displays,
        primaryDisplay,
      );
      persistedSettings = yield* desktopSettings.applyMainWindowSizeIncrease(increasedBounds).pipe(
        Effect.map((change) => change.settings),
        Effect.catch((error) =>
          logWarning("failed to persist one-time main window size increase", {
            message: error.message,
          }).pipe(Effect.as(persistedSettings)),
        ),
      );
    }
    if (!persistedSettings.mainWindowNearFullSizeApplied) {
      const nearFullBounds = resolveOneTimeNearFullMainWindowBounds(
        persistedSettings.mainWindowBounds,
        persistedSettings.mainWindowMaximized,
        displays,
      );
      persistedSettings = yield* desktopSettings.applyMainWindowNearFullSize(nearFullBounds).pipe(
        Effect.map((change) => change.settings),
        Effect.catch((error) =>
          logWarning("failed to persist near-full main window size", {
            message: error.message,
          }).pipe(Effect.as(persistedSettings)),
        ),
      );
    }
    return persistedSettings;
  });
}
