import { SCIENT_SHARE_CONTENT_ORIGIN } from "./api.ts";

/**
 * The content shim on `share.scientusercontent.com`. Readers frame it with `sandbox="allow-scripts"`
 * (no same-origin), wait for `ready`, then post one `render` with the agent's HTML, which the shim
 * writes into itself. The HTML arrives with the shared render bootstrap already injected, so the
 * frame reports its height and link requests the same way chat's render frames do.
 */

export const CONTENT_FRAME_PATH = "/frame";
const READY = "scient-content-frame:ready";
const RENDER = "scient-content-frame:render";

export function contentFrameUrl(fragment = "", origin = SCIENT_SHARE_CONTENT_ORIGIN): string {
  return `${origin.replace(/\/+$/u, "")}${CONTENT_FRAME_PATH}${fragment}`;
}

export function isContentFrameReady(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === READY;
}

export function contentFrameRenderMessage(html: string) {
  return { type: RENDER, html } as const;
}

/** The shim page, served as is with a sandbox CSP that allows its inline script. */
export const CONTENT_FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>Shared content</title><script>(function(){if(window.parent===window)return;function r(e){var d=e.data;if(e.source!==window.parent||!d||d.type!==${JSON.stringify(RENDER)}||typeof d.html!=="string")return;window.removeEventListener("message",r);document.open();document.write(d.html);document.close();}window.addEventListener("message",r);window.parent.postMessage({type:${JSON.stringify(READY)}},"*");})();</script>`;
