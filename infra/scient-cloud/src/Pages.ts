import { ShareId } from "@scientfactory/scient-cloud/api";
import { CONTENT_FRAME_HTML } from "@scientfactory/scient-cloud/content-frame";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CloudConfig, PageAssets, Shares, type CloudSettings } from "./Services.ts";

export const SHARE_APP_PREFIX = "/s/_app/";
const isShareId = Schema.is(ShareId);

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const pageHeaders = (config: CloudSettings, indexable: boolean) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  ...(indexable ? {} : { "x-robots-tag": "noindex, nofollow" }),
  // Rendered math and diagrams set inline styles; scripts come only from this origin. Code
  // highlighting compiles WebAssembly, which needs 'wasm-unsafe-eval' (not JavaScript eval).
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${config.apiOrigin}`,
    `frame-src ${config.contentOrigin}`,
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
});

/** A one-message page in the share page's look: same header, type and colors, light and dark. */
const messagePage = (title: string, heading: string, text: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<title>${title} · Scient</title>
<style>
:root{--bg:oklch(99.2% 0 0);--fg:#18181b;--muted:#71717a;--border:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f1f3f7;--muted:#a3a3a3;--border:rgb(255 255 255/8%)}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
header{border-bottom:1px solid var(--border)}
header div,main{max-width:48rem;margin:0 auto;padding:12px 16px}
header div{font-size:16px;font-weight:500}
main{padding-top:64px;text-align:center}
h1{margin:0 0 8px;font-size:16px;font-weight:500}
p{margin:0 auto;max-width:28rem;color:var(--muted);overflow-wrap:anywhere}
</style></head>
<body><header><div>Scient</div></header>
<main><h1>${heading}</h1><p>${text}</p></main></body>
</html>`;

const FALLBACK_SHELL = messagePage(
  "Shared conversation",
  "Shared conversation",
  "This page is being updated. Try again shortly.",
);

const ENDED = messagePage(
  "Link ended",
  "This link has ended",
  "The person who shared it may have stopped sharing it, or it expired.",
);

/** `<head>` additions: robots and, only for public unencrypted links, the sender's card. */
const headTags = (
  config: CloudSettings,
  id: string,
  page: {
    readonly indexable: boolean;
    readonly card: { readonly title: string; readonly description?: string } | null;
  },
) => {
  const tags = [
    `<meta name="referrer" content="no-referrer">`,
    `<meta name="scient-cloud-api" content="${escapeHtml(config.apiOrigin)}">`,
    `<meta name="scient-share-content" content="${escapeHtml(config.contentOrigin)}">`,
  ];
  const hostedApp = config.appOrigins.find((origin) => origin.startsWith("https://"));
  if (hostedApp) tags.push(`<meta name="scient-hosted-app" content="${escapeHtml(hostedApp)}">`);
  if (!page.indexable) tags.push(`<meta name="robots" content="noindex, nofollow">`);
  if (page.card) {
    const title = escapeHtml(page.card.title);
    tags.push(
      `<meta property="og:type" content="article">`,
      `<meta property="og:site_name" content="Scient">`,
      `<meta property="og:title" content="${title}">`,
      `<meta property="og:url" content="${escapeHtml(`${config.pageOrigin}/s/${id}`)}">`,
      `<meta name="twitter:card" content="summary">`,
    );
    if (page.card.description) {
      const description = escapeHtml(page.card.description);
      tags.push(
        `<meta property="og:description" content="${description}">`,
        `<meta name="description" content="${description}">`,
      );
    }
  }
  return tags.join("\n");
};

const assetResponse = (response: Response) => {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(response.body, { status: response.status, headers });
};

/** `GET /s/:id` serves the share app's shell; `GET /s/_app/*` its built files. */
export const sharePage = Effect.fn("Pages.sharePage")(function* (pathname: string) {
  const assets = yield* PageAssets;
  if (pathname.startsWith(SHARE_APP_PREFIX)) {
    const asset = yield* assets.fetch(pathname.slice(SHARE_APP_PREFIX.length));
    return asset === undefined || asset.status === 404
      ? new Response("Not found", { status: 404, headers: { "x-robots-tag": "noindex" } })
      : assetResponse(asset);
  }
  const config = yield* CloudConfig;
  const id = pathname.slice("/s/".length);
  if (!isShareId(id)) {
    return new Response(ENDED, { status: 404, headers: pageHeaders(config, false) });
  }
  const page = yield* (yield* Shares)
    .get(id)
    .page(yield* Clock.currentTimeMillis)
    .pipe(Effect.option);
  if (page._tag === "None") {
    return new Response(ENDED, { status: 404, headers: pageHeaders(config, false) });
  }
  const shell = yield* assets.fetch("index.html");
  const html = shell?.ok ? yield* Effect.promise(() => shell.text()) : FALLBACK_SHELL;
  const body = html.replace(/<head>/iu, `<head>\n${headTags(config, id, page.value)}`);
  return new Response(body, { status: 200, headers: pageHeaders(config, page.value.indexable) });
});

/** The untrusted-content origin. Its page holds no data; readers frame it with `sandbox="allow-scripts"`. */
export const contentFrame = (config: CloudSettings) => {
  const ancestors = [config.pageOrigin, ...config.appOrigins].join(" ");
  const local = config.allowLocalhostOrigins ? " http://localhost:* http://127.0.0.1:*" : "";
  return new Response(CONTENT_FRAME_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      // The posted HTML runs in the nested srcdoc frame, which inherits this policy; nothing on
      // this origin is worth reaching, so its scripts may run freely.
      "content-security-policy": [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' https:",
        "style-src 'unsafe-inline' https:",
        "img-src data: blob: https:",
        "font-src data: https:",
        "media-src data: blob:",
        "frame-src 'self'",
        "connect-src 'none'",
        // Isolated even if a page frames it without the sandbox attribute.
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${ancestors}${local}`,
      ].join("; "),
    },
  });
};
