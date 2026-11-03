import type { SessionCookie } from "@t3tools/contracts";
import { sessionCookieToCdpParam } from "@t3tools/shared/scientSessionCookies";
import * as Electron from "electron";

export type CdpSend = (method: string, params?: object) => Promise<unknown>;

/**
 * Runs CDP cookie commands in a session through a blank page that runs no script and is never
 * shown. Electron's own cookie API can't name a partition key, so partitioned cookies need CDP.
 */
export async function withCookieDebugger<A>(
  session: Electron.Session,
  run: (send: CdpSend) => Promise<A>,
): Promise<A> {
  const view = new Electron.WebContentsView({
    webPreferences: { session, sandbox: true, javascript: false },
  });
  const contents = view.webContents;
  try {
    await contents.loadURL("about:blank");
    contents.debugger.attach("1.3");
    return await run((method, params) => contents.debugger.sendCommand(method, params));
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
    contents.close();
  }
}

const BATCH = 100;

export async function setCookies(send: CdpSend, cookies: ReadonlyArray<SessionCookie>) {
  for (let start = 0; start < cookies.length; start += BATCH)
    await send("Storage.setCookies", {
      cookies: cookies.slice(start, start + BATCH).map(sessionCookieToCdpParam),
    });
}
