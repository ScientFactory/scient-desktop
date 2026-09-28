import { FilmIcon, ImageIcon } from "lucide-react";
import { createContext, useCallback, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { MiddleTruncate } from "~/components/ui/middle-truncate";

import type { RemoteImageAddress } from "./remoteImageAddress";
import { ScientTooltip } from "./ScientTooltip";

/** True under a web image the user chose to load, so the renderer draws it instead of the card. */
export const ScientRemoteImageLoadedContext = createContext(false);

/**
 * Whether this view may fetch `url`. Permission lasts while the card is mounted and is tied
 * to one address, so an edited source asks again. A per-site allowance or a stored copy of
 * the image would answer here before the card is ever shown.
 */
function useRemoteImagePermission(url: string) {
  const [allowedUrl, setAllowedUrl] = useState<string | null>(null);
  const allow = useCallback(() => setAllowedUrl(url), [url]);
  return { allowed: allowedUrl === url, allow };
}

/**
 * A web image shown as a referenced link: what it is, where it lives, and a button to fetch
 * it. Nothing is requested from the address until the user presses **Load image**; opening
 * the address hands it to the system browser like any chat link.
 *
 * `children` is the media exactly as chat would draw it; it mounts only once loaded.
 */
export function ScientRemoteImageReference(props: {
  readonly address: RemoteImageAddress;
  readonly alt: string;
  readonly kind: "image" | "video";
  /** The authored Markdown, so copying the message keeps the image syntax. */
  readonly copyMarkdown?: string | undefined;
  /** The sanitized authored id, so fragment links still land here. */
  readonly id?: string | undefined;
  readonly children: ReactNode;
}) {
  const { allowed, allow } = useRemoteImagePermission(props.address.url);
  const moveFocusToMedia = useRef(false);
  const focusLoadedMedia = useCallback((element: HTMLSpanElement | null) => {
    if (!element || !moveFocusToMedia.current) return;
    moveFocusToMedia.current = false;
    element.focus({ preventScroll: true });
  }, []);

  if (allowed) {
    // The button that had focus is gone; keep keyboard users where the image now is.
    return (
      <span ref={focusLoadedMedia} tabIndex={-1} className="outline-none">
        <ScientRemoteImageLoadedContext value>{props.children}</ScientRemoteImageLoadedContext>
      </span>
    );
  }

  const noun = props.kind === "video" ? "video" : "image";
  const name = props.alt.trim() || (props.kind === "video" ? "Video" : "Image");
  const Icon = props.kind === "video" ? FilmIcon : ImageIcon;
  return (
    <span
      id={props.id}
      role="group"
      aria-label={`Web ${noun}: ${name}`}
      data-markdown-copy={props.copyMarkdown}
      data-scient-remote-image=""
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/40 bg-muted/40 py-0.5 ps-2 pe-0.5 align-middle text-xs text-muted-foreground"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 max-w-48 shrink-[2] truncate text-foreground">{name}</span>
      <ScientTooltip
        content={
          <span dir="ltr" className="break-all">
            {props.address.url}
          </span>
        }
      >
        <a
          href={props.address.url}
          target="_blank"
          rel="noopener noreferrer"
          dir="ltr"
          aria-label={`Open ${props.address.label} in browser`}
          className="inline-flex min-w-0 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <MiddleTruncate value={props.address.label} showTitle={false} />
        </a>
      </ScientTooltip>
      <Button
        size="micro"
        variant="outline"
        aria-label={`Load ${noun} from ${props.address.host}`}
        onClick={() => {
          moveFocusToMedia.current = true;
          allow();
        }}
      >
        {`Load ${noun}`}
      </Button>
    </span>
  );
}
