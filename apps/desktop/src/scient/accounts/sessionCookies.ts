import type { SessionCookie } from "@t3tools/contracts";
import {
  sessionCookieFromCdp,
  sessionCookieToCdpParam,
  type CdpCookie,
} from "@t3tools/shared/scientSessionCookies";
import * as Electron from "electron";

export type CdpSend = (method: string, params?: object) => Promise<unknown>;

/**
 * Runs CDP cookie commands in a session through a blank page that runs no script and is never
 * shown. Electron's own cookie API can't name a partition key, so partitioned cookies need CDP.
 * Only the Network domain acts on this page's session: Storage without a browser context acts on
 * Electron's default session, whatever page sends it.
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
    await send("Network.setCookies", {
      cookies: cookies.slice(start, start + BATCH).map(sessionCookieToCdpParam),
    });
}

/** Every cookie of the session's jar, partitioned ones included; values stay in the main process. */
export async function readJar(send: CdpSend) {
  const read = (await send("Network.getAllCookies")) as {
    readonly cookies: ReadonlyArray<CdpCookie>;
  };
  const cookies: SessionCookie[] = [];
  let unsupported = 0;
  for (const cookie of read.cookies) {
    const converted = sessionCookieFromCdp(cookie);
    if ("unsupported" in converted) unsupported += 1;
    else cookies.push(converted);
  }
  return { cookies, unsupported };
}

/** Removes exactly these cookies: name, domain, path and partition must all match. */
export async function deleteCookies(
  send: CdpSend,
  cookies: ReadonlyArray<Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">>,
) {
  for (const cookie of cookies)
    await send("Network.deleteCookies", {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    });
}
