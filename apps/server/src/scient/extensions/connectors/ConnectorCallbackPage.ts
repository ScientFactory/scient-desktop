import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import type { ConnectorSignInCallbackOutcome } from "../ExtensionsServices.ts";

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => escapes[char] ?? char);

export function renderCallbackPage(
  outcome: ConnectorSignInCallbackOutcome,
  nonce: string,
  icon?: string,
): string {
  const name = outcome.displayName ?? "Service";
  const title =
    outcome.outcome === "connected" ? `${name} is connected` : "Sign-in did not complete";
  const message =
    outcome.outcome === "connected" ? "Return to Scient to use your connection." : outcome.message;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)} · Scient</title>
<style nonce="${escape(nonce)}">
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202124;background:#f7f8f8;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(44rem 20rem at top,#10b98115,transparent)}main{width:100%;max-width:560px;padding:40px;border:1px solid #e2e5e5;border-radius:16px;background:#fff;box-shadow:0 24px 64px #00000012}.eyebrow{font-size:11px;font-weight:600;letter-spacing:.18em;color:#6b7280;margin:0 0 28px}h1{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.025em;margin:20px 0 10px}p{font-size:14px;line-height:1.6;color:#677078;margin:0}.logo{width:56px;height:56px;display:grid;place-items:center;border:1px solid #e2e5e5;border-radius:12px;font-size:24px;font-weight:600;background:#f7f8f8}img{width:40px;height:40px;object-fit:contain}a{display:inline-flex;align-items:center;justify-content:center;margin-top:28px;min-height:40px;padding:0 18px;border-radius:8px;background:#202124;color:#fff;font-size:14px;font-weight:500;text-decoration:none}a:focus-visible{outline:2px solid #10b981;outline-offset:4px}@media(prefers-color-scheme:dark){:root{background:#141617;color:#f1f3f4}main{background:#1c1f21;border-color:#34393c;box-shadow:0 24px 64px #0004}.logo{background:#25292b;border-color:#34393c}.eyebrow,p{color:#a0a8ae}a{background:#e5e9eb;color:#17191a}}@media(max-width:480px){main{padding:28px}h1{font-size:24px}}
</style></head><body><main><p class="eyebrow">SCIENT</p><div class="logo">${icon?.startsWith("data:image/") ? `<img src="${escape(icon)}" alt="">` : escape(name.slice(0, 2).toUpperCase())}</div><h1>${escape(title)}</h1><p>${escape(message)}</p><a id="return" href="${SCIENT_DESKTOP_IDENTITY.productionScheme}://app/settings/extensions/installed">Return to Scient</a></main>
<script nonce="${escape(nonce)}">document.getElementById('return').addEventListener('click',function(){window.close()})</script></body></html>`;
}
