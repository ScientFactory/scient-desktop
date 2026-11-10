// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Bounded loopback listener for one browser sign-in.
// SCIENT-FORK:START clerk-sign-in-return
// @clerk/electron returns the browser to scient://app/, which leaves the sign-in tab frozen on the
// provider's last page. During a sign-in this listener gives the browser a local page to land on
// and hands the same callback to the bridge, so the tab says the sign-in finished.
import * as Electron from "electron";
import * as NodeHttp from "node:http";
import { SCIENT_SYMBOL_SVG } from "./scientSymbolSvg.ts";

/** @clerk/electron's IPC channel for the OAuth redirect URL (dist/esm/ipc-*.js, 0.0.44). */
export const CLERK_REDIRECT_URL_CHANNEL = "clerk:oauth-transport:get-redirect-url";
const CLERK_SIGN_IN_RETURN_PATH = "/clerk/callback";
const RELEASE_PORT = 34339;
const DEVELOPMENT_PORT = 34340;
// Matches @clerk/electron's own callback timeout.
const LISTEN_MS = 180_000;

const clerkSignInReturnPort = (isDevelopment: boolean) =>
  isDevelopment ? DEVELOPMENT_PORT : RELEASE_PORT;

export const clerkSignInReturnUrl = (isDevelopment: boolean) =>
  `http://127.0.0.1:${clerkSignInReturnPort(isDevelopment)}${CLERK_SIGN_IN_RETURN_PATH}`;

/** The deep link @clerk/electron waits for, carrying the browser's callback parameters. */
export const clerkDeepLinkForCallback = (requestUrl: string, scheme: string, host: string) => {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname !== CLERK_SIGN_IN_RETURN_PATH) return null;
  return `${scheme}://${host}/${url.search}`;
};

/** Browser navigations only: a page cannot load this as an image, script or frame. */
export const isTopLevelNavigation = (headers: NodeHttp.IncomingHttpHeaders) => {
  const destination = headers["sec-fetch-dest"];
  const mode = headers["sec-fetch-mode"];
  return (
    (destination === undefined || destination === "document") &&
    (mode === undefined || mode === "navigate")
  );
};

// Same card as Scient Agent's provider sign-in page (scient-agent packages/ai/.../oauth/oauth.html).
const RETURN_PAGE_STYLE = `
:root{--bg:#000;--card:#0b0b0d;--ink-1:#f4f4f5;--ink-2:#b4b4bb;--ink-3:#7a7a83;--line-1:rgb(255 255 255 / .07);--top-lit:rgb(255 255 255 / .22);--accent-a:#5ba2c2;--accent-b:#f8ac8b;--ok:#4ade80;--ok-soft:rgb(74 222 128 / .12);--bad:#f87171;--bad-soft:rgb(248 113 113 / .12);--glow-a:rgb(91 162 194 / .1);--glow-b:rgb(248 172 139 / .08);--shadow:0 30px 60px -20px rgb(0 0 0 / .8);--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--card:#fff;--ink-1:#111113;--ink-2:#4b4b52;--ink-3:#83838b;--line-1:rgb(0 0 0 / .08);--top-lit:rgb(0 0 0 / .04);--accent-a:#3b82a6;--accent-b:#e0835e;--ok:#16a34a;--ok-soft:rgb(22 163 74 / .1);--bad:#dc2626;--bad-soft:rgb(220 38 38 / .1);--glow-a:rgb(59 130 166 / .08);--glow-b:rgb(224 131 94 / .06);--shadow:0 20px 50px -24px rgb(0 0 0 / .18);color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:var(--sans);background:var(--bg);color:var(--ink-1);-webkit-font-smoothing:antialiased;overflow-x:clip}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 50vw 40vh at 38% 30%,var(--glow-a),transparent 70%),radial-gradient(ellipse 50vw 40vh at 64% 64%,var(--glow-b),transparent 70%)}
.container{position:relative;width:100%;max-width:400px;padding:2rem 2rem 1.75rem;background:var(--card);border:1px solid var(--line-1);border-radius:16px;box-shadow:var(--shadow);overflow:hidden;animation:rise .5s cubic-bezier(.16,1,.3,1) both}
.container::before{content:"";position:absolute;top:0;left:12%;right:12%;height:1px;background:linear-gradient(90deg,transparent,var(--top-lit),transparent)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
.brand{display:flex;align-items:center;gap:.6rem;margin-bottom:1.75rem}
.scient-mark{flex:none;display:block;width:24px;height:24px}
.scient-mark svg{display:block;width:100%;height:100%}
.wordmark{font-size:13px;font-weight:600;letter-spacing:-.01em}
.wordmark-sub{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.status{display:inline-flex;align-items:center;gap:.45rem;padding:.22rem .6rem .22rem .5rem;margin-bottom:1rem;border-radius:999px;font-size:12px;font-weight:500}
.success .status{color:var(--ok);background:var(--ok-soft)}
.error .status{color:var(--bad);background:var(--bad-soft)}
.status-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
h1{margin:0 0 .5rem;font-size:1.35rem;font-weight:600;letter-spacing:-.02em;line-height:1.25;text-wrap:balance}
p{margin:0 0 .25rem;font-size:.9rem;line-height:1.6;color:var(--ink-2)}
.timer{position:absolute;left:0;bottom:0;height:2px;width:100%;background:linear-gradient(135deg,var(--accent-a),var(--accent-b));transform-origin:left;transform:scaleX(0);animation:countdown 3s linear}
@keyframes countdown{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){.container,.timer{animation:none}}
`;

export function renderClerkSignInReturnPage(success: boolean) {
  const title = success ? "You're signed in" : "Sign-in didn't finish";
  const message = success
    ? "You can close this tab and go back to Scient."
    : "Go back to Scient and try again.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><title>${title} · Scient</title><style>${RETURN_PAGE_STYLE}</style></head>
<body><span class="glow" aria-hidden="true"></span>
<main class="container ${success ? "success" : "error"}">
<div class="brand"><span class="scient-mark" aria-hidden="true">${SCIENT_SYMBOL_SVG}</span><span class="wordmark">Scient</span><span class="wordmark-sub">sign-in</span></div>
<div class="status" role="status"><span class="status-dot" aria-hidden="true"></span>${success ? "Connected" : "Failed"}</div>
<h1>${title}</h1><p>${message}</p>${success ? '<span class="timer" aria-hidden="true"></span>' : ""}
</main></body></html>`;
}

/**
 * Point @clerk/electron's browser sign-in at a local return page. The bridge still matches and
 * resolves the scient://app/ callback; when the port is taken, sign-in uses the deep link as before.
 */
export function installClerkSignInReturn(input: {
  readonly scheme: string;
  readonly host: string;
  readonly isDevelopment: boolean;
}) {
  const ipcMain = Electron.ipcMain;
  const app = Electron.app;
  if (typeof ipcMain?.handle !== "function" || typeof app?.emit !== "function") return () => {};
  const deepLinkRedirect = `${input.scheme}://${input.host}/`;
  let server: NodeHttp.Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const current = server;
    server = null;
    if (!current) return;
    current.closeAllConnections();
    current.close();
  };

  const listen = () =>
    new Promise<boolean>((resolve) => {
      stop();
      const next = NodeHttp.createServer((request, response) => {
        const deepLink =
          request.method === "GET" && isTopLevelNavigation(request.headers)
            ? clerkDeepLinkForCallback(request.url ?? "/", input.scheme, input.host)
            : null;
        if (!deepLink || server !== next) {
          response.writeHead(404).end();
          return;
        }
        const failed = new URL(deepLink).searchParams.get("__clerk_status") === "failed";
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        );
        // One callback per sign-in: stop accepting, then close once the page is sent.
        if (timer) clearTimeout(timer);
        timer = null;
        server = null;
        next.close();
        response.on("close", () => next.closeAllConnections());
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" })
          .end(renderClerkSignInReturnPage(!failed));
        // The bridge ignores links when no sign-in is waiting.
        app.emit("open-url", { preventDefault: () => {} }, deepLink);
      });
      next.once("error", () => resolve(false));
      next.listen(clerkSignInReturnPort(input.isDevelopment), "127.0.0.1", () => {
        server = next;
        timer = setTimeout(stop, LISTEN_MS);
        timer.unref();
        resolve(true);
      });
    });

  ipcMain.removeHandler(CLERK_REDIRECT_URL_CHANNEL);
  ipcMain.handle(CLERK_REDIRECT_URL_CHANNEL, async (event) => {
    const { sender, senderFrame } = event;
    if (sender.getType() !== "window" || !senderFrame || senderFrame !== sender.mainFrame)
      throw new Error("Clerk: OAuth request did not originate from a window's main frame.");
    return (await listen()) ? clerkSignInReturnUrl(input.isDevelopment) : deepLinkRedirect;
  });
  return stop;
}
// SCIENT-FORK:END clerk-sign-in-return
