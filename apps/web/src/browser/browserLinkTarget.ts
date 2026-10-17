import type { BrowserLinkTarget, ScopedThreadRef } from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { isPreviewAvailableFor } from "./previewRuntime";

export interface ResolveLinkTargetInput {
  readonly url: string;
  readonly event: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly button?: number | undefined;
  };
  readonly preference: BrowserLinkTarget;
  readonly canOpenInApp: boolean;
}

/**
 * The target a click resolves to. "app" only comes back when the preference
 * asks for it, the runtime can honour it, the URL is one the in-app browser
 * can load and is not a sign-in, and the click carried no modifier — the
 * modifier is the one-gesture way out when the default is in-app, mirroring
 * how change-request links already treat it.
 */
export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  if (input.event.metaKey || input.event.ctrlKey || input.event.button === 1) return "system";
  if (input.preference !== "app") return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  if (isSignInUrl(input.url)) return "system";
  return "app";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A page that signs the user in to an account, or the local page such a
 * sign-in returns to. It always opens in the system browser, whatever the
 * preference: that is where the user's accounts, passwords and passkeys are,
 * and its address bar shows whose page is asking.
 *
 * Recognized by what OAuth itself puts in the URL (a client asking for a
 * code, or a PKCE challenge), and by the two local pages an agent's sign-in
 * helper serves on a loopback address: `/launch`, a short link that redirects
 * to the provider, and `/callback` carrying the provider's answer.
 */
export function isSignInUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const query = parsed.searchParams;
  if (query.has("code_challenge")) return true;
  if (query.has("client_id") && (query.has("response_type") || query.has("redirect_uri"))) {
    return true;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "/launch") return true;
  return (
    path.endsWith("/callback") && query.has("state") && (query.has("code") || query.has("error"))
  );
}

/**
 * Only http(s) can load in the in-app browser. Anything else — mailto:,
 * vscode://, a bare fragment — belongs to the shell whatever the preference.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Before hydration the snapshot is the schema default ("system"), so a link clicked in the
 * first moments after launch would ignore a persisted "app" — opening is asynchronous anyway,
 * so waiting costs nothing the user can see.
 */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  return threadRef != null && isPreviewAvailableFor(threadRef.environmentId);
}
