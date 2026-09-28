/**
 * A Mermaid renderer that cannot fetch anything, shared by chat and Word export.
 *
 * Mermaid draws into a live document to measure text, and in strict mode it
 * still creates what a diagram asks for (an `<img>` in a label, a node's
 * image shape, a sequence actor's icon, CSS `url()`). Here it runs inside a
 * hidden frame whose Content Security Policy allows only Mermaid's own
 * script, inline styles, and `data:`/`blob:` images and fonts, so the browser
 * refuses every load a diagram names before any request is made. Each
 * refusal is counted so Word can fall back; chat strips what the SVG still
 * names (`svgExternalResources.ts`) and says what it left out.
 *
 * The frame loads Mermaid's self-contained build and draws with the settings
 * chat uses. It is same-origin so Scient can call into it; nothing inside it
 * runs Scient code.
 */
import type { MermaidConfig } from "mermaid";
import mermaidScriptUrl from "mermaid/dist/mermaid.min.js?url";

import { fetchesInCss } from "./cssResources";
import { mermaidRenderConfig, type MermaidTheme } from "./mermaidRuntime";

/** What the frame may load. Mermaid's script is the only request it can make. */
const ISOLATED_MERMAID_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

const LOAD_TIMEOUT_MS = 30_000;
/** Refusals are reported in a task after the load that caused them; this lets them arrive. */
const REPORT_SETTLE_MS = 50;
/** Stands in for an image Mermaid loads only to measure it; transparent, 1×1. */
const PLACEHOLDER_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type MermaidApi = typeof import("mermaid").default;

export interface IsolatedMermaidRender {
  readonly svg: string;
  /** The diagram type Mermaid drew (`error` for its own error diagram). */
  readonly diagramType: string;
  /** How many loads the frame refused while drawing it. */
  readonly refused: number;
}

export interface IsolatedMermaid {
  /** The front matter and `%%{init}%%` settings as Mermaid read them, or null when it does not parse. */
  readonly parse: (source: string) => Promise<{ readonly config: MermaidConfig } | null>;
  readonly render: (
    source: string,
    options?: {
      readonly theme?: MermaidTheme | undefined;
      /** Wait for late refusal reports; off when the caller strips the SVG itself. */
      readonly awaitRefusals?: boolean | undefined;
    },
  ) => Promise<IsolatedMermaidRender>;
  /** The frame's window, for tests of what it requested. */
  readonly window: Window;
  readonly close: () => void;
}

export interface IsolatedMermaidOptions {
  /** Prefix of Mermaid's render ids. */
  readonly idPrefix?: string | undefined;
  /**
   * Measure text as the page would: the page's own style rules (minus any that load a
   * resource) and its root and body attributes are mirrored before each render, so a diagram
   * drawn here lays out exactly as one drawn in the page.
   */
  readonly measureLikePage?: boolean | undefined;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Errors from the frame are not the page's `Error`; carry the message across. */
function asPageError(cause: unknown): Error {
  const message =
    typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message)
      : String(cause);
  return new Error(message);
}

/**
 * A rule's text without anything that would load a resource. Group rules (`@layer`,
 * `@media`, nested style rules) keep their safe children, so one font face or background
 * image does not take a whole layer with it.
 */
function safeRuleText(rule: CSSRule): string | null {
  const children = "cssRules" in rule ? (rule as CSSGroupingRule).cssRules : null;
  if (children === null || children.length === 0) {
    return fetchesInCss(rule.cssText) ? null : rule.cssText;
  }
  const inner = Array.from(children)
    .map(safeRuleText)
    .filter((text): text is string => text !== null);
  if (rule instanceof CSSStyleRule) {
    const own = rule.style.cssText;
    if (fetchesInCss(own)) return null;
    return `${rule.selectorText}{${own}${inner.join("")}}`;
  }
  const header = rule.cssText.slice(0, rule.cssText.indexOf("{"));
  return fetchesInCss(header) ? null : `${header}{${inner.join("\n")}}`;
}

/** The page's style rules that load nothing, as one stylesheet's text. */
function pageStyleText(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let sheetRules: CSSRuleList;
    try {
      sheetRules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(sheetRules)) {
      const text = safeRuleText(rule);
      if (text !== null) rules.push(text);
    }
  }
  return rules.join("\n");
}

function mirrorAttributes(source: Element, target: Element): void {
  for (const attribute of Array.from(target.attributes)) {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(source.attributes)) {
    // Inline styles on the root carry appearance variables; drop any that would load.
    if (attribute.name === "style" && fetchesInCss(attribute.value)) continue;
    target.setAttribute(attribute.name, attribute.value);
  }
}

/**
 * Loads made through `new Image()` (an image shape measuring its picture) get a local
 * stand-in, so the draw completes without its picture instead of failing on the refusal.
 */
function substituteMeasuredImages(frameWindow: Window, onBlocked: () => void) {
  const prototype = (frameWindow as Window & typeof globalThis).HTMLImageElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
  if (!descriptor?.set || !descriptor.get) return;
  const { get, set } = descriptor;
  Object.defineProperty(prototype, "src", {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get() {
      return get.call(this);
    },
    set(value: unknown) {
      const address = String(value);
      if (/^\s*(?:data|blob):/iu.test(address)) {
        set.call(this, address);
        return;
      }
      onBlocked();
      set.call(this, PLACEHOLDER_IMAGE);
    },
  });
}

export async function openIsolatedMermaid(
  options: IsolatedMermaidOptions = {},
): Promise<IsolatedMermaid> {
  const idPrefix = options.idPrefix ?? "scient-word-diagram";
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Laid out (Mermaid measures text) but off screen and never interactive.
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1600px;height:1200px;border:0;visibility:hidden;pointer-events:none";
  const scriptUrl = new URL(mermaidScriptUrl, document.baseURI).href;
  frame.srcdoc = [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${ISOLATED_MERMAID_POLICY}">`,
    `<script src="${escapeAttribute(scriptUrl)}"></script>`,
    "</head><body></body></html>",
  ].join("");
  const close = () => frame.remove();
  document.body.append(frame);

  try {
    const { mermaid, frameWindow } = await new Promise<{
      mermaid: MermaidApi;
      frameWindow: Window;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The diagram renderer did not load.")),
        LOAD_TIMEOUT_MS,
      );
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          const frameWindow = frame.contentWindow;
          const mermaid = (frameWindow as (Window & { mermaid?: MermaidApi }) | null)?.mermaid;
          if (frameWindow === null || mermaid === undefined) {
            reject(new Error("The diagram renderer did not load."));
            return;
          }
          resolve({ mermaid, frameWindow });
        },
        { once: true },
      );
    });

    const frameDocument = frameWindow.document;
    let refused = 0;
    const recordRefusal = () => {
      refused += 1;
    };
    frameDocument.addEventListener("securitypolicyviolation", recordRefusal);
    substituteMeasuredImages(frameWindow, recordRefusal);

    let pageStyle: HTMLStyleElement | null = null;
    const measureLikePage = () => {
      if (pageStyle === null) {
        pageStyle = frameDocument.createElement("style");
        pageStyle.textContent = pageStyleText();
        frameDocument.head.append(pageStyle);
      }
      mirrorAttributes(document.documentElement, frameDocument.documentElement);
      mirrorAttributes(document.body, frameDocument.body);
    };

    let initializedTheme: MermaidTheme | null = null;
    let sequence = 0;
    const settle = () =>
      new Promise<void>((resolve) => frameWindow.setTimeout(resolve, REPORT_SETTLE_MS));

    return {
      window: frameWindow,
      close,
      parse: async (source) => {
        try {
          const parsed = await mermaid.parse(source, { suppressErrors: true });
          return parsed === false ? null : { config: parsed.config };
        } catch {
          return null;
        }
      },
      render: async (source, renderOptions = {}) => {
        const theme = renderOptions.theme ?? "light";
        if (initializedTheme !== theme) {
          mermaid.initialize(mermaidRenderConfig(theme));
          initializedTheme = theme;
        }
        if (options.measureLikePage) measureLikePage();
        const before = refused;
        sequence += 1;
        try {
          const { svg, diagramType } = await mermaid.render(`${idPrefix}-${sequence}`, source);
          if (renderOptions.awaitRefusals ?? true) await settle();
          return { svg, diagramType, refused: refused - before };
        } catch (cause) {
          throw asPageError(cause);
        }
      },
    };
  } catch (cause) {
    close();
    throw cause;
  }
}

let sharedFrame: Promise<IsolatedMermaid> | null = null;

/**
 * The one frame every chat diagram draws in, opened on first use and kept for the session.
 * A frame that failed to open, or was removed from the page, is opened again next time.
 */
export function sharedIsolatedMermaid(): Promise<IsolatedMermaid> {
  const current = sharedFrame;
  if (current !== null) {
    return current.then((frame) =>
      frame.window.frameElement?.isConnected === true ? frame : reopenSharedFrame(current),
    );
  }
  return reopenSharedFrame(null);
}

function reopenSharedFrame(stale: Promise<IsolatedMermaid> | null): Promise<IsolatedMermaid> {
  if (sharedFrame !== stale && sharedFrame !== null) return sharedFrame;
  const opening = openIsolatedMermaid({ idPrefix: "scient-chat-diagram", measureLikePage: true });
  sharedFrame = opening;
  opening.catch(() => {
    if (sharedFrame === opening) sharedFrame = null;
  });
  return opening;
}
