import {
  AuthPreviewOperateScope,
  type BrowserLinkTarget,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readEnvironmentScope } from "~/state/session";
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
 * Modifiers always escape the in-app browser default for this gesture.
 * In-app routing also requires runtime support, a loadable URL and no sign-in.
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
 * Sign-in URLs stay in the system browser, where accounts/passkeys and a visible origin already exist.
 * OAuth code/PKCE parameters and loopback /launch or /callback identify provider sign-in flows.
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

/** Before hydration, the default "system" would ignore a saved "app" link target. */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  return (
    threadRef != null &&
    readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope) &&
    isPreviewAvailableFor(threadRef.environmentId)
  );
}
