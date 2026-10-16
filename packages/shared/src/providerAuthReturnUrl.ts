import { isLoopbackHost } from "./preview.ts";
// SCIENT-FORK:START — Scient registers its own desktop schemes and operates no hosted web client.
import { SCIENT_DESKTOP_IDENTITY } from "./scientDesktopIdentity.ts";

const DESKTOP_RETURN_PROTOCOLS = [
  `${SCIENT_DESKTOP_IDENTITY.productionScheme}:`,
  `${SCIENT_DESKTOP_IDENTITY.developmentScheme}:`,
];
// SCIENT-FORK:END

/** Only return to a local client, never an arbitrary OAuth-supplied URL. */
export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    // SCIENT-FORK:START — the desktop renderer runs on Scient's scheme; T3's hosted origin never receives codes.
    const desktop = DESKTOP_RETURN_PROTOCOLS.includes(url.protocol) && url.host === "app";
    const web = ["http:", "https:"].includes(url.protocol) && isLoopbackHost(url.hostname);
    // SCIENT-FORK:END
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
