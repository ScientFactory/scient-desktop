import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { formatWordCount, type DocumentWordCount } from "./documentCounts";
import "./documentFooter.css";

/**
 * Keep footer height fixed so selection changes never move the document. Document commands, zoom,
 * and save/build state belong outside caret context.
 */
export function DocumentFooter(props: {
  /** Names the strip for assistive technology, for example "Document status". */
  readonly label: string;
  readonly className?: string | undefined;
  /** Format-specific items shown before the options, such as recovered work. */
  readonly leading?: ReactNode;
  /** The selected object's options. Empty for plain text. */
  readonly children?: ReactNode;
  /** Where the caret is, for example "Heading 2" or "Table · row 3, column 2". */
  readonly position: string | null;
  readonly words: DocumentWordCount | null;
  readonly dataRecovery?: boolean | undefined;
}) {
  return (
    <footer
      className={cn("scient-document-footer", props.className)}
      aria-label={props.label}
      data-recovery={props.dataRecovery ? "" : undefined}
    >
      {props.leading}
      <div className="scient-document-footer-options">{props.children}</div>
      <div className="scient-document-footer-status">
        {props.position ? (
          <span className="scient-document-footer-position">{props.position}</span>
        ) : null}
        {props.words ? (
          <span className="scient-document-footer-count">{formatWordCount(props.words)}</span>
        ) : null}
      </div>
    </footer>
  );
}
