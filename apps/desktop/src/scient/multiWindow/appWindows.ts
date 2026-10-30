import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import type * as ElectronWindow from "../../electron/ElectronWindow.ts";

const CASCADE_OFFSET = 28;
const MAX_ROUTE_LENGTH = 2_048;

type Bounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

/** The app window whose renderer sent an IPC message; guest webviews and other windows have none. */
export const appWindowForSender = (
  electronWindow: ElectronWindow.ElectronWindow["Service"],
  senderId: number | undefined,
): Effect.Effect<Option.Option<Electron.BrowserWindow>> =>
  senderId === undefined
    ? Effect.succeedNone
    : Effect.map(electronWindow.appWindows, (windows) =>
        Option.fromNullishOr(
          windows.find(
            (window) => !window.webContents.isDestroyed() && window.webContents.id === senderId,
          ),
        ),
      );

/** An in-app hash route such as `/<environmentId>/<threadId>`; anything else opens the default route. */
export function parseAppWindowRoute(route: string | undefined): Option.Option<string> {
  if (route === undefined || route.length === 0 || route.length > MAX_ROUTE_LENGTH) {
    return Option.none();
  }
  if (!route.startsWith("/") || route.startsWith("//") || /[\s#\\]/.test(route)) {
    return Option.none();
  }
  return Option.some(route);
}

export function appWindowUrl(applicationUrl: string, route: Option.Option<string>): string {
  if (Option.isNone(route)) return applicationUrl;
  const url = new URL(applicationUrl);
  url.hash = route.value;
  return url.href;
}

/** Offsets a new window from the one it opens beside, wrapping to the work area's corner at its edge. */
export function cascadeWindowBounds(source: Bounds, workAreas: readonly Bounds[]): Bounds {
  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  const area =
    workAreas.find(
      (candidate) =>
        centerX >= candidate.x &&
        centerX < candidate.x + candidate.width &&
        centerY >= candidate.y &&
        centerY < candidate.y + candidate.height,
    ) ?? workAreas[0];
  const next = {
    x: source.x + CASCADE_OFFSET,
    y: source.y + CASCADE_OFFSET,
    width: source.width,
    height: source.height,
  };
  if (area === undefined) return next;
  const width = Math.min(source.width, area.width);
  const height = Math.min(source.height, area.height);
  const fits =
    next.x >= area.x &&
    next.y >= area.y &&
    next.x + width <= area.x + area.width &&
    next.y + height <= area.y + area.height;
  return fits ? { ...next, width, height } : { x: area.x, y: area.y, width, height };
}

/**
 * App windows whose renderers declared themselves ready for main-process requests. A window leaves
 * the set when its renderer reports not ready, navigates to another document, crashes, or is destroyed.
 */
export class ReadyRenderers {
  // Keyed by window: a destroyed BrowserWindow throws on `webContents`, and its contents'
  // `destroyed` event fires after that.
  readonly #windows = new Map<
    Electron.BrowserWindow,
    { readonly webContents: Electron.WebContents; readonly detach: () => void }
  >();
  readonly #onRemove: (window: Electron.BrowserWindow) => void;

  constructor(onRemove: (window: Electron.BrowserWindow) => void = () => undefined) {
    this.#onRemove = onRemove;
  }

  get size(): number {
    return this.#windows.size;
  }

  /** `window` must be live; callers take it from the app window registry. */
  add(window: Electron.BrowserWindow): void {
    if (this.#windows.has(window)) return;
    const webContents = window.webContents;
    if (webContents.isDestroyed()) return;
    const remove = () => this.delete(window);
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) remove();
    };
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("render-process-gone", remove);
    webContents.once("destroyed", remove);
    this.#windows.set(window, {
      webContents,
      detach: () => {
        webContents.removeListener("did-start-navigation", onNavigation);
        webContents.removeListener("render-process-gone", remove);
        webContents.removeListener("destroyed", remove);
      },
    });
  }

  delete(window: Electron.BrowserWindow): void {
    const entry = this.#windows.get(window);
    if (entry === undefined) return;
    this.#windows.delete(window);
    entry.detach();
    this.#onRemove(window);
  }

  clear(): void {
    for (const window of this.#windows.keys()) this.delete(window);
  }

  /**
   * The first ready window among `candidates`, which must be live app windows in order of
   * preference. A window can stay listed briefly after it is destroyed, so only candidates count.
   */
  pick(candidates: ReadonlyArray<Electron.BrowserWindow>): Option.Option<Electron.BrowserWindow> {
    return Option.fromNullishOr(
      candidates.find((window) => {
        const entry = this.#windows.get(window);
        return entry !== undefined && !entry.webContents.isDestroyed();
      }),
    );
  }
}
