import { SessionCookie } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AccountCookies = Schema.Array(SessionCookie);

/**
 * A Netscape cookie file for curl and Python. The format has no partition, so partitioned
 * cookies are left out rather than widened; host-only cookies say so in the subdomain flag.
 */
export function netscapeCookieJar(cookies: ReadonlyArray<SessionCookie>) {
  const safe = (value: string) => {
    if (/[\r\n\t\0]/.test(value))
      throw new Error("The browser session contains an unsupported cookie.");
    return value;
  };
  return (
    "# Netscape HTTP Cookie File\n" +
    cookies
      .filter((cookie) => !cookie.partitionKey)
      .map((cookie) =>
        [
          `${cookie.httpOnly ? "#HttpOnly_" : ""}${safe(cookie.domain)}`,
          cookie.hostOnly ? "FALSE" : "TRUE",
          safe(cookie.path),
          cookie.secure ? "TRUE" : "FALSE",
          cookie.expires === undefined ? "0" : String(Math.floor(cookie.expires)),
          safe(cookie.name),
          safe(cookie.value),
        ].join("\t"),
      )
      .join("\n") +
    "\n"
  );
}
