import * as Schema from "effect/Schema";

export const AccountCookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  expires: Schema.Number,
});
export const AccountCookies = Schema.Array(AccountCookie);
export type AccountCookie = typeof AccountCookie.Type;

export function netscapeCookieJar(cookies: ReadonlyArray<AccountCookie>) {
  const safe = (value: string) => {
    if (/[\r\n\t\0]/.test(value))
      throw new Error("The browser session contains an unsupported cookie.");
    return value;
  };
  return (
    "# Netscape HTTP Cookie File\n" +
    cookies
      .map((cookie) =>
        [
          `${cookie.httpOnly ? "#HttpOnly_" : ""}${safe(cookie.domain)}`,
          cookie.domain.startsWith(".") ? "TRUE" : "FALSE",
          safe(cookie.path),
          cookie.secure ? "TRUE" : "FALSE",
          cookie.expires > 0 ? String(Math.floor(cookie.expires)) : "0",
          safe(cookie.name),
          safe(cookie.value),
        ].join("\t"),
      )
      .join("\n") +
    "\n"
  );
}
