/**
 * Where the permissions chip shows, whether the mode block overflows, and which control answers
 * the composer.mode shortcut. The model picker's footer always holds Permissions as well. The
 * rule: composer.mode has one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** The thread uses the user's default permissions. */
  readonly matchesDefault: boolean;
  // SCIENT-FORK:START — Permissions open their own card; the effort menu never holds them.
  /** The new-thread strip below the composer names the permissions and opens their card. */
  readonly shownInStrip: boolean;
  // SCIENT-FORK:END
  readonly planModeUiEnabled: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  // SCIENT-FORK:START — the chip keeps opening its own card, beside the picker's footer.
  // The strip button is their home in a new thread; otherwise the chip stays, as an icon at
  // the user's default.
  const accessDisplay = input.shownInStrip
    ? ("hidden" as const)
    : !input.matchesDefault && !input.collapsed
      ? ("label" as const)
      : ("icon" as const);
  // SCIENT-FORK:END
  const showModeBlock = accessDisplay !== "hidden" || input.planModeUiEnabled;
  const modeHidden = showModeBlock && input.measuredHiddenBlockCount > 0;
  const hiddenBlockIds = modeHidden ? (["mode"] as const) : ([] as const);
  // An overflowed chip needs a home for Permissions only when the Plan toggle is not there to fill
  // the overflow menu; otherwise Permissions stay in the model picker.
  const overflowShowsPermissions =
    modeHidden && accessDisplay !== "hidden" && !input.planModeUiEnabled;
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    overflowShowsPermissions,
    /** With no visible chip, overflow menu or strip button holding it, the picker answers composer.mode. */
    pickerOwnsModeShortcut: modeHidden && !overflowShowsPermissions && !input.shownInStrip,
  };
}
