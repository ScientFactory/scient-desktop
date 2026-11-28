import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isLoopbackHostname } from "../../environments/primary/target";

/**
 * Whether the Scient server behind `target` runs on the computer showing this page, so WhatsApp
 * sees the link come from the person's own network; null while a saved connection's address is
 * not known yet. Desktop's own servers (primary and WSL) always do; otherwise only a direct
 * connection to a loopback address does. Relay and SSH connections reach another machine.
 */
export function runsOnThisComputer(
  target: ConnectionTarget,
  /** The saved connection's address as this client reaches it, once known. */
  connectionHttpBaseUrl: string | null,
  isDesktop: boolean,
): boolean | null {
  if (
    isDesktop &&
    (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
  )
    return true;
  const httpBaseUrl =
    target._tag === "PrimaryConnectionTarget"
      ? target.httpBaseUrl
      : target._tag === "BearerConnectionTarget"
        ? connectionHttpBaseUrl
        : undefined;
  if (httpBaseUrl === undefined) return false;
  if (httpBaseUrl === null) return null;
  return URL.canParse(httpBaseUrl) && isLoopbackHostname(new URL(httpBaseUrl).hostname);
}
