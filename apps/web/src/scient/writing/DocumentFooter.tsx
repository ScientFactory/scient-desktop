import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { formatWordCount, type DocumentWordCount } from "./documentCounts";
import "./documentFooter.css";

/**
 * The strip under a document editor. It shows only what follows the caret:
 * on the left the options of the selected object (a table, an equation, a
 * heading), on the right where the caret is and the word count.
 *
 * It is always present and always the same height, so selecting something
 * never moves the document. Document commands, page and zoom controls, and
 * save or build state do not belong here.
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
