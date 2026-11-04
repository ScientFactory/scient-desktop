import type { CdpSend } from "@t3tools/shared/scientSessionCookies";
import * as Electron from "electron";

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
