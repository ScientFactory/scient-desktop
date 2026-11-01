import type { DesktopGoogleSession } from "@t3tools/contracts";
import type { Session } from "electron";

/** The list Chrome itself reads: every Google account this browser knows, and which still work. */
const LIST_ACCOUNTS_URL =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=Scient&json=standard";
const EMAIL_FIELD = 3;
const VALID_FIELD = 9;

export function parseGoogleSessions(text: string): ReadonlyArray<DesktopGoogleSession> | null {
  try {
    const [, rows] = JSON.parse(text) as [unknown, unknown];
    if (!Array.isArray(rows)) return null;
    return rows.flatMap((row: unknown) => {
      const email = Array.isArray(row) ? row[EMAIL_FIELD] : undefined;
      return typeof email === "string" && email.includes("@")
        ? [{ email, valid: (row as ReadonlyArray<unknown>)[VALID_FIELD] === 1 }]
        : [];
    });
  } catch {
    return null;
  }
}

/** Asks Google, with no page opened. A profile that has never seen Google isn't asked. */
export async function readGoogleSessions(session: Pick<Session, "cookies" | "fetch">) {
  if ((await session.cookies.get({ domain: "accounts.google.com" })).length === 0) return [];
  const response = await session.fetch(LIST_ACCOUNTS_URL, {
    method: "POST",
    credentials: "include",
  });
  return response.ok ? parseGoogleSessions(await response.text()) : null;
}
