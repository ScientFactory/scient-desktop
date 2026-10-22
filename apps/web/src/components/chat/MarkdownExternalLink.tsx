import { GlobeIcon } from "lucide-react";
import { Children, Fragment, memo, type ReactNode } from "react";

import { GitHubIcon } from "../Icons";

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

function isGitHubHost(host: string): boolean {
  const hostname = host.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

// SCIENT-FORK:START — links use local marks, never a favicon request to another host.
const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {/* Only the brand marks drawn here; any other brand falls back to the globe. */}
      {isGitHubHost(host) ? (
        <GitHubIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      )}
    </span>
  );
});
// SCIENT-FORK:END

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text, (character, index) => (
    <Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </Fragment>
  ));
}

export function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="whitespace-nowrap">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}
