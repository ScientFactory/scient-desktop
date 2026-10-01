/**
 * Resolves T3's configurable running-turn shortcut into Scient's explicit
 * server-side steer flag. `alternateRequested` means "the opposite of the
 * configured follow-up behavior"; it never creates a second client queue.
 */
export function resolveComposerSteerRequested(input: {
  readonly threadBusy: boolean;
  readonly followUpBehavior: "queue" | "steer";
  readonly alternateRequested: boolean;
}): boolean {
  if (!input.threadBusy) return false;
  return (input.followUpBehavior === "steer") !== input.alternateRequested;
}
