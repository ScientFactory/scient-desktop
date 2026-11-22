/**
 * Chromium 152 stops a renderer when a route-changing input event predates the page's load
 * (`CHECK_GT` in `SoftNavigationHeuristics`); macOS passes posted events' timestamps through
 * unchecked. Scient reads no soft-navigation timing, so detection is off.
 */
const SOFT_NAVIGATION_FEATURE = "SoftNavigationDetection";

/**
 * The `--disable-features` value that also turns off soft-navigation detection, keeping the
 * features already listed (Chromium keeps only the last value of the switch), or null when it is
 * already listed.
 */
export function disableFeaturesWithSoftNavigation(current: string | null): string | null {
  const names = (current ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.some((name) => name.split("<")[0] === SOFT_NAVIGATION_FEATURE)) return null;
  return [...names, SOFT_NAVIGATION_FEATURE].join(",");
}
