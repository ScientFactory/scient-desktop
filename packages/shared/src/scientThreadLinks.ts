import type { ScopedThreadRef } from "@t3tools/contracts";

import { formatHostedThreadLink, formatThreadLink, hostedThreadLink } from "./threadLinks.ts";

/**
 * The web origin Scient's shareable thread links open through. Scient hosts none yet, so copies stay
 * Scient's in-app links and outside MCP clients get the web app they reached. Once this names an
 * origin, Copy thread, chip copies and outside clients all get hosted links through it.
 */
export function scientHostedThreadOrigin(): string | undefined {
  return undefined;
}

/** A copied thread's plain text: the hosted link once Scient has an origin, else `inApp`. */
export function scientThreadCopyLink(
  ref: ScopedThreadRef,
  inApp: string,
  origin: string | undefined = scientHostedThreadOrigin(),
): string {
  return origin === undefined ? inApp : hostedThreadLink(ref, origin);
}

/** A thread chip's copied Markdown: a hosted link once Scient has an origin, else a thread link. */
export function scientThreadCopyMarkdown(
  ref: ScopedThreadRef,
  title: string,
  origin: string | undefined = scientHostedThreadOrigin(),
): string {
  return origin === undefined
    ? formatThreadLink(ref, title)
    : formatHostedThreadLink(ref, title, origin);
}
