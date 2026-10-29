/**
 * Where the permissions control lives, which blocks overflow, and which menu answers the
 * composer.mode shortcut. Blocks are ordered [traits, mode]; the last block overflows first.
 * The rule: Permissions have exactly one visible home and composer.mode exactly one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** The thread uses the user's default permissions. */
  readonly matchesDefault: boolean;
  // SCIENT-FORK:START — Permissions open their own card; the effort menu never holds them.
  /** The new-thread strip below the composer names the permissions and opens their card. */
  readonly shownInStrip: boolean;
  // SCIENT-FORK:END
  /** The model has an effort (traits) menu. */
  readonly hasTraits: boolean;
  readonly planModeUiEnabled: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  // SCIENT-FORK:START — Permissions open their own card; the effort menu never holds them.
  // The strip button is their home in a new thread; otherwise the chip stays, as an icon at
  // the user's default.
  const accessDisplay = input.shownInStrip
    ? ("hidden" as const)
    : !input.matchesDefault && !input.collapsed
      ? ("label" as const)
      : ("icon" as const);
  // SCIENT-FORK:END
  const showModeBlock = !(accessDisplay === "hidden" && !input.planModeUiEnabled);
  const blockIds = [
    ...(input.hasTraits ? ["traits" as const] : []),
    ...(showModeBlock ? ["mode" as const] : []),
  ];
  const hiddenFor = (count: number) => blockIds.slice(blockIds.length - count);
  // SCIENT-FORK:START — Permissions overflow with their chip, not with the effort menu.
  const overflowShowsPermissionsFor = (hidden: ReadonlyArray<string>) =>
    accessDisplay !== "hidden" && hidden.includes("mode");
  // SCIENT-FORK:END
  const overflowHasContent = (hidden: ReadonlyArray<string>) =>
    hidden.includes("traits") ||
    (input.planModeUiEnabled && hidden.includes("mode")) ||
    overflowShowsPermissionsFor(hidden);

  let hiddenBlockCount = Math.min(input.measuredHiddenBlockCount, blockIds.length);
  // An overflow menu with nothing in it must not exist: overflow one more block instead.
  while (
    hiddenBlockCount > 0 &&
    hiddenBlockCount < blockIds.length &&
    !overflowHasContent(hiddenFor(hiddenBlockCount))
  ) {
    hiddenBlockCount += 1;
  }
  const hiddenBlockIds = hiddenFor(hiddenBlockCount);
  const modeHidden = hiddenBlockIds.includes("mode");
  const traitsHidden = hiddenBlockIds.includes("traits");
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount,
    hiddenBlockIds,
    traitsHidden,
    modeHidden,
    overflowShowsPermissions: overflowShowsPermissionsFor(hiddenBlockIds),
  };
}
