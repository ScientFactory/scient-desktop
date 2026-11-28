/**
 * In-memory thumbnails for browser-tab hover cards. A thumbnail belongs to
 * one tab at one page key (address plus navigation epoch, composed by the
 * caller), so navigation invalidates it; nothing persists.
 */
import { TAB_THUMBNAIL_DATA_URL_MAX_LENGTH } from "@t3tools/contracts";

const BROWSER_TAB_THUMBNAIL_MAX_ENTRIES = 24;

export type TabThumbnailCapture = () => Promise<string | null>;

export interface TabThumbnailCache {
  /** The cached picture for this tab at this page key, or null. A hit counts as used. */
  get: (tabId: string, pageKey: string) => string | null;
  /**
   * The cached picture, or one capture shared by concurrent callers. A
   * completion is cached only while it is still the tab's pending request
   * for its page key; failures are not cached.
   */
  request: (tabId: string, pageKey: string, capture: TabThumbnailCapture) => Promise<string | null>;
  /** Forget a tab's picture and retire any capture still in flight for it. */
  invalidate: (tabId: string) => void;
}

/** Only small raster data URLs are worth keeping; anything else is treated as no thumbnail. */
export function isUsableThumbnailDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TAB_THUMBNAIL_DATA_URL_MAX_LENGTH &&
    value.startsWith("data:image/")
  );
}

export function createTabThumbnailCache(
  maxEntries = BROWSER_TAB_THUMBNAIL_MAX_ENTRIES,
): TabThumbnailCache {
  const entries = new Map<string, { pageKey: string; dataUrl: string }>();
  const pending = new Map<string, Promise<string | null>>();
  const latestPageKey = new Map<string, string>();

  const get = (tabId: string, pageKey: string): string | null => {
    const entry = entries.get(tabId);
    if (!entry) return null;
    if (entry.pageKey !== pageKey) {
      entries.delete(tabId);
      return null;
    }
    // Refresh recency so eviction drops the least recently shown pictures.
    entries.delete(tabId);
    entries.set(tabId, entry);
    return entry.dataUrl;
  };

  const request = async (
    tabId: string,
    pageKey: string,
    capture: TabThumbnailCapture,
  ): Promise<string | null> => {
    latestPageKey.set(tabId, pageKey);
    const cached = get(tabId, pageKey);
    if (cached !== null) return cached;
    const key = `${tabId}\0${pageKey}`;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const { promise: attempt, resolve } = Promise.withResolvers<string | null>();
    pending.set(key, attempt);
    void (async () => {
      let result: string | null;
      try {
        const captured = await capture();
        result = isUsableThumbnailDataUrl(captured) ? captured : null;
        // Retired by invalidate() or superseded by a newer page: the caller
        // awaiting this capture still gets its picture, but it is not cached.
        if (
          result !== null &&
          pending.get(key) === attempt &&
          latestPageKey.get(tabId) === pageKey
        ) {
          entries.delete(tabId);
          entries.set(tabId, { pageKey, dataUrl: result });
          while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
          }
        }
      } catch {
        result = null;
      }
      if (pending.get(key) === attempt) pending.delete(key);
      resolve(result);
    })();
    return attempt;
  };

  const invalidate = (tabId: string): void => {
    entries.delete(tabId);
    latestPageKey.delete(tabId);
    for (const key of pending.keys()) {
      if (key.startsWith(`${tabId}\0`)) pending.delete(key);
    }
  };

  return { get, request, invalidate };
}

/** The one cache the tab strip shares. */
export const tabThumbnailCache = createTabThumbnailCache();
