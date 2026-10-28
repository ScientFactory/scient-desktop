// SCIENT-FORK:START — the mode is fixed for a window lifetime; changes relaunch the app.
const disabledByWindow = new WeakMap<Window, boolean>();
// SCIENT-FORK:END

export function isLocalEnvironmentDisabled(): boolean {
  // SCIENT-FORK:START — read once per window instead of per call.
  const cached = disabledByWindow.get(window);
  if (cached !== undefined) return cached;
  const disabled = window.desktopBridge?.getLocalEnvironmentEnabled() === false;
  disabledByWindow.set(window, disabled);
  return disabled;
  // SCIENT-FORK:END
}
