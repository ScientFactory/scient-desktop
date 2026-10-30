import type { BrowserWindow, WebContents } from "electron";

/**
 * The app windows that host browser preview guests, and the window hosting each tab's guest. A
 * tab's host is recorded when its guest registers, because a guest can be destroyed before its
 * window's `closed` event fires.
 */
export class PreviewHostWindows {
  readonly #windows = new Set<BrowserWindow>();
  readonly #tabHosts = new Map<string, BrowserWindow>();

  get windows(): ReadonlyArray<BrowserWindow> {
    return [...this.#windows];
  }

  has(window: BrowserWindow): boolean {
    return this.#windows.has(window);
  }

  add(window: BrowserWindow): void {
    this.#windows.add(window);
  }

  /**
   * Forgets a closed window. Returns the tabs it hosted while another live window stays open,
   * `"last"` once none does, or `undefined` when the window was already forgotten.
   */
  close(window: BrowserWindow): ReadonlySet<string> | "last" | undefined {
    if (!this.#windows.delete(window)) return undefined;
    if (![...this.#windows].some((other) => !other.isDestroyed())) {
      this.#windows.clear();
      return "last";
    }
    const hostedTabIds = new Set<string>();
    for (const [tabId, host] of this.#tabHosts) {
      if (host === window) hostedTabIds.add(tabId);
    }
    return hostedTabIds;
  }

  /** The live registered window whose renderer embeds `guest`. */
  hostOf(guest: WebContents | null | undefined): BrowserWindow | undefined {
    if (!guest || guest.isDestroyed()) return undefined;
    return [...this.#windows].find(
      (window) => !window.isDestroyed() && guest.hostWebContents === window.webContents,
    );
  }

  setTabHost(tabId: string, window: BrowserWindow | undefined): void {
    if (window === undefined) this.#tabHosts.delete(tabId);
    else this.#tabHosts.set(tabId, window);
  }

  forgetTab(tabId: string): void {
    this.#tabHosts.delete(tabId);
  }

  /** A tab registered before any app window has no host to close. */
  isTabHostClosed(tabId: string): boolean {
    const host = this.#tabHosts.get(tabId);
    return host !== undefined && !this.#windows.has(host);
  }
}
