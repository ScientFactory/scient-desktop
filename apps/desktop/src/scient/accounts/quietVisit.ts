import type { Session } from "electron";

/** Asks a site for a page with the profile's session, so the session counts as used. No page opens. */
export async function quietVisit(session: Pick<Session, "fetch">, url: string) {
  const response = await session.fetch(url, { credentials: "include" });
  await response.body?.cancel();
  return { url: response.url, status: response.status };
}
