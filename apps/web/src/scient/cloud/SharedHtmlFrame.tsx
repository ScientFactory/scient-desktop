import {
  contentFrameRenderMessage,
  contentFrameUrl,
  isContentFrameReady,
} from "@scientfactory/scient-cloud/content-frame";
import {
  clampHtmlRenderHeight,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import { useEffect, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

/**
 * A visual the agent made, shown from a shared or copied conversation. The HTML runs inside the
 * content shim on its own site with a sandboxed, opaque origin; it can size itself and ask to open
 * a web link while the reader is using it, nothing more.
 */
export function SharedHtmlFrame({
  title,
  html,
  contentOrigin,
}: {
  readonly title: string;
  readonly html: string;
  readonly contentOrigin?: string | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [src] = useState(() => contentFrameUrl(htmlRenderThemeFragment(theme), contentOrigin));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes to the iframe's window
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window message listener for the shim's ready signal, height reports and link requests
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      if (isContentFrameReady(event.data)) {
        // The sandboxed shim has an opaque origin, so the target must be "*".
        frame.contentWindow?.postMessage(
          contentFrameRenderMessage(injectHtmlRenderBootstrap(html)),
          "*",
        );
        return;
      }
      const reported = readHtmlRenderContentHeight(event.data);
      if (reported !== undefined) {
        setHeight(clampHtmlRenderHeight(reported));
        return;
      }
      const link = readHtmlRenderLinkRequest(event.data);
      if (
        link === undefined ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(link.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      sandbox="allow-scripts allow-popups"
      referrerPolicy="no-referrer"
      style={{ height }}
      className="block w-full rounded-lg border border-border"
    />
  );
}
