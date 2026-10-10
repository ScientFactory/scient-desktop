/** The local backend mode is fixed for a window lifetime; changes relaunch the app. */
const disabledByWindow = new WeakMap<Window, boolean>();

/** Browsers and desktop bridges predating the flag retain a local environment. */
export function isLocalEnvironmentDisabled(): boolean {
  const cached = disabledByWindow.get(window);
  if (cached !== undefined) return cached;
  const disabled = window.desktopBridge?.getLocalEnvironmentEnabled?.() === false;
  disabledByWindow.set(window, disabled);
  return disabled;
}
