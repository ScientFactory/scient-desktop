export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
// The header reserves a fixed --workspace-titlebar-content-left before the
// wordmark starts (traffic lights + sidebar toggle + gap = 130px on macOS).
// The Scient symbol and wordmark need ~78px more, so 13rem left the brand
// overflowing the sidebar's right edge at the narrowest legal width. 13.5rem
// clears that with a small margin; the brand also stays shrinkable, so the
// wordmark truncates rather than spilling if the inset ever grows.
export const THREAD_SIDEBAR_MIN_WIDTH = 13.5 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
