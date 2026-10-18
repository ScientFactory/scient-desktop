import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useEnvironments } from "../../state/environments";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether the environment's server runs on the device showing this window.
 * Browser sign-ins that return to `127.0.0.1` only complete on that device; on
 * any other, the user pastes the return URL into the setup card instead.
 */
function isConnectionTargetOnThisDevice(target: ConnectionTarget): boolean {
  if (isDesktopLocalConnectionTarget(target)) return true;
  if (target._tag !== "PrimaryConnectionTarget") return false;
  // The desktop app's primary environment is its own backend; a browser tab's is
  // whatever served it.
  return window.desktopBridge !== undefined || LOOPBACK_HOSTS.has(window.location.hostname);
}

/** {@link isConnectionTargetOnThisDevice} for an environment; false while it is unknown. */
export function useEnvironmentIsOnThisDevice(environmentId: EnvironmentId): boolean {
  const { environments } = useEnvironments();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  return environment !== undefined && isConnectionTargetOnThisDevice(environment.entry.target);
}
