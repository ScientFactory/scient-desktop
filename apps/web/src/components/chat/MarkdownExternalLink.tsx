import { GlobeIcon } from "lucide-react";
import { Children, Fragment, memo, type ReactNode } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { sourceControlIcon } from "../../sourceControlPresentation";

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

function sourceControlHostIcon(host: string): ReactNode {
  const definition = sourceControlClients.findByPublicDomain(host);
  if (definition === undefined) return null;
  const Icon = sourceControlIcon(definition);
  return <Icon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />;
}

// SCIENT-FORK:START — links use local marks, never a favicon request to another host.
// Forge hosts get the mark their source-control definition draws locally; every other
// host falls back to the globe instead of upstream's remote favicon <img>.
const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const brandIcon = sourceControlHostIcon(host);
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {brandIcon ?? <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />}
    </span>
  );
});
// SCIENT-FORK:END

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

// Long words such as URLs can break after any character so they fit narrow
// table columns. Short ones, like a PR number, stay whole.
function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text.matchAll(/\s+|\S+/g), ({ 0: word, index: start }) =>
    word.length <= 16
      ? word
      : Array.from(word, (character, offset) => (
          <Fragment key={`${start + offset}:${character}`}>
            {character}
            <wbr />
          </Fragment>
        )),
  );
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
