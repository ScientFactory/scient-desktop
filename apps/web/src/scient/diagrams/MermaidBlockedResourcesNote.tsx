import { ImageOffIcon } from "lucide-react";

import { MiddleTruncate } from "~/components/ui/middle-truncate";

import { remoteImageAddress } from "../presentation/remoteImageAddress";
import { ScientTooltip } from "../presentation/ScientTooltip";

/**
 * One line under a diagram naming what it asked to load and did not get. Web addresses
 * open in the system browser like chat links; anything else is shown as written.
 */
export function MermaidBlockedResourcesNote(props: { readonly addresses: ReadonlyArray<string> }) {
  return (
    <p
      role="note"
      aria-label="Outside content not loaded"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap px-3 pb-2 text-xs text-muted-foreground"
    >
      <ImageOffIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">Outside content not loaded:</span>
      {props.addresses.map((address, index) => {
        const remote = remoteImageAddress(address);
        const separator = index < props.addresses.length - 1 ? "," : null;
        return (
          <span key={address} className="inline-flex min-w-0 max-w-64 shrink" dir="ltr">
            {remote === null ? (
              <MiddleTruncate value={address} />
            ) : (
              <ScientTooltip
                content={
                  <span dir="ltr" className="break-all">
                    {remote.url}
                  </span>
                }
              >
                <a
                  href={remote.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${remote.label} in browser`}
                  className="inline-flex min-w-0 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <MiddleTruncate value={remote.label} showTitle={false} />
                </a>
              </ScientTooltip>
            )}
            {separator}
          </span>
        );
      })}
    </p>
  );
}
