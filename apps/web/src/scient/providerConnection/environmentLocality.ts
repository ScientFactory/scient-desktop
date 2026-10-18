import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { useEnvironments } from "../../state/environments";

/**
 * Whether the environment's server runs on the device showing this window.
 * Browser sign-ins that return to `127.0.0.1` only complete on that device; on
 * any other, the user pastes the return URL into the setup card instead.
 */
export function isConnectionTargetOnThisDevice(target: ConnectionTarget): boolean {
  // Only the desktop app knows its own backends. A browser tab on localhost can
  // be reaching a remote server through a tunnel, so it never counts.
  if (window.desktopBridge === undefined || isLocalEnvironmentDisabled()) return false;
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

/**
 * {@link isConnectionTargetOnThisDevice} for an environment; false when it is
 * unknown, so the caller shows what the remote case needs.
 */
export function useEnvironmentIsOnThisDevice(environmentId: EnvironmentId): boolean {
  const { environments } = useEnvironments();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  return environment !== undefined && isConnectionTargetOnThisDevice(environment.entry.target);
}
