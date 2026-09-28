/**
 * A Mermaid renderer that cannot fetch anything, for Word export.
 *
 * Mermaid draws into a live document to measure text, and in strict mode it
 * still creates what a diagram asks for (an `<img>` in a label, a node's
 * image shape, a sequence actor's icon, CSS `url()`). Here it runs inside a
 * hidden frame whose Content Security Policy allows only Mermaid's own
 * script, inline styles, and `data:`/`blob:` images and fonts, so the browser
 * refuses every load a diagram names before any request is made. Each
 * refusal is counted so the caller can fall back instead of exporting a
 * diagram with holes in it.
 *
 * The frame loads Mermaid's self-contained build (fetched only when a Word
 * export has diagrams) and draws with the settings chat uses. It is
 * same-origin so Scient can call into it; nothing inside it runs Scient code.
 */
import type { MermaidConfig } from "mermaid";
import mermaidScriptUrl from "mermaid/dist/mermaid.min.js?url";

import { mermaidRenderConfig } from "../diagrams/mermaidRuntime";

/** What the frame may load. Mermaid's script is the only request it can make. */
const ISOLATED_MERMAID_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

const LOAD_TIMEOUT_MS = 30_000;
/** Refusals are reported in a task after the load that caused them; this lets them arrive. */
const REPORT_SETTLE_MS = 50;

type MermaidApi = typeof import("mermaid").default;

export interface IsolatedMermaid {
  /** The front matter and `%%{init}%%` settings as Mermaid read them, or null when it does not parse. */
  readonly parse: (source: string) => Promise<{ readonly config: MermaidConfig } | null>;
  /**
   * The SVG, the diagram type Mermaid drew (`error` for its own error
   * diagram), and how many loads the frame refused while drawing it.
   */
  readonly render: (source: string) => Promise<{
    readonly svg: string;
    readonly diagramType: string;
    readonly refused: number;
  }>;
  /** The frame's window, for tests of what it requested. */
  readonly window: Window;
  readonly close: () => void;
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

export async function openIsolatedMermaid(): Promise<IsolatedMermaid> {
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
        () => reject(new Error("Mermaid did not load for Word export.")),
        LOAD_TIMEOUT_MS,
      );
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          const frameWindow = frame.contentWindow;
          const mermaid = (frameWindow as (Window & { mermaid?: MermaidApi }) | null)?.mermaid;
          if (frameWindow === null || mermaid === undefined) {
            reject(new Error("Mermaid did not load for Word export."));
            return;
          }
          resolve({ mermaid, frameWindow });
        },
        { once: true },
      );
    });

    mermaid.initialize(mermaidRenderConfig("light"));
    let refused = 0;
    frameWindow.document.addEventListener("securitypolicyviolation", () => {
      refused += 1;
    });
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
      render: async (source) => {
        const before = refused;
        sequence += 1;
        try {
          const { svg, diagramType } = await mermaid.render(
            `scient-word-diagram-${sequence}`,
            source,
          );
          await settle();
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
