import { Download } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** What a document's editor can export, published to the file header. */
export interface DocumentDownloadActions {
  readonly pdf: () => void;
  readonly pdfDisabled: boolean;
  /** Why PDF is unavailable, shown as the item's tooltip. */
  readonly pdfUnavailableReason?: string | undefined;
  readonly word: () => void;
  readonly wordDisabled: boolean;
}

/**
 * The file header's download button for a document: the file itself, or the
 * document as PDF or Word.
 */
export function DocumentDownloadMenu(
  props: DocumentDownloadActions & {
    /** The file itself, for example "Markdown (.md)". */
    readonly sourceLabel: string;
    readonly onSaveCopy: () => void;
  },
) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  className="shrink-0"
                  aria-label="Download"
                  variant="ghost"
                  size="icon-sm"
                />
              }
            />
          }
        >
          <Download className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Download</TooltipPopup>
      </Tooltip>
      {/* As narrow as its three formats, with a little room after them. */}
      <MenuPopup align="end" className="w-max min-w-24">
        <MenuItem onClick={props.onSaveCopy}>{props.sourceLabel}</MenuItem>
        <MenuItem
          disabled={props.pdfDisabled}
          title={props.pdfDisabled ? props.pdfUnavailableReason : undefined}
          onClick={props.pdf}
        >
          PDF
        </MenuItem>
        <MenuItem disabled={props.wordDisabled} onClick={props.word}>
          Word (.docx)
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
