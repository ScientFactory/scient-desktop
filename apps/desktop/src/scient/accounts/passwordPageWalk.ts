import { PASSWORD_PAGE_LINKS } from "@t3tools/shared/scientSetupPage";

/** A tab as the walk drives it: Electron's webContents, narrowed to what the walk uses. */
export interface WalkTab {
  getURL(): string;
  /** Runs `passwordPageScript` in the page's isolated world. */
  read(): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  /**
   * `did-start-navigation` covers what the `will-` events don't (the page's own `loadURL`-style
   * moves in place); its `preventDefault` stops the tab.
   */
  on(event: WalkEvent, listener: WalkListener): void;
  off(event: WalkEvent, listener: WalkListener): void;
}
type WalkEvent = "will-redirect" | "will-navigate" | "did-start-navigation";
type WalkListener = (event: { preventDefault(): void }, url: string) => void;
const WALK_EVENTS: ReadonlyArray<WalkEvent> = [
  "will-redirect",
  "will-navigate",
  "did-start-navigation",
];

/** Pages walked from the one Fix opened. */
const HOPS = 3;

const isLook = (
  value: unknown,
): value is { failed: boolean; form: boolean; links: ReadonlyArray<string> } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { failed?: unknown }).failed === "boolean" &&
  typeof (value as { form?: unknown }).form === "boolean" &&
  Array.isArray((value as { links?: unknown }).links) &&
  (value as { links: unknown[] }).links.length <= PASSWORD_PAGE_LINKS &&
  (value as { links: unknown[] }).links.every((link) => typeof link === "string");

/**
 * Takes the tab from a page with no change-password form along the site's own links (from an
 * error page, its home page first) to one that shows it, a few pages at most. Every navigation
 * while it walks, redirects and the page's own moves (in place included) too, stays on `origin`:
 * one that would leave is stopped, and the walk ends.
 */
export async function walkToPasswordPage(tab: WalkTab, origin: string) {
  let left = false;
  const stay: WalkListener = (event, url) => {
    if (URL.parse(url)?.origin === origin) return;
    left = true;
    event.preventDefault();
  };
  for (const name of WALK_EVENTS) tab.on(name, stay);
  try {
    const tried = new Set([tab.getURL()]);
    for (let hop = 0; ; hop++) {
      if (left || URL.parse(tab.getURL())?.origin !== origin) return false;
      const look = await tab.read();
      if (left || !isLook(look)) return false;
      if (look.form) return true;
      if (hop >= HOPS) return false;
      const home = `${origin}/`;
      const next = (look.failed ? [home, ...look.links] : [...look.links, home]).find(
        (href) => URL.parse(href)?.origin === origin && !tried.has(href),
      );
      if (next === undefined) return false;
      tried.add(next);
      // A navigation stopped for leaving the site rejects: the walk ends there.
      if (
        !(await tab.loadURL(next).then(
          () => true,
          () => false,
        ))
      )
        return false;
    }
  } finally {
    for (const name of WALK_EVENTS) tab.off(name, stay);
  }
}
