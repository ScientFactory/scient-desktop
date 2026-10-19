/**
 * Opens a provider's sign-in URL: through the desktop shell, or in a browser
 * popup that sends no referrer and is detected when the browser blocks it.
 */
import { ensureLocalApi } from "../../localApi";
import { isSafeProviderAuthorizationUrl } from "./providerConnectionPresentation";

/** A browser refused to open a window that no click of the user's asked for. */
export class SignInPageBlocked extends Error {}

export async function openProviderAuthorizationPage(url: string): Promise<void> {
  if (!isSafeProviderAuthorizationUrl(url)) {
    throw new Error("Scient refused an invalid or insecure provider sign-in link.");
  }
  if (window.desktopBridge) {
    await ensureLocalApi().shell.openExternal(url);
    return;
  }
  // Preview hosts distinguish a popup from a new-tab link. `noopener` would hide
  // whether the browser blocked it, so a blank window is opened, checked and cut
  // from its opener before it goes to the sign-in page.
  const opened = window.open("about:blank", "_blank", "popup");
  if (opened === null || opened.closed) throw new SignInPageBlocked();
  try {
    opened.opener = null;
    navigateWithoutReferrer(opened, url);
  } catch (error) {
    // Never leave a blank window behind; the failure offers the page again.
    try {
      opened.close();
    } catch {
      // Closing is best effort.
    }
    throw error;
  }
}

/**
 * Navigates a same-origin window without sending a referrer. A navigation this
 * window starts would carry its own URL as the referrer; a `noreferrer` link
 * followed inside the target sends none.
 */
export function navigateWithoutReferrer(target: Window, url: string): void {
  const link = target.document.createElement("a");
  link.href = url;
  link.rel = "noreferrer";
  (target.document.body ?? target.document.documentElement).append(link);
  link.click();
}
