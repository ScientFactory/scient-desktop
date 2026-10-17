import type { FileCitation } from "@t3tools/contracts";
import { Fragment, type ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Compact hover card for a file citation: the filename stands out, the directory
 * wraps at path separators onto a few short lines, and the cited range and
 * excerpt follow. Replaces the native `title`, which rendered deep absolute
 * paths as one unstyled line spanning the chat width.
 */
export function FileCitationHoverCard({
  citation,
  trigger,
}: {
  citation: FileCitation;
  trigger: ReactElement;
}) {
  const separatorIndex = Math.max(citation.path.lastIndexOf("/"), citation.path.lastIndexOf("\\"));
  const fileName = citation.path.slice(separatorIndex + 1);
  const directory = separatorIndex > 0 ? citation.path.slice(0, separatorIndex + 1) : "";
  // Offer a break after every separator so long paths wrap between segments.
  const directorySegments = directory.split(/(?<=[\\/])/);
  const excerpt = citation.text.replace(/\s+/g, " ").trim();
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top" className="max-w-72">
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5 text-left">
          <span className="font-medium text-foreground">{fileName || citation.path}</span>
          {directory ? (
            <span className="line-clamp-3 font-mono text-2xs text-muted-foreground">
              {directorySegments.map((segment, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- segments are positional and static
                <Fragment key={index}>
                  {segment}
                  <wbr />
                </Fragment>
              ))}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            Lines {citation.startLine}–{citation.endLine}
            {citation.origin === "draft" ? " · unsaved at capture" : ""}
          </span>
          {excerpt ? (
            <span className="mt-0.5 line-clamp-2 border-l-2 border-border pl-1.5 text-muted-foreground">
              {excerpt}
            </span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
