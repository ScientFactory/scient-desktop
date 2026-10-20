import { isElectron } from "~/env";

/**
 * Whether "update available" toasts announce provider updates. In the desktop app the sidebar's
 * update circle offers them instead; the browser client keeps its toasts. Progress and results
 * still report wherever an update runs.
 */
export function offersProviderUpdateToasts(): boolean {
  return !isElectron;
}
