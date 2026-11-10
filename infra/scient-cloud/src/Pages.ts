import { ShareId } from "@scientfactory/scient-cloud/api";
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
  // Rendered math and diagrams set inline styles; scripts come only from this origin.
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
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

const FALLBACK_SHELL = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared conversation · Scient</title></head>
<body><main><h1>Shared conversation</h1><p>This page is being updated. Try again shortly.</p></main></body>
</html>`;

const ENDED = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Link ended · Scient</title></head>
<body><main><h1>This link has ended</h1><p>The person who shared it may have stopped sharing it, or it expired.</p></main></body>
</html>`;

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

/**
 * The untrusted-content origin. Its page holds no data; it renders HTML a parent posts to it
 * in a nested sandboxed frame. Parents embed it with `sandbox="allow-scripts"`.
 */
const FRAME_SCRIPT = `
const frame = document.getElementById("content");
addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "scient-render" || typeof data.html !== "string") return;
  frame.srcdoc = data.html;
});
new ResizeObserver(() => {
  parent.postMessage({ type: "scient-frame-size", height: document.documentElement.scrollHeight }, "*");
}).observe(document.documentElement);
parent.postMessage({ type: "scient-frame-ready" }, "*");
`;

const FRAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body>
<iframe id="content" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
<script>${FRAME_SCRIPT}</script>
</body></html>`;

export const contentFrame = (config: CloudSettings) => {
  const ancestors = [config.pageOrigin, ...config.appOrigins].join(" ");
  const local = config.allowLocalhostOrigins ? " http://localhost:* http://127.0.0.1:*" : "";
  return new Response(FRAME_HTML, {
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
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${ancestors}${local}`,
      ].join("; "),
    },
  });
};
