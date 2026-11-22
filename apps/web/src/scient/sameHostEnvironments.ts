/**
 * Environments whose server runs on this computer, as only the desktop app can prove: its own
 * managed backend, or the background service sharing its home. A browser has none, since the
 * server behind its page origin may be another machine.
 */
export function sameHostEnvironmentIds(input: {
  readonly desktopApp: boolean;
  readonly desktopManagedPrimary: boolean;
  readonly primaryEnvironmentId: string | null;
  readonly hostEnvironmentId: string | null;
}): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!input.desktopApp) return ids;
  if (input.desktopManagedPrimary && input.primaryEnvironmentId !== null) {
    ids.add(input.primaryEnvironmentId);
  }
  if (input.hostEnvironmentId !== null) ids.add(input.hostEnvironmentId);
  return ids;
}
