import { ensureLocalApi } from "../../localApi";

export type SignInOpening =
  /** A sign-in page is open in the user's browser. */
  | { readonly outcome: "opened" }
  /** The page could not be opened for the user; offer `url` as a link they click. */
  | { readonly outcome: "blocked"; readonly url: string }
  /** No URL came back; the caller reports why. */
  | { readonly outcome: "not-started" };

/**
 * Browsers block tabs opened after await, so reserve before requesting the URL and close unused
 * reservations. Return a fallback link if the reservation or desktop launch fails.
 */
export async function openAuthorizationPage(
  requestUrl: () => Promise<string | null>,
): Promise<SignInOpening> {
  const reserved = window.desktopBridge ? null : window.open("", "_blank");
  if (reserved) reserved.opener = null;
  let url: string | null = null;
  try {
    url = await requestUrl();
  } finally {
    if (url === null) reserved?.close();
  }
  if (url === null) return { outcome: "not-started" };
  if (!window.desktopBridge) {
    if (reserved === null || reserved.closed) return { outcome: "blocked", url };
    reserved.location.href = url;
    return { outcome: "opened" };
  }
  try {
    await ensureLocalApi().shell.openExternal(url);
    return { outcome: "opened" };
  } catch {
    return { outcome: "blocked", url };
  }
}
